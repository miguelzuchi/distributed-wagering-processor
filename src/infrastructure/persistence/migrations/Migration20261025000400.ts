import { Migration } from '@mikro-orm/migrations';

export class Migration20261025000400 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "inbox_messages"
        add column "status" varchar(16) not null default 'PENDING',
        add column "failure_reason" varchar(200);
    `);
    this.addSql(`
      update "inbox_messages"
         set "status" = 'PROCESSED'
       where "processed_at" is not null;
    `);
    this.addSql(`
      alter table "inbox_messages"
        add constraint "inbox_messages_status_valid"
          check ("status" in ('PENDING', 'PROCESSED', 'REJECTED')),
        add constraint "inbox_messages_terminal_shape"
          check (
            ("status" = 'PENDING' and "processed_at" is null and "failure_reason" is null)
            or ("status" = 'PROCESSED' and "processed_at" is not null and "failure_reason" is null)
            or ("status" = 'REJECTED' and "processed_at" is not null and "failure_reason" is not null)
          );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "inbox_messages"
        drop constraint if exists "inbox_messages_terminal_shape",
        drop constraint if exists "inbox_messages_status_valid",
        drop column if exists "failure_reason",
        drop column if exists "status";
    `);
  }
}
