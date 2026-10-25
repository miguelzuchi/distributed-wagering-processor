import { Module } from '@nestjs/common';
import { WageringModule } from '../wagering/wagering.module.js';
import { SqsWagerConsumer } from './sqs-wager-consumer.js';

@Module({
  imports: [WageringModule],
  providers: [SqsWagerConsumer],
})
export class MessagingModule {}
