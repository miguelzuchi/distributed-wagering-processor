import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { loadEnvironment } from '../../config/environment.js';

const environment = loadEnvironment();

export default defineConfig({
  host: environment.database.host,
  port: environment.database.port,
  dbName: environment.database.name,
  user: environment.database.user,
  password: environment.database.password,
  entities: ['dist/**/*.entity.js'],
  entitiesTs: ['src/**/*.entity.ts'],
  extensions: [Migrator],
  migrations: {
    path: 'dist/infrastructure/persistence/migrations',
    pathTs: 'src/infrastructure/persistence/migrations',
    transactional: true,
    allOrNothing: true,
    emit: 'ts',
  },
  debug: environment.nodeEnv === 'development',
});
