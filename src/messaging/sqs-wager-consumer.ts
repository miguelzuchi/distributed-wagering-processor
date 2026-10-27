import { createHash } from 'node:crypto';
import {
  HttpException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EntityManager } from '@mikro-orm/postgresql';
import { canonicalJson } from '../application/canonical-json.js';
import { loadEnvironment } from '../config/environment.js';
import { SubmitWagerTransactionDto } from '../wagering/dto/submit-wager-transaction.dto.js';
import { InboxContext, WageringService } from '../wagering/wagering.service.js';
import {
  SQS_MAX_RECEIVE_COUNT,
  sqsRetryVisibilitySeconds,
} from './sqs-retry-policy.js';

interface WagerEnvelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: SubmitWagerTransactionDto & { idempotencyKey: string };
}

class PermanentMessageError extends Error {}

@Injectable()
export class SqsWagerConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private readonly environment = loadEnvironment();
  private readonly sqs = new SQSClient({
    region: this.environment.sqs.region,
    endpoint: this.environment.sqs.endpoint,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly wagering: WageringService,
    private readonly entityManager: EntityManager,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const deadline = new Promise<void>((resolve) =>
      setTimeout(resolve, 10_000).unref(),
    );
    await Promise.race([
      Promise.allSettled(this.inFlight.values()).then(() => undefined),
      deadline,
    ]);
    if (this.inFlight.size > 0) {
      await Promise.allSettled(
        [...this.inFlight.keys()].map((receiptHandle) =>
          this.sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.environment.sqs.wagerQueueUrl,
              ReceiptHandle: receiptHandle,
              VisibilityTimeout: 0,
            }),
          ),
        ),
      );
    }
    this.sqs.destroy();
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.poll(), delay);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    try {
      const result = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.environment.sqs.wagerQueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          VisibilityTimeout: this.environment.nodeEnv === 'test' ? 1 : 30,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      );
      await Promise.all(
        (result.Messages ?? []).map((message) => this.track(message)),
      );
      this.schedule(0);
    } catch (error) {
      this.logger.warn({
        event: 'sqs_poll_failed',
        error: this.errorName(error),
      });
      this.schedule(1_000);
    }
  }

  private track(message: Message): Promise<void> {
    if (!message.ReceiptHandle) return Promise.resolve();
    const receiptHandle = message.ReceiptHandle;
    const operation = this.handle(message).finally(() => {
      this.inFlight.delete(receiptHandle);
    });
    this.inFlight.set(receiptHandle, operation);
    return operation;
  }

  private async handle(message: Message): Promise<void> {
    if (!message.Body || !message.ReceiptHandle) return;
    let inbox: InboxContext | undefined;
    try {
      let envelope: WagerEnvelope;
      try {
        envelope = JSON.parse(message.Body) as WagerEnvelope;
      } catch {
        throw new PermanentMessageError('Message body is not valid JSON');
      }
      if (
        envelope.type !== 'WagerTransactionRequested' ||
        !envelope.messageId ||
        !envelope.data?.idempotencyKey
      ) {
        throw new PermanentMessageError('Invalid message envelope');
      }
      const input = plainToInstance(SubmitWagerTransactionDto, envelope.data);
      const validation = await validate(input, {
        whitelist: true,
        forbidNonWhitelisted: false,
      });
      if (validation.length > 0) {
        throw new PermanentMessageError('Invalid transaction payload');
      }

      const payloadHash = createHash('sha256')
        .update(canonicalJson(envelope))
        .digest('hex');
      inbox = {
        consumerName: 'wager-transaction-consumer-v1',
        messageId: envelope.messageId,
        payloadHash,
        receivedAt: new Date(),
      };
      await this.wagering.submit(input, envelope.data.idempotencyKey, inbox);
      await this.ack(message.ReceiptHandle);
    } catch (error) {
      if (error instanceof PermanentMessageError) {
        try {
          await this.moveToDlq(message);
          await this.incrementCounter('sqs_dlq_messages_total');
          await this.ack(message.ReceiptHandle);
        } catch (dlqError) {
          this.logger.warn({
            event: 'sqs_dlq_publish_failed',
            messageId: message.MessageId,
            error: this.errorName(dlqError),
          });
        }
        return;
      }
      if (error instanceof HttpException && error.getStatus() < 500) {
        try {
          if (inbox) {
            await this.wagering.recordInboxRejection(
              inbox,
              `HTTP_${error.getStatus()}_${error.name}`,
            );
          }
          await this.ack(message.ReceiptHandle);
        } catch (recordError) {
          this.logger.warn({
            event: 'sqs_terminal_failure_record_failed',
            messageId: message.MessageId,
            error: this.errorName(recordError),
          });
        }
        return;
      }
      this.logger.warn({
        event: 'sqs_message_failed',
        messageId: message.MessageId,
        receiveCount: message.Attributes?.ApproximateReceiveCount,
        error: this.errorName(error),
      });
      await this.scheduleRetry(message);
    }
  }

  private async scheduleRetry(message: Message): Promise<void> {
    if (!message.ReceiptHandle) return;

    const receiveCount = Number.parseInt(
      message.Attributes?.ApproximateReceiveCount ?? '1',
      10,
    );
    const visibilityTimeout = sqsRetryVisibilitySeconds(
      Number.isFinite(receiveCount) ? receiveCount : 1,
      this.environment.nodeEnv === 'test',
    );
    await this.incrementCounter('sqs_retries_total');
    if (receiveCount >= SQS_MAX_RECEIVE_COUNT) {
      await this.incrementCounter('sqs_dlq_messages_total');
    }
    const abortController = new AbortController();
    const requestTimeout = setTimeout(
      () => abortController.abort(),
      this.environment.nodeEnv === 'test' ? 500 : 5_000,
    );
    requestTimeout.unref();

    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.environment.sqs.wagerQueueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: visibilityTimeout,
        }),
        { abortSignal: abortController.signal },
      );
    } catch (error) {
      this.logger.warn({
        event: 'sqs_retry_schedule_failed',
        messageId: message.MessageId,
        receiveCount,
        error: this.errorName(error),
      });
      // The original visibility timeout remains the safe fallback.
    } finally {
      clearTimeout(requestTimeout);
    }
  }

  private async ack(receiptHandle: string): Promise<void> {
    const testDelay =
      this.environment.nodeEnv === 'test'
        ? Number.parseInt(process.env.SQS_ACK_DELAY_MS ?? '0', 10)
        : 0;
    if (Number.isFinite(testDelay) && testDelay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, testDelay));
    }
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.environment.sqs.wagerQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  private async moveToDlq(message: Message): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.environment.sqs.wagerDlqUrl,
        MessageBody: message.Body!,
        MessageGroupId: message.MessageId!,
        MessageDeduplicationId: message.MessageId!,
      }),
    );
  }

  private errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
  }

  private async incrementCounter(name: string): Promise<void> {
    try {
      await this.entityManager.fork().execute(
        `insert into operational_counters (name, value) values (?, 1)
         on conflict (name) do update
           set value = operational_counters.value + 1`,
        [name],
      );
    } catch (error) {
      this.logger.warn({
        event: 'operational_counter_increment_failed',
        counter: name,
        error: this.errorName(error),
      });
    }
  }
}
