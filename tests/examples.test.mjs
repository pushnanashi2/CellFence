import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkRepository } from "../packages/engine/dist/index.js";

const root = process.cwd();
const examplesRoot = path.join(root, "examples");

for (const entry of fs.readdirSync(examplesRoot, { withFileTypes: true }).filter((candidate) => candidate.isDirectory())) {
  const examplePath = path.join(examplesRoot, entry.name);
  const manifestPath = path.join(examplePath, "cellfence.manifest.json");
  if (!fs.existsSync(manifestPath)) continue;

  test(`example ${entry.name} passes CellFence check`, () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const rootedAtRepository = manifest.cells.some((cell) =>
      typeof cell.publicEntry === "string" && cell.publicEntry.startsWith(`examples/${entry.name}/`)
    );
    const result = rootedAtRepository
      ? checkRepository({ rootDir: root, manifestPath: path.relative(root, manifestPath) })
      : checkRepository({ rootDir: examplePath, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  });
}
