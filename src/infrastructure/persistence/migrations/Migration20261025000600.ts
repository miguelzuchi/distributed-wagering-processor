import { Migration } from '@mikro-orm/migrations';

export class Migration20261025000600 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create unique index "wager_transactions_processed_reversal_unique"
        on "wager_transactions" ("reference_transaction_id", "kind")
        where "status" = 'PROCESSED' and "reference_transaction_id" is not null;
    `);
    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_not_self_referencing"
        check ("reference_transaction_id" is null or "reference_transaction_id" <> "id");
    `);
    this.addSql(`
      create function validate_ledger_relationships() returns trigger as $$
      declare
        transaction_wallet uuid;
        transaction_currency char(3);
        wallet_currency char(3);
      begin
        select wallet_id, currency into transaction_wallet, transaction_currency
          from wager_transactions where id = new.transaction_id;
        select currency into wallet_currency from wallets where id = new.wallet_id;
        if transaction_wallet is distinct from new.wallet_id then
          raise exception 'ledger wallet differs from transaction wallet'
            using errcode = 'integrity_constraint_violation';
        end if;
        if transaction_currency is distinct from new.currency
           or wallet_currency is distinct from new.currency then
          raise exception 'ledger currency differs from wallet or transaction currency'
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end;
      $$ language plpgsql;
    `);
    this.addSql(`
      create trigger "wallet_ledger_relationships_valid"
        before insert on "wallet_ledger_entries"
        for each row execute function validate_ledger_relationships();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      'drop trigger if exists "wallet_ledger_relationships_valid" on "wallet_ledger_entries";',
    );
    this.addSql('drop function if exists validate_ledger_relationships();');
    this.addSql(`
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_not_self_referencing";
    `);
    this.addSql(
      'drop index if exists "wager_transactions_processed_reversal_unique";',
    );
  }
}
