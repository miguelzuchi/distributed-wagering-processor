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
    throw new Error(`${name} must be a positive integer`);
  }

  return Number.parseInt(rawValue, 10);
}

export function validateEnvironment(
  environment: Record<string, string | undefined>,
): Record<string, string | undefined> {
  integerFromEnvironment(environment, 'PORT', 3000);
  integerFromEnvironment(environment, 'DATABASE_PORT', 5432);

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
    },
  };
}
