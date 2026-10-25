import { Module } from '@nestjs/common';
import { WageringModule } from '../wagering/wagering.module.js';
import { SqsWagerConsumer } from './sqs-wager-consumer.js';
import { OutboxPublisher } from './outbox-publisher.js';

@Module({
  imports: [WageringModule],
  providers: [SqsWagerConsumer, OutboxPublisher],
})
export class MessagingModule {}
