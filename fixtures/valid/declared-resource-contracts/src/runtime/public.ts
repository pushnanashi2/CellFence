import fs from "node:fs";

declare function publish(topic: string, message: unknown): void;
declare function subscribe(topic: string, handler: (message: unknown) => void): void;
declare const router: { get(path: string, handler: () => void): void };
declare function fetch(url: string): Promise<unknown>;
declare const connection: { query(sql: string): unknown };

export function runRuntime(): void {
  fs.readFileSync("data/config.json", "utf8");
  const users = connection.query("select * from app.users");
  const events = connection.query("insert into app.events (id) values (?)");
  publish("jobs.ready", { users, events });
  subscribe("jobs.done", () => undefined);
  router.get("/health", () => undefined);
  void fetch("https://api.example.test/v1/status");
}
