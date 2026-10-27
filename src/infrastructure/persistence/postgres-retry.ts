const TRANSIENT_POSTGRES_CODES = new Set(['40001', '40P01']);

export interface PostgresRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  random?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (error: unknown) => Promise<void> | void;
}

interface PostgresErrorLike {
  code?: unknown;
  cause?: unknown;
}

export function isTransientPostgresError(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as PostgresErrorLike;
    if (
      typeof candidate.code === 'string' &&
      TRANSIENT_POSTGRES_CODES.has(candidate.code)
    ) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}

export async function withPostgresTransactionRetry<T>(
  operation: () => Promise<T>,
  options: PostgresRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 25;
  const random = options.random ?? Math.random;
  const sleep =
    options.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientPostgresError(error)) {
        throw error;
      }
      await options.onRetry?.(error);
      const exponentialDelay = baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.floor(random() * baseDelayMs);
      await sleep(exponentialDelay + jitter);
    }
  }
}
