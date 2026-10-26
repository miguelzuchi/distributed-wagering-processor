export interface Environment {
  nodeEnv: string;
  port: number;
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  sqs: {
    region: string;
    endpoint: string;
    wagerQueueUrl: string;
    wagerDlqUrl: string;
    eventsQueueUrl: string;
  };
}

function integerFromEnvironment(
  environment: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const rawValue = environment[name];

  if (rawValue === undefined) {
    return fallback;
  }

  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }

  const value = Number.parseInt(rawValue, 10);
  if (value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function requireProductionValue(
  environment: Record<string, string | undefined>,
  name: string,
): void {
  if (!environment[name]?.trim()) {
    throw new Error(`${name} is required when NODE_ENV=production`);
  }
}

function validateUrl(
  environment: Record<string, string | undefined>,
  name: string,
): void {
  const value = environment[name];
  if (!value) return;
  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

export function validateEnvironment(
  environment: Record<string, string | undefined>,
): Record<string, string | undefined> {
  integerFromEnvironment(environment, 'PORT', 3000);
  integerFromEnvironment(environment, 'DATABASE_PORT', 5432);

  const nodeEnv = environment.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  for (const name of [
    'SQS_ENDPOINT',
    'SQS_WAGER_QUEUE_URL',
    'SQS_WAGER_DLQ_URL',
    'SQS_EVENTS_QUEUE_URL',
  ]) {
    validateUrl(environment, name);
  }

  if (nodeEnv === 'production') {
    for (const name of [
      'DATABASE_HOST',
      'DATABASE_NAME',
      'DATABASE_USER',
      'DATABASE_PASSWORD',
      'AWS_REGION',
      'SQS_WAGER_QUEUE_URL',
      'SQS_WAGER_DLQ_URL',
      'SQS_EVENTS_QUEUE_URL',
    ]) {
      requireProductionValue(environment, name);
    }
  }

  return environment;
}

export function loadEnvironment(): Environment {
  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: integerFromEnvironment(process.env, 'PORT', 3000),
    database: {
      host: process.env.DATABASE_HOST ?? 'localhost',
      port: integerFromEnvironment(process.env, 'DATABASE_PORT', 5432),
      name: process.env.DATABASE_NAME ?? 'wagering',
      user: process.env.DATABASE_USER ?? 'wagering',
      password: process.env.DATABASE_PASSWORD ?? 'wagering',
    },
    sqs: {
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
      wagerQueueUrl:
        process.env.SQS_WAGER_QUEUE_URL ??
        'http://localhost:4566/000000000000/wager-transactions.fifo',
      wagerDlqUrl:
        process.env.SQS_WAGER_DLQ_URL ??
        'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
      eventsQueueUrl:
        process.env.SQS_EVENTS_QUEUE_URL ??
        'http://localhost:4566/000000000000/wager-events.fifo',
    },
  };
}
