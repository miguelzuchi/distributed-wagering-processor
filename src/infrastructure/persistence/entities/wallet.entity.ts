import { defineEntity, p } from '@mikro-orm/core';

export const WalletEntity = defineEntity({
  name: 'Wallet',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid().fieldName('player_id'),
    currency: p.string().length(3),
    balance: p.decimal('string').precision(20).scale(2),
    version: p.integer(),
    createdAt: p.datetime().columnType('timestamptz').fieldName('created_at'),
    updatedAt: p.datetime().columnType('timestamptz').fieldName('updated_at'),
  },
  uniques: [
    {
      name: 'wallets_player_currency_unique',
      properties: ['playerId', 'currency'],
    },
  ],
});
