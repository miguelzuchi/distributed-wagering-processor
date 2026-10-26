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
        as inbox_rejected_total`);

    const metrics: Array<[string, string, number]> = [
      [
        'wagering_transactions_total',
        'Transactions received and persisted.',
        Number(snapshot?.transactions_total ?? 0),
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
        'wagering_inbox_processed_total',
        'SQS messages processed successfully.',
        Number(snapshot?.inbox_processed_total ?? 0),
      ],
      [
        'wagering_inbox_rejected_total',
        'SQS messages rejected permanently.',
        Number(snapshot?.inbox_rejected_total ?? 0),
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
