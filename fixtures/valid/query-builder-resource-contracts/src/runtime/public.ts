declare const db: {
  selectFrom(tableName: string): unknown;
  insertInto(tableName: string): unknown;
  updateTable(tableName: string): unknown;
  deleteFrom(tableName: string): unknown;
};

export function runQueries(): void {
  db.selectFrom("orders");
  db.insertInto("orders");
  db.updateTable("orders");
  db.deleteFrom("orders");
}
