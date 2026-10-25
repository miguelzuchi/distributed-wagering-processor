import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { loadEnvironment } from './config/environment.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const environment = loadEnvironment();

  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  await app.listen(environment.port);
}
await bootstrap();
