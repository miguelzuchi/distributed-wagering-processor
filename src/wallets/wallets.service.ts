import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../domain/shared/money.js';
import { LedgerDirection } from '../domain/wallet/wallet-ledger-entry.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wagering/wager-transaction.js';
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from '../domain/events/wallet-events.js';
import { CreateWalletDto } from './dto/create-wallet.dto.js';
import { LedgerQueryDto } from './dto/create-wallet.dto.js';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
}

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

interface LedgerRow {
  id: string;
  transaction_id: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
}

interface LedgerCursor {
  createdAt: string;
  id: string;
}

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(private readonly entityManager: EntityManager) {}

  async create(input: CreateWalletDto): Promise<WalletResponse> {
    const initialBalance = Money.from(input.initialBalance);
    const walletId = randomUUID();
    const transactionId = randomUUID();
    const now = new Date();
    const correlationId = randomUUID();
    const externalTransactionId = `opening:${walletId}`;
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          currency: initialBalance.currency,
          initialBalance: initialBalance.toJSON().amount,
          playerId: input.playerId,
          walletId,
        }),
      )
      .digest('hex');

    try {
      await this.entityManager.fork().transactional(async (em) => {
        await em.execute(
          `insert into wallets
            (id, player_id, currency, balance, version, created_at, updated_at)
           values (?, ?, ?, ?, 1, ?, ?)`,
          [
            walletId,
            input.playerId,
            initialBalance.currency,
            initialBalance.toJSON().amount,
            now,
            now,
          ],
        );

        if (initialBalance.isZero()) {
          return;
        }

        await em.execute(
          `insert into wager_transactions
            (id, provider_id, external_transaction_id, idempotency_key,
             payload_hash, wallet_id, player_id, round_id, game_id, kind,
             amount, currency, status, result_balance, result_balance_currency,
             created_at, processed_at)
           values (?, '__internal__', ?, ?, ?, ?, ?, '__opening__', '__opening__',
                   ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            transactionId,
            externalTransactionId,
            externalTransactionId,
            payloadHash,
            walletId,
            input.playerId,
            WagerTransactionKind.Opening,
            initialBalance.toJSON().amount,
            initialBalance.currency,
            WagerTransactionStatus.Processed,
            initialBalance.toJSON().amount,
            initialBalance.currency,
            now,
            now,
          ],
        );

        await em.execute(
          `insert into wallet_ledger_entries
            (id, wallet_id, transaction_id, direction, amount, currency,
             balance_before, balance_after, created_at)
           values (?, ?, ?, ?, ?, ?, '0.00', ?, ?)`,
          [
            randomUUID(),
            walletId,
            transactionId,
            LedgerDirection.Credit,
            initialBalance.toJSON().amount,
            initialBalance.currency,
            initialBalance.toJSON().amount,
            now,
          ],
        );

        const money = initialBalance.toJSON();
        const processed = WagerTransactionProcessed.create(
          {
            transactionId,
            walletId,
            providerId: '__internal__',
            externalTransactionId,
            kind: WagerTransactionKind.Opening,
            money,
            resultBalance: money,
          },
          { correlationId, occurredAt: now },
        );
        const balanceChanged = WalletBalanceChanged.create(
          {
            walletId,
            transactionId,
            direction: LedgerDirection.Credit,
            money,
            balanceBefore: Money.zero(initialBalance.currency).toJSON(),
            balanceAfter: money,
            walletVersion: 1,
          },
          { correlationId, causationId: processed.eventId, occurredAt: now },
        );

        for (const event of [processed, balanceChanged]) {
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
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new ConflictException(
          'A wallet already exists for this player and currency',
        );
      }
      throw error;
    }

    return this.toResponse({
      id: walletId,
      player_id: input.playerId,
      currency: initialBalance.currency,
      balance: initialBalance.toJSON().amount,
      version: 1,
    });
  }

  async getById(walletId: string): Promise<WalletResponse> {
    const row = await this.entityManager.fork().execute<WalletRow>(
      `select id, player_id, currency, balance::text, version
         from wallets where id = ?`,
      [walletId],
      'get',
    );
    if (!row) {
      throw new NotFoundException('Wallet not found');
    }
    return this.toResponse(row);
  }

  async listLedger(walletId: string, query: LedgerQueryDto) {
    await this.getById(walletId);
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : undefined;
    const params: unknown[] = [walletId];
    let cursorCondition = '';
    if (cursor) {
      cursorCondition = 'and (created_at, id) < (?::timestamptz, ?::uuid)';
      params.push(cursor.createdAt, cursor.id);
    }
    params.push(query.limit + 1);
    const rows = await this.entityManager.fork().execute<LedgerRow[]>(
      `select id, transaction_id, direction, amount::text, currency,
              balance_before::text, balance_after::text, created_at
         from wallet_ledger_entries
        where wallet_id = ? ${cursorCondition}
        order by created_at desc, id desc
        limit ?`,
      params,
    );
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      entries: page.map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: { amount: row.amount, currency: row.currency },
        balanceBefore: { amount: row.balance_before, currency: row.currency },
        balanceAfter: { amount: row.balance_after, currency: row.currency },
        createdAt: this.toISOString(row.created_at),
      })),
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({
                createdAt: this.toISOString(last.created_at),
                id: last.id,
              }),
            ).toString('base64url')
          : null,
    };
  }

  async reconcile(walletId: string) {
    const wallet = await this.getById(walletId);
    const result = await this.entityManager.fork().execute<{
      calculated_balance: string;
      checked_entries: number;
    }>(
      `select coalesce(sum(
                case direction when 'CREDIT' then amount else -amount end
              ), 0)::numeric(20,2)::text as calculated_balance,
              count(*)::int as checked_entries
         from wallet_ledger_entries where wallet_id = ?`,
      [walletId],
      'get',
    );
    const stored = Money.from(wallet.balance);
    const calculated = Money.from({
      amount: result.calculated_balance,
      currency: wallet.balance.currency,
    });
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();
    if (!consistent) {
      this.logger.error({
        event: 'wallet_reconciliation_divergence',
        walletId,
        checkedEntries: result.checked_entries,
      });
    }
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: result.checked_entries,
    };
  }

  private decodeCursor(value: string): LedgerCursor {
    try {
      const parsed = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as LedgerCursor;
      if (
        typeof parsed.createdAt !== 'string' ||
        Number.isNaN(Date.parse(parsed.createdAt)) ||
        !/^[0-9a-f-]{36}$/i.test(parsed.id)
      ) {
        throw new Error('Invalid shape');
      }
      return parsed;
    } catch {
      throw new BadRequestException('Invalid ledger cursor');
    }
  }

  private toISOString(value: Date | string): string {
    return typeof value === 'string'
      ? new Date(value).toISOString()
      : value.toISOString();
  }

  private toResponse(row: WalletRow): WalletResponse {
    return {
      id: row.id,
      playerId: row.player_id,
      balance: { amount: row.balance, currency: row.currency },
      version: row.version,
    };
  }
}
