import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvalidLedgerEntryError,
  InvalidMoneyError,
} from '../shared/domain.error.js';
import { Money } from '../shared/money.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';
import { Wallet } from './wallet.js';

const money = (amount: string, currency = 'BRL') =>
  Money.from({ amount, currency });

describe('Wallet', () => {
  it('opens at version one and increments only on a balance movement', () => {
    const wallet = Wallet.open({
      id: 'wallet',
      playerId: 'player',
      initialBalance: money('100.00'),
    });
    expect(wallet.version).toBe(1);
    wallet.debit(money('25.00'));
    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
  });

  it('never allows a negative balance', () => {
    const wallet = Wallet.open({
      id: 'wallet',
      playerId: 'player',
      initialBalance: money('10.00'),
    });
    expect(() => wallet.debit(money('10.01'))).toThrow(
      InsufficientBalanceError,
    );
    expect(wallet.balance.toJSON().amount).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  it('rejects zero, negative intermediates, and another currency', () => {
    const wallet = Wallet.open({
      id: 'wallet',
      playerId: 'player',
      initialBalance: money('10.00'),
    });
    expect(() => wallet.credit(money('0.00'))).toThrow(InvalidMoneyError);
    expect(() => wallet.credit(money('1.00', 'USD'))).toThrow(
      CurrencyMismatchError,
    );
  });
});

describe('WalletLedgerEntry', () => {
  it('accepts a balanced immutable entry', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry',
      walletId: 'wallet',
      transactionId: 'transaction',
      direction: LedgerDirection.Debit,
      money: money('25.00'),
      balanceBefore: money('100.00'),
      balanceAfter: money('75.00'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects an arithmetically invalid entry', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry',
        walletId: 'wallet',
        transactionId: 'transaction',
        direction: LedgerDirection.Credit,
        money: money('25.00'),
        balanceBefore: money('100.00'),
        balanceAfter: money('75.00'),
        createdAt: new Date(),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });
});
