import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const scriptPath = path.join(root, "scripts", "precision-bind-worklists.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function runBind(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function createWorklist(tempDir, name, body = "fixture") {
  const worklistDir = path.join(tempDir, name);
  fs.mkdirSync(worklistDir, { recursive: true });
  fs.writeFileSync(path.join(worklistDir, "worklist.json"), `${body}\n`);
  const worklistHash = crypto.createHash("sha256").update(`${body}\n`).digest("hex");
  fs.writeFileSync(path.join(worklistDir, "SHA256SUMS"), `${worklistHash}  worklist.json\n`);
  return worklistDir;
}

test("precision bind worklists writes worklist digests without mutating source protocol", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-bind-worklists-"));
  try {
    const protocolPath = path.join(tempDir, "protocol.json");
    const outPath = path.join(tempDir, "protocol.bound.json");
    writeJson(protocolPath, {
      schemaVersion: "cellfence.precision-claim-protocol.v1",
      studyId: "bind-fixture",
      claim: {
        includedRules: ["CELLFENCE_PRIVATE_IMPORT"],
        worklistArtifactSetSha256: "0".repeat(64),
      },
      worklistArtifactSetSha256s: ["1".repeat(64)],
      labelingPlan: {
        worklistArtifactSetSha256s: ["2".repeat(64)],
      },
    });
    const firstWorklist = createWorklist(tempDir, "first-worklist", "first");
    const secondWorklist = createWorklist(tempDir, "second-worklist", "second");

    const result = runBind([
      "--protocol",
      protocolPath,
      "--worklist",
      firstWorklist,
      "--worklist",
      secondWorklist,
      "--out",
      outPath,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const original = readJson(protocolPath);
    assert.equal(original.claim.worklistArtifactSetSha256, "0".repeat(64));
    const bound = readJson(outPath);
    assert.deepEqual(bound.claim.worklistArtifactSetSha256s, [
      hashFile(path.join(firstWorklist, "SHA256SUMS")),
      hashFile(path.join(secondWorklist, "SHA256SUMS")),
    ]);
    assert.equal(bound.claim.worklistArtifactSetSha256, undefined);
    assert.equal(bound.worklistArtifactSetSha256s, undefined);
    assert.equal(bound.labelingPlan.worklistArtifactSetSha256s, undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision bind worklists supports in-place updates", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-bind-worklists-in-place-"));
  try {
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, {
      schemaVersion: "cellfence.precision-claim-protocol.v1",
      studyId: "bind-fixture",
      claim: {
        includedRules: ["CELLFENCE_PRIVATE_IMPORT"],
      },
    });
    const worklistDir = createWorklist(tempDir, "worklist");

    const result = runBind([
      "--protocol",
      protocolPath,
      "--worklist",
      worklistDir,
      "--in-place",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const bound = readJson(protocolPath);
    assert.deepEqual(bound.claim.worklistArtifactSetSha256s, [
      hashFile(path.join(worklistDir, "SHA256SUMS")),
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision bind worklists rejects unsealed worklist directories", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-bind-worklists-unsealed-"));
  try {
    const protocolPath = path.join(tempDir, "protocol.json");
    const worklistDir = path.join(tempDir, "worklist");
    writeJson(protocolPath, {
      schemaVersion: "cellfence.precision-claim-protocol.v1",
      studyId: "bind-fixture",
      claim: {
        includedRules: ["CELLFENCE_PRIVATE_IMPORT"],
      },
    });
    fs.mkdirSync(worklistDir);

    const result = runBind([
      "--protocol",
      protocolPath,
      "--worklist",
      worklistDir,
      "--in-place",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /worklist SHA256SUMS is missing/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
