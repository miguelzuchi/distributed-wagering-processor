import { defineEntity, p } from '@mikro-orm/core';

export const OutboxMessageEntity = defineEntity({
  name: 'OutboxMessage',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid().fieldName('aggregate_id'),
    eventType: p.string().length(100).fieldName('event_type'),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime().columnType('timestamptz').fieldName('occurred_at'),
    attempts: p.integer().default(0),
    nextAttemptAt: p
      .datetime()
      .columnType('timestamptz')
      .fieldName('next_attempt_at')
      .nullable(),
    claimToken: p.uuid().fieldName('claim_token').nullable(),
    claimUntil: p
      .datetime()
      .columnType('timestamptz')
      .fieldName('claim_until')
      .nullable(),
    publishedAt: p
      .datetime()
      .columnType('timestamptz')
      .fieldName('published_at')
      .nullable(),
  },
});
