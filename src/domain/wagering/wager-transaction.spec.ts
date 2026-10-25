import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../shared/domain.error.js';
import { Money } from '../shared/money.js';
import { LedgerDirection } from '../wallet/wallet-ledger-entry.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';

function transaction(
  kind: WagerTransactionKind,
  referenceExternalTransactionId?: string,
): WagerTransaction {
  return WagerTransaction.create({
    id: `id-${kind}`,
    providerId: 'provider-a',
    externalTransactionId: `external-${kind}`,
    idempotencyKey: `provider-a:external-${kind}`,
    payloadHash: 'hash',
    walletId: 'wallet',
    playerId: 'player',
    roundId: 'round',
    gameId: 'game',
    kind,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    referenceExternalTransactionId,
  });
}

describe('WagerTransaction', () => {
  it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    'requires a reference for %s',
    (kind) => {
      expect(() => transaction(kind)).toThrow(InvalidWagerTransactionError);
    },
  );

  it('records an out-of-order reference without becoming terminal', () => {
    const refund = transaction(WagerTransactionKind.Refund, 'missing-bet');
    refund.markPendingReference();
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.isTerminal()).toBe(false);
  });

  it.each([
    WagerTransactionKind.Opening,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ])('%s produces a credit', (kind) => {
    expect(
      transaction(
        kind,
        kind === WagerTransactionKind.Refund ? 'bet' : undefined,
      ).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  it('inverts the reference direction for rollback', () => {
    const rollback = transaction(WagerTransactionKind.Rollback, 'win');
    const win = transaction(WagerTransactionKind.Win);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  it('does not give LOSS a ledger effect', () => {
    const loss = transaction(WagerTransactionKind.Loss);
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
  });

  it.each([
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ])('does not allow a terminal state %s to transition', (terminalStatus) => {
    const bet = transaction(WagerTransactionKind.Bet);
    if (terminalStatus === WagerTransactionStatus.Processed) {
      bet.markProcessed(undefined, new Date());
    } else if (terminalStatus === WagerTransactionStatus.Rejected) {
      bet.reject(FailureCode.InsufficientBalance);
    } else {
      bet.fail(FailureCode.PermanentInfrastructureFailure);
    }
    expect(() => bet.reject(FailureCode.InsufficientBalance)).toThrow(
      InvalidTransactionStateError,
    );
  });

  it('detects idempotency payload divergence', () => {
    const bet = transaction(WagerTransactionKind.Bet);
    expect(bet.matchesPayload('hash')).toBe(true);
    expect(bet.matchesPayload('other-hash')).toBe(false);
  });
});
