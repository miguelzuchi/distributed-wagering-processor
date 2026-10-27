import { Migration } from '@mikro-orm/migrations';

export class Migration20261025000500 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "operational_counters" (
        "name" varchar(100) primary key,
        "value" bigint not null default 0,
        constraint "operational_counters_value_non_negative" check ("value" >= 0)
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "operational_counters";');
  }
}
