import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { loadEnvironment } from '../../config/environment.js';
import { InboxMessageEntity } from './entities/inbox-message.entity.js';
import { OutboxMessageEntity } from './entities/outbox-message.entity.js';
import { WagerTransactionEntity } from './entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity.js';
import { WalletEntity } from './entities/wallet.entity.js';

const environment = loadEnvironment();

export default defineConfig({
  host: environment.database.host,
  port: environment.database.port,
  dbName: environment.database.name,
  user: environment.database.user,
  password: environment.database.password,
  entities: [
    WalletEntity,
    WagerTransactionEntity,
    WalletLedgerEntryEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],
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
