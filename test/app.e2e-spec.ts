import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApplication } from '../src/configure-application.js';
import { loadEnvironment } from '../src/config/environment.js';

describe('HTTP API (e2e with PostgreSQL)', () => {
  let app: INestApplication<App>;
  let entityManager: EntityManager;
  let sqs: SQSClient;
  const environment = loadEnvironment();

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApplication(app);
    await app.init();
    app.getHttpServer().setMaxListeners(100);
    entityManager = app.get(EntityManager);
    sqs = new SQSClient({
      region: environment.sqs.region,
      endpoint: environment.sqs.endpoint,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });

  it('reports the process as available', async () => {
    await request(app.getHttpServer()).get('/').expect(200, 'Hello World!');
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200, { status: 'ok' });
    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          status: 'ok',
          checks: { postgres: true, sqs: true },
        });
      });
  });

  it('creates wallet, opening ledger, and outbox atomically', async () => {
    const playerId = randomUUID();
    const createResponse = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);

    expect(createResponse.body).toMatchObject({
      playerId,
      balance: { amount: '100.00', currency: 'BRL' },
      version: 1,
    });

    const walletId = createResponse.body.id as string;
    await request(app.getHttpServer())
      .get(`/wallets/${walletId}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual(createResponse.body);
      });

    const rows = await entityManager
      .fork()
      .execute<Array<{ ledger_entries: string; outbox_events: string }>>(
        `select count(distinct l.id)::text as ledger_entries,
              count(distinct o.id)::text as outbox_events
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
         left join outbox_messages o
           on o.aggregate_id in (w.id, l.transaction_id)
        where w.id = ?`,
        [walletId],
      );
    expect(rows[0]).toEqual({ ledger_entries: '1', outbox_events: '2' });

    const publishDeadline = Date.now() + 5_000;
    let publishedEvents = 0;
    while (publishedEvents < 2 && Date.now() < publishDeadline) {
      const published = await entityManager.fork().execute<{
        count: number;
      }>(
        `select count(*)::int as count from outbox_messages
          where aggregate_id in (
            ?::uuid,
            (select transaction_id from wallet_ledger_entries where wallet_id = ? limit 1)
          ) and published_at is not null`,
        [walletId, walletId],
        'get',
      );
      publishedEvents = published.count;
      if (publishedEvents < 2) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(publishedEvents).toBe(2);

    await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(409);
  });

  it('rejects non-canonical money before reaching the domain', async () => {
    await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: randomUUID(),
        initialBalance: { amount: '10.1', currency: 'BRL' },
      })
      .expect(400);
  });

  it('rejects malformed identifiers and oversized idempotency keys as 400', async () => {
    await request(app.getHttpServer()).get('/wallets/not-a-uuid').expect(400);
    await request(app.getHttpServer())
      .get('/wagering/transactions/not-a-uuid')
      .expect(400);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'x'.repeat(301))
      .send({
        providerId: 'provider-validation',
        externalTransactionId: randomUUID(),
        playerId: randomUUID(),
        walletId: randomUUID(),
        roundId: randomUUID(),
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      })
      .expect(400);
  });

  it('debits exactly once when the same bet arrives 50 times in parallel', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);
    const payload = {
      providerId: 'provider-parallel-replay',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.body.id as string,
      roundId: randomUUID(),
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const idempotencyKey = `${payload.providerId}:${payload.externalTransactionId}`;

    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(app.getHttpServer())
          .post('/wagering/transactions')
          .set('Idempotency-Key', idempotencyKey)
          .send(payload),
      ),
    );

    expect(responses.filter(({ status }) => status === 201)).toHaveLength(1);
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(49);
    expect(new Set(responses.map(({ body }) => body.transactionId)).size).toBe(
      1,
    );
    const fetched = await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.id as string}`)
      .expect(200);
    expect(fetched.body.balance.amount).toBe('75.00');
  });

  it('serializes competing bets on one wallet without a lost update', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);
    const base = {
      providerId: 'provider-competing-bets',
      playerId,
      walletId: wallet.body.id as string,
      roundId: randomUUID(),
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
    };
    const payloads = [
      { ...base, externalTransactionId: randomUUID() },
      { ...base, externalTransactionId: randomUUID() },
    ];
    const responses = await Promise.all(
      payloads.map((payload) =>
        request(app.getHttpServer())
          .post('/wagering/transactions')
          .set(
            'Idempotency-Key',
            `${payload.providerId}:${payload.externalTransactionId}`,
          )
          .send(payload),
      ),
    );

    expect(responses.map(({ status }) => status).sort((a, b) => a - b)).toEqual(
      [201, 422],
    );
    expect(
      responses.find(({ status }) => status === 422)?.body.failureCode,
    ).toBe('INSUFFICIENT_BALANCE');
    const fetched = await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.id as string}`)
      .expect(200);
    expect(fetched.body.balance.amount).toBe('20.00');

    const ledger = await entityManager
      .fork()
      .execute<Array<{ entries: string }>>(
        `select count(*)::text as entries
         from wallet_ledger_entries where wallet_id = ?`,
        [wallet.body.id],
      );
    expect(ledger[0]?.entries).toBe('2');
  });

  it('refunds a processed bet once and replays the original response', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);
    const walletId = wallet.body.id as string;
    const roundId = randomUUID();
    const betExternalId = randomUUID();
    const bet = {
      providerId: 'provider-refund',
      externalTransactionId: betExternalId,
      playerId,
      walletId,
      roundId,
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `${bet.providerId}:${bet.externalTransactionId}`)
      .send(bet)
      .expect(201);

    const refund = {
      ...bet,
      externalTransactionId: randomUUID(),
      kind: 'REFUND',
      referenceExternalTransactionId: betExternalId,
    };
    const key = `${refund.providerId}:${refund.externalTransactionId}`;
    const applied = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(refund)
      .expect(201);
    expect(applied.body.balance.amount).toBe('100.00');

    const replay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(refund)
      .expect(200);
    expect(replay.body).toEqual({
      ...applied.body,
      idempotentReplay: true,
    });

    await request(app.getHttpServer())
      .get(`/wagering/transactions/${applied.body.transactionId as string}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('PROCESSED');
        expect(body.balance.amount).toBe('100.00');
      });
  });

  it('persists an out-of-order refund as pending reference', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);
    const refund = {
      providerId: 'provider-out-of-order',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.body.id as string,
      roundId: randomUUID(),
      gameId: 'fortune-chimp',
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: randomUUID(),
    };
    const key = `${refund.providerId}:${refund.externalTransactionId}`;
    const pending = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(refund)
      .expect(202);
    expect(pending.body).toMatchObject({
      status: 'PENDING_REFERENCE',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    const replay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(refund)
      .expect(200);
    expect(replay.body.balance).toEqual(pending.body.balance);
    expect(replay.body.idempotentReplay).toBe(true);

    const betExternalTransactionId = refund.referenceExternalTransactionId;
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set(
        'Idempotency-Key',
        `${refund.providerId}:${betExternalTransactionId}`,
      )
      .send({
        ...refund,
        externalTransactionId: betExternalTransactionId,
        kind: 'BET',
        referenceExternalTransactionId: undefined,
      })
      .expect(201);

    const deadline = Date.now() + 5_000;
    let resolvedStatus = 'PENDING_REFERENCE';
    while (resolvedStatus === 'PENDING_REFERENCE' && Date.now() < deadline) {
      const result = await request(app.getHttpServer()).get(
        `/wagering/transactions/${pending.body.transactionId as string}`,
      );
      resolvedStatus = result.body.status as string;
      if (resolvedStatus === 'PENDING_REFERENCE') {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(resolvedStatus).toBe('PROCESSED');
    const finalWallet = await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.id as string}`)
      .expect(200);
    expect(finalWallet.body.balance.amount).toBe('100.00');
  });

  it('paginates ledger with an opaque cursor and reconciles the wallet', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);
    const walletId = wallet.body.id as string;
    for (const amount of ['10.00', '15.00']) {
      const externalTransactionId = randomUUID();
      await request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('Idempotency-Key', `provider-pagination:${externalTransactionId}`)
        .send({
          providerId: 'provider-pagination',
          externalTransactionId,
          playerId,
          walletId,
          roundId: randomUUID(),
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount, currency: 'BRL' },
        })
        .expect(201);
    }

    const first = await request(app.getHttpServer())
      .get(`/wallets/${walletId}/ledger?limit=2`)
      .expect(200);
    expect(first.body.entries).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await request(app.getHttpServer())
      .get(
        `/wallets/${walletId}/ledger?limit=2&cursor=${encodeURIComponent(first.body.nextCursor as string)}`,
      )
      .expect(200);
    expect(second.body.entries).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();

    await request(app.getHttpServer())
      .post(`/wallets/${walletId}/reconciliation`)
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          walletId,
          storedBalance: { amount: '75.00', currency: 'BRL' },
          calculatedBalance: { amount: '75.00', currency: 'BRL' },
          difference: { amount: '0.00', currency: 'BRL' },
          consistent: true,
          checkedEntries: 3,
        });
      });
  });

  it('processes and deduplicates a real SQS message through the inbox', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);
    const walletId = wallet.body.id as string;
    const messageId = randomUUID();
    const externalTransactionId = randomUUID();
    const envelope = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-sqs',
        externalTransactionId,
        idempotencyKey: `provider-sqs:${externalTransactionId}`,
        playerId,
        walletId,
        roundId: randomUUID(),
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
    };

    const send = (deduplicationId: string) =>
      sqs.send(
        new SendMessageCommand({
          QueueUrl: environment.sqs.wagerQueueUrl,
          MessageBody: JSON.stringify(envelope),
          MessageGroupId: walletId,
          MessageDeduplicationId: deduplicationId,
        }),
      );
    await send(randomUUID());

    const deadline = Date.now() + 8_000;
    let processed = false;
    while (!processed && Date.now() < deadline) {
      const inbox = await entityManager.fork().execute<{ processed: boolean }>(
        `select exists(
           select 1 from inbox_messages
            where consumer_name = 'wager-transaction-consumer-v1'
              and message_id = ? and processed_at is not null
         ) as processed`,
        [messageId],
        'get',
      );
      processed = inbox.processed;
      if (!processed) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(processed).toBe(true);

    await send(randomUUID());
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const state = await entityManager.fork().execute<{
      balance: string;
      ledger_entries: number;
      transactions: number;
    }>(
      `select w.balance::text,
              (select count(*)::int from wallet_ledger_entries l
                where l.wallet_id = w.id) as ledger_entries,
              (select count(*)::int from wager_transactions t
                where t.wallet_id = w.id) as transactions
         from wallets w where w.id = ?`,
      [walletId],
      'get',
    );
    expect(state).toEqual({
      balance: '75.00',
      ledger_entries: 2,
      transactions: 2,
    });
  });

  it('audits a terminal SQS business rejection before acknowledging it', async () => {
    const messageId = randomUUID();
    const walletId = randomUUID();
    const externalTransactionId = randomUUID();
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: environment.sqs.wagerQueueUrl,
        MessageGroupId: walletId,
        MessageDeduplicationId: randomUUID(),
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'provider-terminal-rejection',
            externalTransactionId,
            idempotencyKey: `provider-terminal-rejection:${externalTransactionId}`,
            playerId: randomUUID(),
            walletId,
            roundId: randomUUID(),
            gameId: 'fortune-chimp',
            kind: 'BET',
            money: { amount: '10.00', currency: 'BRL' },
          },
        }),
      }),
    );

    const deadline = Date.now() + 8_000;
    let rejected: { status: string; failure_reason: string } | undefined;
    while (!rejected && Date.now() < deadline) {
      rejected = await entityManager.fork().execute<{
        status: string;
        failure_reason: string;
      }>(
        `select status, failure_reason from inbox_messages
          where consumer_name = 'wager-transaction-consumer-v1'
            and message_id = ? and processed_at is not null`,
        [messageId],
        'get',
      );
      if (!rejected) await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(rejected).toEqual({
      status: 'REJECTED',
      failure_reason: 'HTTP_404_NotFoundException',
    });
  });

  afterAll(async () => {
    sqs.destroy();
    await app.close();
  });
});
