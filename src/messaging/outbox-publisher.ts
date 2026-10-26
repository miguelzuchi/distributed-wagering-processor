import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { loadEnvironment } from '../config/environment.js';
import { randomUUID } from 'node:crypto';
import {
  OUTBOX_BATCH_SIZE,
  OUTBOX_CLAIM_SECONDS,
  outboxRetryDelayMs,
} from './outbox-policy.js';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

@Injectable()
export class OutboxPublisher
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly environment = loadEnvironment();
  private readonly sqs = new SQSClient({
    region: this.environment.sqs.region,
    endpoint: this.environment.sqs.endpoint,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly entityManager: EntityManager) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.sqs.destroy();
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.publishBatch(), delay);
    this.timer.unref();
  }

  private async publishBatch(): Promise<void> {
    let published = 0;
    try {
      const claimToken = randomUUID();
      const rows = await this.claimBatch(claimToken);
      const results = await Promise.all(
        rows.map((row) => this.publishClaimed(row, claimToken)),
      );
      published = results.filter(Boolean).length;
    } catch (error) {
      this.logger.warn({
        event: 'outbox_batch_failed',
        error: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    this.schedule(published > 0 ? 0 : 500);
  }

  private claimBatch(claimToken: string): Promise<OutboxRow[]> {
    return this.entityManager.fork().transactional((em) =>
      em.execute<OutboxRow[]>(
        `with candidates as (
           select id from outbox_messages
            where published_at is null
              and coalesce(next_attempt_at, occurred_at) <= now()
              and (claim_until is null or claim_until <= now())
            order by occurred_at
            for update skip locked
            limit ?
         )
         update outbox_messages as message
            set claim_token = ?,
                claim_until = now() + (? * interval '1 second')
           from candidates
          where message.id = candidates.id
         returning message.id, message.aggregate_id, message.payload,
                   message.attempts`,
        [OUTBOX_BATCH_SIZE, claimToken, OUTBOX_CLAIM_SECONDS],
      ),
    );
  }

  private async publishClaimed(
    row: OutboxRow,
    claimToken: string,
  ): Promise<boolean> {
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.environment.sqs.eventsQueueUrl,
          MessageBody: JSON.stringify(row.payload),
          MessageGroupId: row.aggregate_id,
          MessageDeduplicationId: row.id,
        }),
      );
      await this.entityManager.fork().execute(
        `update outbox_messages
            set published_at = ?, next_attempt_at = null,
                claim_token = null, claim_until = null
          where id = ? and claim_token = ?`,
        [new Date(), row.id, claimToken],
      );
      return true;
    } catch (error) {
      const attempts = row.attempts + 1;
      const delay = outboxRetryDelayMs(attempts);
      await this.entityManager.fork().execute(
        `update outbox_messages
            set attempts = ?, next_attempt_at = ?,
                claim_token = null, claim_until = null
          where id = ? and claim_token = ?`,
        [attempts, new Date(Date.now() + delay), row.id, claimToken],
      );
      this.logger.warn({
        event: 'outbox_publish_failed',
        eventId: row.id,
        attempts,
        error: error instanceof Error ? error.name : 'UnknownError',
      });
      return false;
    }
  }
}
