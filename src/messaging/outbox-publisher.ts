import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { loadEnvironment } from '../config/environment.js';

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
      published = await this.entityManager.fork().transactional(async (em) => {
        const rows = await em.execute<OutboxRow[]>(
          `select id, aggregate_id, payload, attempts
             from outbox_messages
            where published_at is null
              and coalesce(next_attempt_at, occurred_at) <= now()
            order by occurred_at
            for update skip locked
            limit 25`,
        );
        let count = 0;
        for (const row of rows) {
          try {
            await this.sqs.send(
              new SendMessageCommand({
                QueueUrl: this.environment.sqs.eventsQueueUrl,
                MessageBody: JSON.stringify(row.payload),
                MessageGroupId: row.aggregate_id,
                MessageDeduplicationId: row.id,
              }),
            );
            await em.execute(
              `update outbox_messages set published_at = ?, next_attempt_at = null
                where id = ?`,
              [new Date(), row.id],
            );
            count += 1;
          } catch (error) {
            const attempts = row.attempts + 1;
            const delay = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));
            await em.execute(
              `update outbox_messages
                  set attempts = ?, next_attempt_at = ? where id = ?`,
              [attempts, new Date(Date.now() + delay), row.id],
            );
            this.logger.warn({
              event: 'outbox_publish_failed',
              eventId: row.id,
              attempts,
              error: error instanceof Error ? error.name : 'UnknownError',
            });
          }
        }
        return count;
      });
    } catch (error) {
      this.logger.warn({
        event: 'outbox_batch_failed',
        error: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    this.schedule(published > 0 ? 0 : 500);
  }
}
