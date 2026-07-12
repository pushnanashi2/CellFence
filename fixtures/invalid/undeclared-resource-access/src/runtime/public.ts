import fs from "node:fs";

declare function publish(topic: string, message: unknown): void;
declare const router: { get(path: string, handler: () => void): void };
declare function fetch(url: string): Promise<unknown>;
declare const connection: { query(sql: string): unknown };

export function runRuntime(): void {
  fs.readFileSync("data/config.json", "utf8");
  const readSql = connection.query("select * from app.users");
  publish("jobs.ready", readSql);
  router.get("/health", () => undefined);
  void fetch("https://api.example.test/v1/status");
}
