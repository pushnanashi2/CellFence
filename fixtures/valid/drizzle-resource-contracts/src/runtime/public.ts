declare function pgTable(name: string, columns: unknown): unknown;
declare const db: {
  select(): {
    from(table: unknown): unknown;
  };
  insert(table: unknown): unknown;
  update(table: unknown): unknown;
  delete(table: unknown): unknown;
};

const users = pgTable("app_users", {});

export function runDrizzle(): void {
  db.select().from(users);
  db.insert(users);
  db.update(users);
  db.delete(users);
}
