import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadEnvironment } from './config/environment.js';
import { configureApplication } from './configure-application.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const environment = loadEnvironment();

  configureApplication(app);

  await app.listen(environment.port);
}
await bootstrap();
