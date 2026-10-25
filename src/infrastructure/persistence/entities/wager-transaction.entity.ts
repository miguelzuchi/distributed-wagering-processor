import { defineEntity, p } from '@mikro-orm/core';

export const WagerTransactionEntity = defineEntity({
  name: 'WagerTransaction',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.string().length(100).fieldName('provider_id'),
    externalTransactionId: p
      .string()
      .length(200)
      .fieldName('external_transaction_id'),
    idempotencyKey: p.string().length(300).fieldName('idempotency_key'),
    payloadHash: p.string().length(64).fieldName('payload_hash'),
    walletId: p.uuid().fieldName('wallet_id'),
    playerId: p.uuid().fieldName('player_id'),
    roundId: p.string().length(200).fieldName('round_id'),
    gameId: p.string().length(200).fieldName('game_id'),
    kind: p.string().length(16),
    amount: p.decimal('string').precision(20).scale(2),
    currency: p.string().length(3),
    referenceExternalTransactionId: p
      .string()
      .length(200)
      .fieldName('reference_external_transaction_id')
      .nullable(),
    referenceTransactionId: p
      .uuid()
      .fieldName('reference_transaction_id')
      .nullable(),
    status: p.string().length(24),
    failureCode: p.string().length(64).fieldName('failure_code').nullable(),
    resultBalance: p
      .decimal('string')
      .precision(20)
      .scale(2)
      .fieldName('result_balance')
      .nullable(),
    referenceAttempts: p.integer().fieldName('reference_attempts').default(0),
    referenceNextAttemptAt: p
      .datetime()
      .columnType('timestamptz')
      .fieldName('reference_next_attempt_at')
      .nullable(),
    createdAt: p.datetime().columnType('timestamptz').fieldName('created_at'),
    processedAt: p
      .datetime()
      .columnType('timestamptz')
      .fieldName('processed_at')
      .nullable(),
  },
  uniques: [
    {
      name: 'wager_transactions_idempotency_unique',
      properties: ['idempotencyKey'],
    },
    {
      name: 'wager_transactions_provider_external_unique',
      properties: ['providerId', 'externalTransactionId'],
    },
  ],
});
