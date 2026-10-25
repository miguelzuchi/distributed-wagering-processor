import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { loadEnvironment, validateEnvironment } from './config/environment.js';
import mikroOrmConfig from './infrastructure/persistence/mikro-orm.config.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [loadEnvironment],
      validate: validateEnvironment,
    }),
    MikroOrmModule.forRoot(mikroOrmConfig),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
