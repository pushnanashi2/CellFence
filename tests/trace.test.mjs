import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const tracePath = path.join(root, "packages/trace/dist/index.js");

test("trace hook emits runtime file resource evidence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-trace-"));
  fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "data/input.json"), "{\"ok\":true}\n");
  fs.writeFileSync(path.join(tempDir, "app.mjs"), `
    import fs from "node:fs";
    fs.readFileSync("data/input.json", "utf8");
    fs.writeFileSync("data/output.json", "{}\\n");
  `);

  const evidencePath = path.join(tempDir, "resource-evidence.json");
  const result = spawnSync(process.execPath, [
    "--import",
    pathToFileURL(tracePath).href,
    "app.mjs",
  ], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_TRACE_CELL: "runtime",
      CELLFENCE_TRACE_OUT: evidencePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.equal(evidence.schemaVersion, "cellfence.resource-evidence.v1");
  assert.equal(evidence.cellId, "runtime");
  assert.deepEqual(evidence.accesses, [
    {
      kind: "file",
      access: "read",
      selector: "data/input.json",
      cellId: "runtime",
      detectedBy: "cellfence-trace",
      confidence: "runtime",
    },
    {
      kind: "file",
      access: "write",
      selector: "data/output.json",
      cellId: "runtime",
      detectedBy: "cellfence-trace",
      confidence: "runtime",
    },
  ]);
});
