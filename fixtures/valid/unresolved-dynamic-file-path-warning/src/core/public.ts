import fs from "node:fs";

export function readConfig(name: string): string {
  return fs.readFileSync(`data/${name}.json`, "utf8");
}
