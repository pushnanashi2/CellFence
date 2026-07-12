import fs from "node:fs";

export function runRuntime(): void {
  fs.readFileSync("data/config.json", "utf8");
  const sql = "select * from app.users";
  void sql;
}
