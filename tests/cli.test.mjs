import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const cliPath = path.join(root, "packages/cli/dist/index.js");

function runCli(args, cwd = root) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function runExecutable(command, args, cwd = root) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
  });
}

test("CLI check returns zero for a valid fixture", () => {
  const fixturePath = path.join(root, "fixtures/valid/single-cell");
  const result = runCli(["check", "--json"], fixturePath);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"ok": true/);
});

test("CLI check returns one for governance violations", () => {
  const fixturePath = path.join(root, "fixtures/invalid/private-cross-cell-import");
  const result = runCli(["check", "--json"], fixturePath);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CELLFENCE_PRIVATE_IMPORT/);
});

test("CLI check returns two for manifest configuration errors", () => {
  const fixturePath = path.join(root, "fixtures/invalid/malformed-manifest");
  const result = runCli(["check", "--json"], fixturePath);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /CELLFENCE_MANIFEST_INVALID/);
});

test("CLI evidence check accepts baseline-approved runtime evidence", () => {
  const fixturePath = path.join(root, "fixtures/valid/resource-evidence-baseline");
  const result = runCli(["evidence", "check", "--evidence", "resource-evidence.json", "--json"], fixturePath);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"ok": true/);
});

test("CLI evidence check rejects new runtime resource evidence", () => {
  const fixturePath = path.join(root, "fixtures/invalid/resource-evidence-detects-new");
  const result = runCli(["evidence", "check", "--evidence", "resource-evidence.json", "--json"], fixturePath);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CELLFENCE_UNDECLARED_RESOURCE_ACCESS/);
});

test("CLI baseline create stores runtime evidence inventory", () => {
  const fixturePath = path.join(root, "fixtures/valid/resource-evidence-baseline");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-evidence-"));
  fs.cpSync(fixturePath, tempDir, { recursive: true });
  fs.rmSync(path.join(tempDir, "cellfence.baseline.json"));

  const result = runCli(["baseline", "create", "--evidence", "resource-evidence.json"], tempDir);
  assert.equal(result.status, 0);

  const baseline = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.baseline.json"), "utf8"));
  assert.deepEqual(baseline.cells.runtime.resourceAccesses, [
    {
      kind: "database",
      access: "read",
      selector: "runtime.orders",
      detectedBy: "runtime-evidence",
      confidence: "runtime",
    },
  ]);
});

test("CLI baseline create stores Prisma delegate inventory", () => {
  const fixturePath = path.join(root, "fixtures/valid/prisma-resource-baseline");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-prisma-"));
  fs.cpSync(fixturePath, tempDir, { recursive: true });
  fs.rmSync(path.join(tempDir, "cellfence.baseline.json"));

  const result = runCli(["baseline", "create"], tempDir);
  assert.equal(result.status, 0);

  const baseline = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.baseline.json"), "utf8"));
  assert.deepEqual(baseline.cells.runtime.resourceAccesses, [
    {
      kind: "database",
      access: "read",
      selector: "app_users",
      detectedBy: "prisma-adapter",
      confidence: "high",
    },
    {
      kind: "database",
      access: "write",
      selector: "app_users",
      detectedBy: "prisma-adapter",
      confidence: "high",
    },
  ]);
});

test("CLI baseline create stores BullMQ and KafkaJS inventory", () => {
  const fixturePath = path.join(root, "fixtures/valid/event-adapters-declared");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-events-"));
  fs.cpSync(fixturePath, tempDir, { recursive: true });

  const result = runCli(["baseline", "create"], tempDir);
  assert.equal(result.status, 0);

  const baseline = JSON.parse(fs.readFileSync(path.join(tempDir, "cellfence.baseline.json"), "utf8"));
  assert.deepEqual(baseline.cells.runtime.resourceAccesses, [
    {
      kind: "queue",
      access: "publish",
      selector: "bullmq:nightly-research",
      detectedBy: "bullmq-adapter",
      confidence: "high",
    },
    {
      kind: "queue",
      access: "publish",
      selector: "kafka:research.events",
      detectedBy: "kafkajs-adapter",
      confidence: "medium",
    },
    {
      kind: "queue",
      access: "subscribe",
      selector: "bullmq:nightly-research",
      detectedBy: "bullmq-adapter",
      confidence: "high",
    },
    {
      kind: "queue",
      access: "subscribe",
      selector: "kafka:research.events",
      detectedBy: "kafkajs-adapter",
      confidence: "medium",
    },
  ]);
});

test("CLI exits nonzero when executed through a node_modules bin symlink", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-bin-"));
  const binDir = path.join(tempDir, "node_modules/.bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, "cellfence");
  fs.symlinkSync(cliPath, binPath);

  const fixturePath = path.join(root, "fixtures/invalid/private-cross-cell-import");
  const result = runExecutable(process.execPath, [binPath, "check", "--json"], fixturePath);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CELLFENCE_PRIVATE_IMPORT/);
});

test("CLI package import has no command execution side effect", () => {
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import ${JSON.stringify(pathToFileURL(cliPath).href)}; console.log("import-ok");`,
  ], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "import-ok");
  assert.equal(result.stderr.trim(), "");
});
