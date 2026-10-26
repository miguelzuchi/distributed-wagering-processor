import { Migration } from '@mikro-orm/migrations';

export class Migration20261025000300 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "outbox_messages"
        add column "claim_token" uuid,
        add column "claim_until" timestamptz;
    `);
    this.addSql(`
      alter table "outbox_messages"
        add constraint "outbox_messages_claim_shape"
        check (
          ("claim_token" is null and "claim_until" is null)
          or ("claim_token" is not null and "claim_until" is not null)
        );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "outbox_messages"
        drop constraint if exists "outbox_messages_claim_shape",
        drop column if exists "claim_token",
        drop column if exists "claim_until";
    `);
  }
}
