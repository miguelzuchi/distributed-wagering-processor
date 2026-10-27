import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { canonicalJson } from '../application/canonical-json.js';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wallet-events.js';
import { Money } from '../domain/shared/money.js';
import { InsufficientBalanceError } from '../domain/shared/domain.error.js';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wagering/wager-transaction.js';
import { LedgerDirection } from '../domain/wallet/wallet-ledger-entry.js';
import { Wallet } from '../domain/wallet/wallet.js';
import { withPostgresTransactionRetry } from '../infrastructure/persistence/postgres-retry.js';
import { SubmitWagerTransactionDto } from './dto/submit-wager-transaction.dto.js';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  status: WagerTransactionStatus;
  failure_code?: FailureCode;
  result_balance?: string;
  result_balance_currency?: string;
  reference_transaction_id?: string;
}

interface PendingRow extends TransactionRow {
  idempotency_key: string;
  game_id: string;
  reference_external_transaction_id: string;
  reference_attempts: number;
}

export interface WagerTransactionResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: { amount: string; currency: string };
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export interface InboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
}

@Injectable()
export class WageringService {
  constructor(private readonly entityManager: EntityManager) {}

  async submit(
    input: SubmitWagerTransactionDto,
    idempotencyKey: string,
    inbox?: InboxContext,
  ): Promise<WagerTransactionResponse> {
    if (input.kind === WagerTransactionKind.Opening) {
      throw new BadRequestException('OPENING is an internal transaction');
    }
    const money = Money.from(input.money);
    if (!money.isPositive()) {
      throw new BadRequestException('Transaction amount must be positive');
    }
    if (
      (input.kind === WagerTransactionKind.Refund ||
        input.kind === WagerTransactionKind.Rollback) &&
      !input.referenceExternalTransactionId
    ) {
      throw new BadRequestException(
        `${input.kind} requires referenceExternalTransactionId`,
      );
    }

    const payloadHash = createHash('sha256')
      .update(canonicalJson(input))
      .digest('hex');

    return this.transactionalWithRetry(async (em) => {
      // Serializes only equal idempotency keys, including requests targeting
      // different wallets. It is not a global financial lock.
      await em.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
        idempotencyKey,
      ]);

      let shouldCompleteInbox = false;
      if (inbox) {
        const existingInbox = await em.execute<{
          payload_hash: string;
          processed_at?: string;
        }>(
          `select payload_hash, processed_at
             from inbox_messages
            where consumer_name = ? and message_id = ?`,
          [inbox.consumerName, inbox.messageId],
          'get',
        );
        if (existingInbox) {
          if (existingInbox.payload_hash !== inbox.payloadHash) {
            throw new ConflictException(
              'Inbox message ID was reused with a different payload',
            );
          }
        } else {
          await em.execute(
            `insert into inbox_messages
              (consumer_name, message_id, payload_hash, received_at)
             values (?, ?, ?, ?)`,
            [
              inbox.consumerName,
              inbox.messageId,
              inbox.payloadHash,
              inbox.receivedAt,
            ],
          );
        }
        shouldCompleteInbox = !existingInbox?.processed_at;
      }
      const complete = async (
        result: WagerTransactionResponse,
      ): Promise<WagerTransactionResponse> => {
        if (inbox && shouldCompleteInbox) {
          await em.execute(
            `update inbox_messages
                set processed_at = ?, status = 'PROCESSED'
              where consumer_name = ? and message_id = ?`,
            [new Date(), inbox.consumerName, inbox.messageId],
          );
        }
        return result;
      };

      const replay = await this.findByIdempotencyKey(em, idempotencyKey);
      if (replay) {
        if (replay.payload_hash !== payloadHash) {
          throw new ConflictException(
            'Idempotency key was already used with a different payload',
          );
        }
        await this.incrementCounter(em, 'idempotent_replays_total');
        return complete(this.toResponse(replay, true));
      }

      const walletRow = await em.execute<WalletRow>(
        `select id, player_id, currency, balance::text, version,
                created_at, updated_at
           from wallets where id = ? for update`,
        [input.walletId],
        'get',
      );
      if (!walletRow) {
        throw new NotFoundException('Wallet not found');
      }
      if (walletRow.player_id !== input.playerId) {
        throw new BadRequestException('Wallet does not belong to player');
      }

      const wallet = Wallet.rehydrate({
        id: walletRow.id,
        playerId: walletRow.player_id,
        currency: walletRow.currency,
        balance: Money.from({
          amount: walletRow.balance,
          currency: walletRow.currency,
        }),
        version: walletRow.version,
        createdAt: walletRow.created_at,
        updatedAt: walletRow.updated_at,
      });
      if (wallet.currency !== money.currency) {
        return complete(
          await this.persistRejected(
            em,
            input,
            idempotencyKey,
            payloadHash,
            wallet,
            money,
            FailureCode.CurrencyMismatch,
          ),
        );
      }

      const transactionId = randomUUID();
      const now = new Date();
      await this.insertPending(
        em,
        transactionId,
        input,
        idempotencyKey,
        payloadHash,
        money,
        now,
      );

      if (input.kind === WagerTransactionKind.Loss) {
        await this.markProcessed(
          em,
          transactionId,
          wallet.balance.toJSON().amount,
          wallet.currency,
          undefined,
          now,
        );
        await this.enqueueProcessed(
          em,
          transactionId,
          input,
          money,
          wallet.balance,
          now,
        );
        return complete(
          this.response(
            transactionId,
            WagerTransactionStatus.Processed,
            wallet.balance,
          ),
        );
      }

      let direction: LedgerDirection;
      let reference: TransactionRow | undefined;
      if (
        input.kind === WagerTransactionKind.Refund ||
        input.kind === WagerTransactionKind.Rollback
      ) {
        reference = await this.findReference(em, input);
        if (!reference) {
          await em.execute(
            `update wager_transactions
                set status = 'PENDING_REFERENCE', reference_attempts = 1,
                    reference_next_attempt_at = ?, result_balance = ?,
                    result_balance_currency = ?
              where id = ?`,
            [
              new Date(now.getTime() + 1_000),
              wallet.balance.toJSON().amount,
              wallet.currency,
              transactionId,
            ],
          );
          const event = WagerTransactionPendingReference.create(
            {
              transactionId,
              walletId: input.walletId,
              providerId: input.providerId,
              externalTransactionId: input.externalTransactionId,
              referenceExternalTransactionId:
                input.referenceExternalTransactionId!,
            },
            { correlationId: idempotencyKey, occurredAt: now },
          );
          await this.enqueue(em, event);
          return complete(
            this.response(
              transactionId,
              WagerTransactionStatus.PendingReference,
              wallet.balance,
            ),
          );
        }

        const failure = await this.validateReference(
          em,
          input,
          money,
          reference,
        );
        if (failure) {
          return complete(
            await this.rejectExisting(
              em,
              transactionId,
              input,
              wallet,
              failure,
              now,
            ),
          );
        }
        direction =
          input.kind === WagerTransactionKind.Refund ||
          reference.kind === WagerTransactionKind.Bet
            ? LedgerDirection.Credit
            : LedgerDirection.Debit;
      } else {
        direction =
          input.kind === WagerTransactionKind.Bet
            ? LedgerDirection.Debit
            : LedgerDirection.Credit;
      }

      const balanceBefore = wallet.balance;
      try {
        if (direction === LedgerDirection.Debit) {
          wallet.debit(money, now);
        } else {
          wallet.credit(money, now);
        }
      } catch (error) {
        if (!(error instanceof InsufficientBalanceError)) throw error;
        const failure =
          input.kind === WagerTransactionKind.Bet
            ? FailureCode.InsufficientBalance
            : FailureCode.ReversalWouldMakeBalanceNegative;
        return complete(
          await this.rejectExisting(
            em,
            transactionId,
            input,
            wallet,
            failure,
            now,
          ),
        );
      }

      await em.execute(
        `update wallets
            set balance = ?, version = ?, updated_at = ?
          where id = ?`,
        [wallet.balance.toJSON().amount, wallet.version, now, wallet.id],
      );
      await em.execute(
        `insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency,
           balance_before, balance_after, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          wallet.id,
          transactionId,
          direction,
          money.toJSON().amount,
          money.currency,
          balanceBefore.toJSON().amount,
          wallet.balance.toJSON().amount,
          now,
        ],
      );
      await this.markProcessed(
        em,
        transactionId,
        wallet.balance.toJSON().amount,
        wallet.currency,
        reference?.id,
        now,
      );
      const processed = await this.enqueueProcessed(
        em,
        transactionId,
        input,
        money,
        wallet.balance,
        now,
      );
      const balanceChanged = WalletBalanceChanged.create(
        {
          walletId: wallet.id,
          transactionId,
          direction,
          money: money.toJSON(),
          balanceBefore: balanceBefore.toJSON(),
          balanceAfter: wallet.balance.toJSON(),
          walletVersion: wallet.version,
        },
        {
          correlationId: idempotencyKey,
          causationId: processed.eventId,
          occurredAt: now,
        },
      );
      await this.enqueue(em, balanceChanged);
      return complete(
        this.response(
          transactionId,
          WagerTransactionStatus.Processed,
          wallet.balance,
        ),
      );
    });
  }

  async getById(transactionId: string): Promise<WagerTransactionResponse> {
    const row = await this.entityManager.fork().execute<TransactionRow>(
      `select id, provider_id, external_transaction_id, payload_hash,
              wallet_id, player_id, round_id, kind, amount::text, currency,
              status, failure_code, result_balance::text,
              result_balance_currency, reference_transaction_id
         from wager_transactions where id = ?`,
      [transactionId],
      'get',
    );
    if (!row) throw new NotFoundException('Transaction not found');
    return this.toResponse(row, false);
  }

  async recordInboxRejection(
    inbox: InboxContext,
    failureReason: string,
  ): Promise<void> {
    await this.entityManager.fork().execute(
      `insert into inbox_messages
        (consumer_name, message_id, payload_hash, received_at,
         processed_at, status, failure_reason)
       values (?, ?, ?, ?, ?, 'REJECTED', ?)
       on conflict (consumer_name, message_id) do update
         set processed_at = excluded.processed_at,
             status = 'REJECTED',
             failure_reason = excluded.failure_reason
       where inbox_messages.payload_hash = excluded.payload_hash`,
      [
        inbox.consumerName,
        inbox.messageId,
        inbox.payloadHash,
        inbox.receivedAt,
        new Date(),
        failureReason.slice(0, 200),
      ],
    );
  }

  async getByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionResponse> {
    const row = await this.entityManager.fork().execute<TransactionRow>(
      `select id, provider_id, external_transaction_id, payload_hash,
              wallet_id, player_id, round_id, kind, amount::text, currency,
              status, failure_code, result_balance::text,
              result_balance_currency, reference_transaction_id
         from wager_transactions
        where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalTransactionId],
      'get',
    );
    if (!row) throw new NotFoundException('Transaction not found');
    return this.toResponse(row, false);
  }

  async reprocessDueReferences(): Promise<number> {
    const due = await this.entityManager.fork().execute<Array<{ id: string }>>(
      `select id from wager_transactions
        where status = 'PENDING_REFERENCE'
          and reference_next_attempt_at <= now()
        order by reference_next_attempt_at limit 25`,
    );
    let processed = 0;
    for (const { id } of due) {
      if (await this.reprocessReference(id)) processed += 1;
    }
    return processed;
  }

  private async reprocessReference(id: string): Promise<boolean> {
    return this.transactionalWithRetry(async (em) => {
      const pending = await em.execute<PendingRow>(
        `select id, provider_id, external_transaction_id, idempotency_key,
                payload_hash, wallet_id, player_id, round_id, game_id, kind,
                amount::text, currency, status, failure_code,
                result_balance::text, result_balance_currency,
                reference_transaction_id, reference_external_transaction_id,
                reference_attempts
           from wager_transactions where id = ? and status = 'PENDING_REFERENCE'
           for update skip locked`,
        [id],
        'get',
      );
      if (!pending) return false;
      const walletRow = await em.execute<WalletRow>(
        `select id, player_id, currency, balance::text, version,
                created_at, updated_at from wallets where id = ? for update`,
        [pending.wallet_id],
        'get',
      );
      if (!walletRow) return false;
      const input = Object.assign(new SubmitWagerTransactionDto(), {
        providerId: pending.provider_id,
        externalTransactionId: pending.external_transaction_id,
        playerId: pending.player_id,
        walletId: pending.wallet_id,
        roundId: pending.round_id,
        gameId: pending.game_id,
        kind: pending.kind,
        money: { amount: pending.amount, currency: pending.currency },
        referenceExternalTransactionId:
          pending.reference_external_transaction_id,
      });
      const money = Money.from(input.money);
      const wallet = Wallet.rehydrate({
        id: walletRow.id,
        playerId: walletRow.player_id,
        currency: walletRow.currency,
        balance: Money.from({
          amount: walletRow.balance,
          currency: walletRow.currency,
        }),
        version: walletRow.version,
        createdAt: walletRow.created_at,
        updatedAt: walletRow.updated_at,
      });
      const reference = await this.findReference(em, input);
      const now = new Date();
      if (!reference) {
        const attempts = pending.reference_attempts + 1;
        if (attempts >= 8) {
          await this.rejectExisting(
            em,
            pending.id,
            input,
            wallet,
            FailureCode.ReferenceNotFound,
            now,
          );
          return true;
        }
        const delay = Math.min(60_000, 1_000 * 2 ** attempts);
        await em.execute(
          `update wager_transactions set reference_attempts = ?,
                  reference_next_attempt_at = ? where id = ?`,
          [attempts, new Date(Date.now() + delay), pending.id],
        );
        return false;
      }
      const failure = await this.validateReference(em, input, money, reference);
      if (failure) {
        await this.rejectExisting(em, pending.id, input, wallet, failure, now);
        return true;
      }
      const direction =
        input.kind === WagerTransactionKind.Refund ||
        reference.kind === WagerTransactionKind.Bet
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      const before = wallet.balance;
      try {
        if (direction === LedgerDirection.Credit) {
          wallet.credit(money, now);
        } else {
          wallet.debit(money, now);
        }
      } catch (error) {
        if (!(error instanceof InsufficientBalanceError)) throw error;
        await this.rejectExisting(
          em,
          pending.id,
          input,
          wallet,
          FailureCode.ReversalWouldMakeBalanceNegative,
          now,
        );
        return true;
      }
      await em.execute(
        `update wallets set balance = ?, version = ?, updated_at = ? where id = ?`,
        [wallet.balance.toJSON().amount, wallet.version, now, wallet.id],
      );
      await em.execute(
        `insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency,
           balance_before, balance_after, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          wallet.id,
          pending.id,
          direction,
          money.toJSON().amount,
          money.currency,
          before.toJSON().amount,
          wallet.balance.toJSON().amount,
          now,
        ],
      );
      await this.markProcessed(
        em,
        pending.id,
        wallet.balance.toJSON().amount,
        wallet.currency,
        reference.id,
        now,
      );
      const event = await this.enqueueProcessed(
        em,
        pending.id,
        input,
        money,
        wallet.balance,
        now,
      );
      await this.enqueue(
        em,
        WalletBalanceChanged.create(
          {
            walletId: wallet.id,
            transactionId: pending.id,
            direction,
            money: money.toJSON(),
            balanceBefore: before.toJSON(),
            balanceAfter: wallet.balance.toJSON(),
            walletVersion: wallet.version,
          },
          {
            correlationId: pending.idempotency_key,
            causationId: event.eventId,
            occurredAt: now,
          },
        ),
      );
      return true;
    });
  }

  private transactionalWithRetry<T>(
    operation: (entityManager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return withPostgresTransactionRetry(
      () => this.entityManager.fork().transactional(operation),
      {
        onRetry: async () => {
          try {
            await this.incrementCounter(
              this.entityManager.fork(),
              'lock_conflicts_total',
            );
          } catch {
            // Metrics are best effort and must not prevent the financial retry.
          }
        },
      },
    );
  }

  private async insertPending(
    em: EntityManager,
    id: string,
    input: SubmitWagerTransactionDto,
    idempotencyKey: string,
    payloadHash: string,
    money: Money,
    now: Date,
  ): Promise<void> {
    try {
      await em.execute(
        `insert into wager_transactions
          (id, provider_id, external_transaction_id, idempotency_key,
           payload_hash, wallet_id, player_id, round_id, game_id, kind,
           amount, currency, reference_external_transaction_id, status, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
        [
          id,
          input.providerId,
          input.externalTransactionId,
          idempotencyKey,
          payloadHash,
          input.walletId,
          input.playerId,
          input.roundId,
          input.gameId,
          input.kind,
          money.toJSON().amount,
          money.currency,
          input.referenceExternalTransactionId ?? null,
          now,
        ],
      );
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new ConflictException(
          'Provider transaction already exists under another idempotency key',
        );
      }
      throw error;
    }
  }

  private async persistRejected(
    em: EntityManager,
    input: SubmitWagerTransactionDto,
    idempotencyKey: string,
    payloadHash: string,
    wallet: Wallet,
    money: Money,
    failure: FailureCode,
  ): Promise<WagerTransactionResponse> {
    const id = randomUUID();
    const now = new Date();
    await this.insertPending(
      em,
      id,
      input,
      idempotencyKey,
      payloadHash,
      money,
      now,
    );
    return this.rejectExisting(em, id, input, wallet, failure, now);
  }

  private async rejectExisting(
    em: EntityManager,
    id: string,
    input: SubmitWagerTransactionDto,
    wallet: Wallet,
    failure: FailureCode,
    now: Date,
  ): Promise<WagerTransactionResponse> {
    await em.execute(
      `update wager_transactions
          set status = 'REJECTED', failure_code = ?, result_balance = ?,
              result_balance_currency = ?
        where id = ?`,
      [failure, wallet.balance.toJSON().amount, wallet.currency, id],
    );
    const event = WagerTransactionRejected.create(
      {
        transactionId: id,
        walletId: wallet.id,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        failureCode: failure,
        resultBalance: wallet.balance.toJSON(),
      },
      { correlationId: input.externalTransactionId, occurredAt: now },
    );
    await this.enqueue(em, event);
    return this.response(
      id,
      WagerTransactionStatus.Rejected,
      wallet.balance,
      failure,
    );
  }

  private async validateReference(
    em: EntityManager,
    input: SubmitWagerTransactionDto,
    money: Money,
    reference: TransactionRow,
  ): Promise<FailureCode | undefined> {
    if (
      reference.status !== WagerTransactionStatus.Processed ||
      reference.wallet_id !== input.walletId ||
      reference.player_id !== input.playerId ||
      reference.round_id !== input.roundId ||
      reference.currency !== money.currency ||
      (input.kind === WagerTransactionKind.Refund &&
        reference.kind !== WagerTransactionKind.Bet) ||
      (input.kind === WagerTransactionKind.Rollback &&
        ![
          WagerTransactionKind.Bet,
          WagerTransactionKind.Win,
          WagerTransactionKind.Refund,
        ].includes(reference.kind))
    ) {
      return FailureCode.InvalidReference;
    }
    if (reference.amount !== money.toJSON().amount) {
      return FailureCode.AmountMismatch;
    }
    const previous = await em.execute<{ exists: boolean }>(
      `select exists(
         select 1 from wager_transactions
          where reference_transaction_id = ? and kind = ? and status = 'PROCESSED'
       ) as exists`,
      [reference.id, input.kind],
      'get',
    );
    return previous.exists ? FailureCode.ReferenceAlreadyReversed : undefined;
  }

  private async findReference(
    em: EntityManager,
    input: SubmitWagerTransactionDto,
  ): Promise<TransactionRow | undefined> {
    return (await em.execute<TransactionRow>(
      `select id, provider_id, external_transaction_id, payload_hash,
              wallet_id, player_id, round_id, kind, amount::text, currency,
              status, failure_code, result_balance::text,
              result_balance_currency, reference_transaction_id
         from wager_transactions
        where provider_id = ? and external_transaction_id = ?`,
      [input.providerId, input.referenceExternalTransactionId],
      'get',
    )) as TransactionRow | undefined;
  }

  private async findByIdempotencyKey(
    em: EntityManager,
    key: string,
  ): Promise<TransactionRow | undefined> {
    return (await em.execute<TransactionRow>(
      `select id, provider_id, external_transaction_id, payload_hash,
              wallet_id, player_id, round_id, kind, amount::text, currency,
              status, failure_code, result_balance::text,
              result_balance_currency, reference_transaction_id
         from wager_transactions where idempotency_key = ?`,
      [key],
      'get',
    )) as TransactionRow | undefined;
  }

  private async markProcessed(
    em: EntityManager,
    id: string,
    balance: string,
    balanceCurrency: string,
    referenceId: string | undefined,
    now: Date,
  ): Promise<void> {
    await em.execute(
      `update wager_transactions
          set status = 'PROCESSED', result_balance = ?,
              result_balance_currency = ?,
              reference_transaction_id = ?, processed_at = ?
        where id = ?`,
      [balance, balanceCurrency, referenceId ?? null, now, id],
    );
  }

  private async enqueueProcessed(
    em: EntityManager,
    id: string,
    input: SubmitWagerTransactionDto,
    money: Money,
    balance: Money,
    now: Date,
  ): Promise<WagerTransactionProcessed> {
    const event = WagerTransactionProcessed.create(
      {
        transactionId: id,
        walletId: input.walletId,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        kind: input.kind,
        money: money.toJSON(),
        resultBalance: balance.toJSON(),
      },
      { correlationId: input.externalTransactionId, occurredAt: now },
    );
    await this.enqueue(em, event);
    return event;
  }

  private async enqueue(
    em: EntityManager,
    event: {
      eventId: string;
      aggregateId: string;
      eventType: string;
      occurredAt: Date;
      toJSON(): unknown;
    },
  ): Promise<void> {
    await em.execute(
      `insert into outbox_messages
        (id, aggregate_id, event_type, payload, occurred_at, attempts)
       values (?, ?, ?, ?::jsonb, ?, 0)`,
      [
        event.eventId,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.toJSON()),
        event.occurredAt,
      ],
    );
  }

  private async incrementCounter(
    em: EntityManager,
    name: string,
  ): Promise<void> {
    await em.execute(
      `insert into operational_counters (name, value) values (?, 1)
       on conflict (name) do update
         set value = operational_counters.value + 1`,
      [name],
    );
  }

  private toResponse(
    row: TransactionRow,
    replay: boolean,
  ): WagerTransactionResponse {
    return {
      transactionId: row.id,
      status: row.status,
      balance: {
        amount: row.result_balance ?? '0.00',
        currency: row.result_balance_currency ?? row.currency,
      },
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
      idempotentReplay: replay,
    };
  }

  private response(
    id: string,
    status: WagerTransactionStatus,
    balance: Money,
    failureCode?: FailureCode,
  ): WagerTransactionResponse {
    return {
      transactionId: id,
      status,
      balance: balance.toJSON(),
      ...(failureCode ? { failureCode } : {}),
      idempotentReplay: false,
    };
  }
}
