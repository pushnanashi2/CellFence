import fs from "node:fs";

declare function publish(topic: string, message: unknown): void;
declare function subscribe(topic: string, handler: (message: unknown) => void): void;
declare const router: { get(path: string, handler: () => void): void };
declare function fetch(url: string): Promise<unknown>;

export function runRuntime(): void {
  fs.readFileSync("data/config.json", "utf8");
  const readSql = "select * from app.users";
  const writeSql = "insert into app.events (id) values (?)";
  publish("jobs.ready", { readSql, writeSql });
  subscribe("jobs.done", () => undefined);
  router.get("/health", () => undefined);
  void fetch("https://api.example.test/v1/status");
}
