import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

interface RunningReplica {
  process: ChildProcessWithoutNullStreams;
  baseUrl: string;
  logs: () => string;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate a TCP port');
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function startReplica(
  port: number,
  environment: Record<string, string> = {},
): Promise<RunningReplica> {
  let output = '';
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      ...environment,
    },
    stdio: 'pipe',
  });
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-20_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Replica exited during startup:\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health/live`);
      if (response.ok) return { process: child, baseUrl, logs: () => output };
    } catch {
      // The socket is expected to refuse connections while Nest initializes.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  child.kill('SIGTERM');
  throw new Error(`Replica did not become healthy:\n${output}`);
}

async function stopReplica(replica: RunningReplica): Promise<void> {
  if (replica.process.exitCode !== null) return;
  replica.process.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) =>
      replica.process.once('exit', () => resolve()),
    ),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        replica.process.kill('SIGKILL');
        resolve();
      }, 5_000),
    ),
  ]);
}

describe('multi-process deployment', () => {
  const replicas: RunningReplica[] = [];

  afterAll(async () => {
    await Promise.all(replicas.map(stopReplica));
  });

  it('keeps idempotency and wallet consistency across separate OS processes', async () => {
    const [firstPort, secondPort, thirdPort] = await Promise.all([
      availablePort(),
      availablePort(),
      availablePort(),
    ]);
    const first = await startReplica(firstPort);
    replicas.push(first);
    const second = await startReplica(secondPort);
    replicas.push(second);
    const third = await startReplica(thirdPort);
    replicas.push(third);

    const playerId = randomUUID();
    const walletResponse = await fetch(`${first.baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    expect(walletResponse.status).toBe(201);
    const wallet = (await walletResponse.json()) as { id: string };
    const payload = {
      providerId: 'provider-multiprocess',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const idempotencyKey = `${payload.providerId}:${payload.externalTransactionId}`;

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        fetch(
          `${[first, second, third][index % 3]!.baseUrl}/wagering/transactions`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': idempotencyKey,
            },
            body: JSON.stringify(payload),
          },
        ),
      ),
    );

    expect(responses.filter(({ status }) => status === 201)).toHaveLength(1);
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(49);

    await stopReplica(first);
    const survivingResponse = await fetch(
      `${second.baseUrl}/wallets/${wallet.id}`,
    );
    expect(survivingResponse.status).toBe(200);
    const survivingWallet = (await survivingResponse.json()) as {
      balance: { amount: string };
    };
    expect(survivingWallet.balance.amount).toBe('75.00');

    if (second.process.exitCode !== null) {
      throw new Error(
        `Surviving replica exited unexpectedly:\n${second.logs()}`,
      );
    }
    await Promise.all([stopReplica(second), stopReplica(third)]);
  }, 30_000);

  it('redelivers safely when a worker dies after commit and before ACK', async () => {
    const delayed = await startReplica(await availablePort(), {
      SQS_ACK_DELAY_MS: '10000',
    });
    replicas.push(delayed);
    const playerId = randomUUID();
    const walletResponse = await fetch(`${delayed.baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    const wallet = (await walletResponse.json()) as { id: string };
    const externalTransactionId = randomUUID();
    const sqs = new SQSClient({
      region: 'us-east-1',
      endpoint: 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: 'http://localhost:4566/000000000000/wager-transactions.fifo',
        MessageGroupId: wallet.id,
        MessageDeduplicationId: randomUUID(),
        MessageBody: JSON.stringify({
          messageId: randomUUID(),
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'provider-crash',
            externalTransactionId,
            idempotencyKey: `provider-crash:${externalTransactionId}`,
            playerId,
            walletId: wallet.id,
            roundId: randomUUID(),
            gameId: 'fortune-chimp',
            kind: 'BET',
            money: { amount: '25.00', currency: 'BRL' },
          },
        }),
      }),
    );

    const deadline = Date.now() + 10_000;
    let committed = false;
    while (!committed && Date.now() < deadline) {
      const response = await fetch(
        `${delayed.baseUrl}/providers/provider-crash/wagering/transactions/${externalTransactionId}`,
      );
      committed = response.ok;
      if (!committed) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(committed).toBe(true);
    delayed.process.kill('SIGKILL');

    const replacement = await startReplica(await availablePort());
    replicas.push(replacement);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const state = await fetch(`${replacement.baseUrl}/wallets/${wallet.id}`);
    const body = (await state.json()) as { balance: { amount: string } };
    expect(body.balance.amount).toBe('75.00');
    const reconciliation = await fetch(
      `${replacement.baseUrl}/wallets/${wallet.id}/reconciliation`,
      { method: 'POST' },
    );
    expect(reconciliation.status).toBe(201);
    expect(await reconciliation.json()).toMatchObject({
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
    sqs.destroy();
  }, 30_000);
});
