import { Controller, Get, Header } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

interface MetricsSnapshot {
  transactions_total: string | number;
  transactions_pending_reference: string | number;
  transactions_rejected: string | number;
  outbox_pending: string | number;
  outbox_retrying: string | number;
  inbox_processed_total: string | number;
  inbox_rejected_total: string | number;
  idempotent_replays_total: string | number;
  outbox_lag_seconds: string | number;
  processing_latency_seconds: string | number;
  transactions_processed: string | number;
  transactions_failed: string | number;
  transactions_pending: string | number;
  sqs_retries_total: string | number;
  sqs_dlq_messages_total: string | number;
  lock_conflicts_total: string | number;
}

@Controller('metrics')
export class MetricsController {
  constructor(private readonly entityManager: EntityManager) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    const [snapshot] = await this.entityManager.fork().execute<
      MetricsSnapshot[]
    >(`select
      (select count(*) from wager_transactions) as transactions_total,
      (select count(*) from wager_transactions where status = 'PENDING_REFERENCE')
        as transactions_pending_reference,
      (select count(*) from wager_transactions where status = 'REJECTED')
        as transactions_rejected,
      (select count(*) from outbox_messages where published_at is null)
        as outbox_pending,
      (select count(*) from outbox_messages
        where published_at is null and attempts > 0) as outbox_retrying,
      (select count(*) from inbox_messages where status = 'PROCESSED')
        as inbox_processed_total,
      (select count(*) from inbox_messages where status = 'REJECTED')
        as inbox_rejected_total,
      coalesce((select value from operational_counters
        where name = 'idempotent_replays_total'), 0) as idempotent_replays_total,
      coalesce((select extract(epoch from now() - min(occurred_at))
        from outbox_messages where published_at is null), 0) as outbox_lag_seconds,
      coalesce((select avg(extract(epoch from processed_at - created_at))
        from wager_transactions where processed_at is not null), 0)
        as processing_latency_seconds,
      (select count(*) from wager_transactions where status = 'PROCESSED')
        as transactions_processed,
      (select count(*) from wager_transactions where status = 'FAILED')
        as transactions_failed,
      (select count(*) from wager_transactions where status = 'PENDING')
        as transactions_pending,
      coalesce((select value from operational_counters
        where name = 'sqs_retries_total'), 0) as sqs_retries_total,
      coalesce((select value from operational_counters
        where name = 'sqs_dlq_messages_total'), 0) as sqs_dlq_messages_total,
      coalesce((select value from operational_counters
        where name = 'lock_conflicts_total'), 0) as lock_conflicts_total`);

    const metrics: Array<[string, string, number]> = [
      [
        'wagering_transactions_total',
        'Transactions received and persisted.',
        Number(snapshot?.transactions_total ?? 0),
      ],
      [
        'wagering_transactions_processed',
        'Transactions in PROCESSED status.',
        Number(snapshot?.transactions_processed ?? 0),
      ],
      [
        'wagering_transactions_failed',
        'Transactions in FAILED status.',
        Number(snapshot?.transactions_failed ?? 0),
      ],
      [
        'wagering_transactions_pending',
        'Transactions in PENDING status.',
        Number(snapshot?.transactions_pending ?? 0),
      ],
      [
        'wagering_transactions_pending_reference',
        'Transactions waiting for their referenced transaction.',
        Number(snapshot?.transactions_pending_reference ?? 0),
      ],
      [
        'wagering_transactions_rejected_total',
        'Transactions rejected by a business rule.',
        Number(snapshot?.transactions_rejected ?? 0),
      ],
      [
        'wagering_outbox_pending',
        'Outbox messages not published yet.',
        Number(snapshot?.outbox_pending ?? 0),
      ],
      [
        'wagering_outbox_retrying',
        'Outbox messages waiting after a failed publish attempt.',
        Number(snapshot?.outbox_retrying ?? 0),
      ],
      [
        'wagering_idempotent_replays_total',
        'Idempotent duplicate submissions detected.',
        Number(snapshot?.idempotent_replays_total ?? 0),
      ],
      [
        'wagering_outbox_lag_seconds',
        'Age in seconds of the oldest unpublished outbox message.',
        Number(snapshot?.outbox_lag_seconds ?? 0),
      ],
      [
        'wagering_processing_latency_seconds',
        'Average persisted transaction processing latency in seconds.',
        Number(snapshot?.processing_latency_seconds ?? 0),
      ],
      [
        'wagering_inbox_processed_total',
        'SQS messages processed successfully.',
        Number(snapshot?.inbox_processed_total ?? 0),
      ],
      [
        'wagering_inbox_rejected_total',
        'SQS messages rejected permanently.',
        Number(snapshot?.inbox_rejected_total ?? 0),
      ],
      [
        'wagering_sqs_retries_total',
        'SQS message processing retries scheduled.',
        Number(snapshot?.sqs_retries_total ?? 0),
      ],
      [
        'wagering_sqs_dlq_messages_total',
        'SQS messages sent or redriven to the DLQ.',
        Number(snapshot?.sqs_dlq_messages_total ?? 0),
      ],
      [
        'wagering_lock_conflicts_total',
        'PostgreSQL deadlock or serialization conflicts retried.',
        Number(snapshot?.lock_conflicts_total ?? 0),
      ],
    ];

    return `${metrics
      .flatMap(([name, help, value]) => [
        `# HELP ${name} ${help}`,
        `# TYPE ${name} ${name.endsWith('_total') ? 'counter' : 'gauge'}`,
        `${name} ${value}`,
      ])
      .join('\n')}\n`;
  }
}
