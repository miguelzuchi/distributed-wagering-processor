import { defineEntity, p } from '@mikro-orm/core';

export const WalletLedgerEntryEntity = defineEntity({
  name: 'WalletLedgerEntry',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid().fieldName('wallet_id'),
    transactionId: p.uuid().fieldName('transaction_id'),
    direction: p.string().length(6),
    amount: p.decimal('string').precision(20).scale(2),
    currency: p.string().length(3),
    balanceBefore: p
      .decimal('string')
      .precision(20)
      .scale(2)
      .fieldName('balance_before'),
    balanceAfter: p
      .decimal('string')
      .precision(20)
      .scale(2)
      .fieldName('balance_after'),
    createdAt: p.datetime().columnType('timestamptz').fieldName('created_at'),
  },
  uniques: [
    { name: 'wallet_ledger_transaction_unique', properties: ['transactionId'] },
  ],
});
