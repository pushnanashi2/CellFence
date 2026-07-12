declare const db: {
  select(): {
    from(table: unknown): unknown;
  };
};
declare const tableName: string;

export function runDrizzle(): unknown {
  return db.select().from(tableName);
}
