import { Migration } from '@mikro-orm/migrations';

export class Migration20261025000200 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "result_balance_currency" char(3);
    `);
    this.addSql(`
      update "wager_transactions" t
         set "result_balance_currency" = w."currency"
        from "wallets" w
       where t."wallet_id" = w."id" and t."result_balance" is not null;
    `);
    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_result_currency_format"
        check (
          "result_balance_currency" is null
          or "result_balance_currency" ~ '^[A-Z]{3}$'
        );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_result_currency_format",
        drop column if exists "result_balance_currency";
    `);
  }
}
