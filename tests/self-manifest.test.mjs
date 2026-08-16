import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { validateManifest } from "../packages/schema/dist/index.js";

const root = process.cwd();

function readSelfManifest() {
  return JSON.parse(fs.readFileSync(path.join(root, "cellfence.manifest.json"), "utf8"));
}

function readBuiltInResourceAdapters() {
  const schemaSource = fs.readFileSync(path.join(root, "packages/schema/src/index.ts"), "utf8");
  const union = schemaSource.match(/export type BuiltInResourceAdapter =([\s\S]*?);/);
  assert.ok(union, "BuiltInResourceAdapter union must exist in schema source");
  return [...union[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

test("CellFence self manifest keeps built-in resource adapters enabled", () => {
  const manifest = readSelfManifest();
  const builtInResourceAdapters = readBuiltInResourceAdapters();
  const validation = validateManifest(manifest);
  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.deepEqual(Object.keys(manifest.governance.resourceAdapters).sort(), [...builtInResourceAdapters].sort());
  for (const adapter of builtInResourceAdapters) {
    assert.equal(
      manifest.governance.resourceAdapters[adapter],
      "on",
      `self manifest must exercise the built-in ${adapter} resource adapter`,
    );
  }
});

test("CellFence self manifest declares detected self resource accesses", () => {
  const manifest = readSelfManifest();
  const engine = manifest.cells.find((cell) => cell.id === "engine");
  const baselineGate = manifest.cells.find((cell) => cell.id === "github-action-baseline-gate");
  assert.ok(engine);
  assert.ok(baselineGate);
  const engineSelectors = engine.resourceContracts.flatMap((contract) => contract.selectors);
  assert.ok(engineSelectors.includes("/proc/sys/kernel/random/boot_id"));
  assert.ok(engineSelectors.includes("unresolved:dynamic-file-path"));
  assert.ok(baselineGate.resourceContracts.some((contract) =>
    contract.kind === "file"
      && contract.access.includes("read")
      && contract.selectors.includes("unresolved:dynamic-file-path")));
});
