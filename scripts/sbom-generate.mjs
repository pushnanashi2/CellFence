import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const outputPath = path.join(process.cwd(), "reports", "sbom.cdx.json");
const result = spawnSync("npm", [
  "sbom",
  "--package-lock-only",
  "--sbom-format",
  "cyclonedx",
  "--sbom-type",
  "library",
], {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  throw new Error(`npm sbom failed\n${output}`);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, result.stdout);
console.log(`wrote ${outputPath}`);
