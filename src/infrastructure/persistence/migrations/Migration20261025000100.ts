import { Migration } from '@mikro-orm/migrations';

export class Migration20261025000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" uuid primary key,
        "player_id" uuid not null,
        "currency" char(3) not null,
        "balance" numeric(20,2) not null,
        "version" integer not null default 1,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null,
        constraint "wallets_player_currency_unique" unique ("player_id", "currency"),
        constraint "wallets_currency_format" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallets_balance_non_negative" check ("balance" >= 0),
        constraint "wallets_version_positive" check ("version" >= 1)
      );
    `);

    this.addSql(`
      create table "wager_transactions" (
        "id" uuid primary key,
        "provider_id" varchar(100) not null,
        "external_transaction_id" varchar(200) not null,
        "idempotency_key" varchar(300) not null,
        "payload_hash" char(64) not null,
        "wallet_id" uuid not null references "wallets" ("id"),
        "player_id" uuid not null,
        "round_id" varchar(200) not null,
        "game_id" varchar(200) not null,
        "kind" varchar(16) not null,
        "amount" numeric(20,2) not null,
        "currency" char(3) not null,
        "reference_external_transaction_id" varchar(200),
        "reference_transaction_id" uuid references "wager_transactions" ("id"),
        "status" varchar(24) not null,
        "failure_code" varchar(64),
        "result_balance" numeric(20,2),
        "reference_attempts" integer not null default 0,
        "reference_next_attempt_at" timestamptz,
        "created_at" timestamptz not null,
        "processed_at" timestamptz,
        constraint "wager_transactions_idempotency_unique" unique ("idempotency_key"),
        constraint "wager_transactions_provider_external_unique"
          unique ("provider_id", "external_transaction_id"),
        constraint "wager_transactions_payload_hash_format"
          check ("payload_hash" ~ '^[0-9a-f]{64}$'),
        constraint "wager_transactions_kind_valid"
          check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_transactions_status_valid"
          check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_transactions_amount_positive" check ("amount" > 0),
        constraint "wager_transactions_currency_format" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wager_transactions_result_balance_non_negative"
          check ("result_balance" is null or "result_balance" >= 0),
        constraint "wager_transactions_reference_attempts_non_negative"
          check ("reference_attempts" >= 0),
        constraint "wager_transactions_reference_required"
          check (
            "kind" not in ('REFUND', 'ROLLBACK')
            or "reference_external_transaction_id" is not null
          ),
        constraint "wager_transactions_terminal_shape"
          check (
            ("status" = 'PROCESSED' and "processed_at" is not null and "failure_code" is null)
            or ("status" in ('REJECTED', 'FAILED') and "failure_code" is not null)
            or ("status" in ('PENDING', 'PENDING_REFERENCE') and "processed_at" is null and "failure_code" is null)
          )
      );
    `);

    this.addSql(`
      create index "wager_transactions_pending_reference_due_idx"
        on "wager_transactions" ("reference_next_attempt_at", "created_at")
        where "status" = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid primary key,
        "wallet_id" uuid not null references "wallets" ("id"),
        "transaction_id" uuid not null references "wager_transactions" ("id"),
        "direction" varchar(6) not null,
        "amount" numeric(20,2) not null,
        "currency" char(3) not null,
        "balance_before" numeric(20,2) not null,
        "balance_after" numeric(20,2) not null,
        "created_at" timestamptz not null,
        constraint "wallet_ledger_transaction_unique" unique ("transaction_id"),
        constraint "wallet_ledger_direction_valid" check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_amount_positive" check ("amount" > 0),
        constraint "wallet_ledger_currency_format" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallet_ledger_balances_non_negative"
          check ("balance_before" >= 0 and "balance_after" >= 0),
        constraint "wallet_ledger_arithmetic_valid"
          check (
            ("direction" = 'CREDIT' and "balance_before" + "amount" = "balance_after")
            or ("direction" = 'DEBIT' and "balance_before" - "amount" = "balance_after")
          )
      );
    `);

    this.addSql(`
      create index "wallet_ledger_wallet_cursor_idx"
        on "wallet_ledger_entries" ("wallet_id", "created_at" desc, "id" desc);
    `);

    this.addSql(`
      create table "inbox_messages" (
        "consumer_name" varchar(100) not null,
        "message_id" varchar(200) not null,
        "payload_hash" char(64) not null,
        "received_at" timestamptz not null,
        "processed_at" timestamptz,
        primary key ("consumer_name", "message_id"),
        constraint "inbox_messages_payload_hash_format"
          check ("payload_hash" ~ '^[0-9a-f]{64}$')
      );
    `);

    this.addSql(`
      create table "outbox_messages" (
        "id" uuid primary key,
        "aggregate_id" uuid not null,
        "event_type" varchar(100) not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null,
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz,
        "published_at" timestamptz,
        constraint "outbox_messages_attempts_non_negative" check ("attempts" >= 0),
        constraint "outbox_messages_payload_object" check (jsonb_typeof("payload") = 'object')
      );
    `);

    this.addSql(`
      create index "outbox_messages_due_idx"
        on "outbox_messages" (coalesce("next_attempt_at", "occurred_at"), "occurred_at")
        where "published_at" is null;
    `);

    this.addSql(`
      create function reject_ledger_mutation() returns trigger as $$
      begin
        raise exception 'wallet ledger entries are immutable' using errcode = 'integrity_constraint_violation';
      end;
      $$ language plpgsql;
    `);

    this.addSql(`
      create trigger "wallet_ledger_entries_immutable"
        before update or delete on "wallet_ledger_entries"
        for each row execute function reject_ledger_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      'drop trigger if exists "wallet_ledger_entries_immutable" on "wallet_ledger_entries";',
    );
    this.addSql('drop function if exists reject_ledger_mutation();');
    this.addSql('drop table if exists "outbox_messages";');
    this.addSql('drop table if exists "inbox_messages";');
    this.addSql('drop table if exists "wallet_ledger_entries";');
    this.addSql('drop table if exists "wager_transactions";');
    this.addSql('drop table if exists "wallets";');
  }
}
