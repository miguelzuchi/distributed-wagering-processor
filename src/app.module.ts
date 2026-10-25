import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { loadEnvironment, validateEnvironment } from './config/environment.js';
import mikroOrmConfig from './infrastructure/persistence/mikro-orm.config.js';
import { WalletsModule } from './wallets/wallets.module.js';
import { WageringModule } from './wagering/wagering.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [loadEnvironment],
      validate: validateEnvironment,
    }),
    MikroOrmModule.forRoot(mikroOrmConfig),
    WalletsModule,
    WageringModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
