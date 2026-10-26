import { createHash } from 'node:crypto';
import {
  HttpException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { canonicalJson } from '../application/canonical-json.js';
import { loadEnvironment } from '../config/environment.js';
import { SubmitWagerTransactionDto } from '../wagering/dto/submit-wager-transaction.dto.js';
import { InboxContext, WageringService } from '../wagering/wagering.service.js';

interface WagerEnvelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: SubmitWagerTransactionDto & { idempotencyKey: string };
}

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

  constructor(private readonly wagering: WageringService) {}

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
          VisibilityTimeout: 30,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      );
      await Promise.all(
        (result.Messages ?? []).map((message) => this.handle(message)),
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

  private async handle(message: Message): Promise<void> {
    if (!message.Body || !message.ReceiptHandle) return;
    let inbox: InboxContext | undefined;
    try {
      const envelope = JSON.parse(message.Body) as WagerEnvelope;
      if (
        envelope.type !== 'WagerTransactionRequested' ||
        !envelope.messageId ||
        !envelope.data?.idempotencyKey
      ) {
        throw new Error('Invalid message envelope');
      }
      const input = plainToInstance(SubmitWagerTransactionDto, envelope.data);
      const validation = await validate(input, {
        whitelist: true,
        forbidNonWhitelisted: false,
      });
      if (validation.length > 0) throw new Error('Invalid transaction payload');

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
      // No ACK: SQS restores visibility and applies its redrive policy.
    }
  }

  private async ack(receiptHandle: string): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.environment.sqs.wagerQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  private errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
  }
}
