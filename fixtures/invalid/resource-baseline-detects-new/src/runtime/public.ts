import fs from "node:fs";

declare const connection: { query(sql: string): unknown };

export function runRuntime(): void {
  fs.readFileSync("data/config.json", "utf8");
  connection.query("select * from app.new_table");
}
