import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApplication } from '../src/configure-application.js';

describe('HTTP API (e2e with PostgreSQL)', () => {
  let app: INestApplication<App>;
  let entityManager: EntityManager;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApplication(app);
    await app.init();
    entityManager = app.get(EntityManager);
  });

  it('reports the process as available', async () => {
    await request(app.getHttpServer()).get('/').expect(200, 'Hello World!');
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

  afterAll(async () => {
    await app.close();
  });
});
