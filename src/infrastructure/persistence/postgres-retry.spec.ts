import {
  isTransientPostgresError,
  withPostgresTransactionRetry,
} from './postgres-retry.js';

describe('PostgreSQL transaction retry', () => {
  it.each(['40001', '40P01'])('recognizes transient code %s', (code) => {
    expect(isTransientPostgresError({ code })).toBe(true);
    expect(isTransientPostgresError({ cause: { code } })).toBe(true);
  });

  it('does not classify unrelated failures as transient', () => {
    expect(isTransientPostgresError({ code: '23505' })).toBe(false);
    expect(isTransientPostgresError(new Error('failure'))).toBe(false);
  });

  it('retries a transient failure with exponential delay and jitter', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withPostgresTransactionRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw { code: calls === 1 ? '40P01' : '40001' };
        return 'ok';
      },
      {
        baseDelayMs: 10,
        random: () => 0.5,
        sleep: (delay) => {
          delays.push(delay);
          return Promise.resolve();
        },
      },
    );

    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toEqual([15, 25]);
  });

  it('stops at the configured attempt limit', async () => {
    let calls = 0;
    await expect(
      withPostgresTransactionRetry(
        async () => {
          calls += 1;
          throw { code: '40P01' };
        },
        { maxAttempts: 2, sleep: () => Promise.resolve() },
      ),
    ).rejects.toEqual({ code: '40P01' });
    expect(calls).toBe(2);
  });
});
