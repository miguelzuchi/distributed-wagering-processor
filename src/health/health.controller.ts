import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { loadEnvironment } from '../config/environment.js';

@Controller('health')
export class HealthController {
  private readonly environment = loadEnvironment();
  private readonly sqs = new SQSClient({
    region: this.environment.sqs.region,
    endpoint: this.environment.sqs.endpoint,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });

  constructor(private readonly entityManager: EntityManager) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const checks = { postgres: false, sqs: false };
    try {
      await this.entityManager.fork().execute('select 1');
      checks.postgres = true;
      await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.environment.sqs.wagerQueueUrl,
          AttributeNames: ['QueueArn'],
        }),
      );
      checks.sqs = true;
    } catch {
      throw new ServiceUnavailableException({ status: 'error', checks });
    }
    return { status: 'ok', checks };
  }
}
