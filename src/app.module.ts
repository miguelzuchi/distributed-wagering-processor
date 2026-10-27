import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { loadEnvironment, validateEnvironment } from './config/environment.js';
import mikroOrmConfig from './infrastructure/persistence/mikro-orm.config.js';
import { WalletsModule } from './wallets/wallets.module.js';
import { WageringModule } from './wagering/wagering.module.js';
import { HealthModule } from './health/health.module.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { HttpLoggingMiddleware } from './observability/http-logging.middleware.js';
import { AuthModule } from './auth/auth.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [loadEnvironment],
      validate: validateEnvironment,
    }),
    AuthModule,
    MikroOrmModule.forRoot(mikroOrmConfig),
    WalletsModule,
    WageringModule,
    HealthModule,
    MessagingModule,
    MetricsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpLoggingMiddleware).forRoutes('*');
  }
}
