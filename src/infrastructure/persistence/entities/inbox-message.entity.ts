import { defineEntity, p } from '@mikro-orm/core';

export const InboxMessageEntity = defineEntity({
  name: 'InboxMessage',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.string().length(100).fieldName('consumer_name').primary(),
    messageId: p.string().length(200).fieldName('message_id').primary(),
    payloadHash: p.string().length(64).fieldName('payload_hash'),
    receivedAt: p.datetime().columnType('timestamptz').fieldName('received_at'),
    processedAt: p
      .datetime()
      .columnType('timestamptz')
      .fieldName('processed_at')
      .nullable(),
  },
});
