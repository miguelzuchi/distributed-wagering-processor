import { randomUUID } from 'node:crypto';
import { MoneyProps } from '../shared/money.js';
import { LedgerDirection } from '../wallet/wallet-ledger-entry.js';
import { EventContext, IntegrationEvent } from './integration-event.js';

interface WalletBalanceChangedData extends Record<string, unknown> {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static create(
    data: WalletBalanceChangedData,
    ctx: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: randomUUID(),
      aggregateId: data.walletId,
      ...ctx,
      data,
    });
  }
}

interface WagerTransactionProcessedData extends Record<string, unknown> {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  money: MoneyProps;
  resultBalance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static create(
    data: WagerTransactionProcessedData,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: randomUUID(),
      aggregateId: data.transactionId,
      ...ctx,
      data,
    });
  }
}
