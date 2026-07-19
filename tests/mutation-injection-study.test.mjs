import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function runMutationStudy(args) {
  return spawnSync(process.execPath, ["scripts/mutation-injection-study.mjs", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

test("mutation injection study detects all built-in synthetic violations", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-mutation-injection-"));
  try {
    const outPath = path.join(rootDir, "report.json");
    const result = runMutationStudy(["--workdir", path.join(rootDir, "work"), "--out", outPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.schemaVersion, "cellfence.mutation-injection-study.v1");
    assert.equal(report.summary.total, 7);
    assert.equal(report.summary.executed, 7);
    assert.equal(report.summary.detected, 7);
    assert.equal(report.summary.missed, 0);
    assert.equal(report.summary.recall, 1);
    assert.match(report.evidenceSetSha256, /^[a-f0-9]{64}$/);

    const expectedRules = new Set([
      "CELLFENCE_PRIVATE_IMPORT",
      "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
      "CELLFENCE_RATCHET_PUBLIC_SYMBOL_GROWTH",
      "CELLFENCE_RATCHET_PUBLIC_SYMBOL_SET_CHANGE",
      "CELLFENCE_UNDECLARED_CONSUMER",
      "CELLFENCE_UNDECLARED_RESOURCE_ACCESS",
      "CELLFENCE_UNOWNED_SOURCE",
      "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
    ]);
    assert.deepEqual(new Set(Object.keys(report.summary.byRule)), expectedRules);

    for (const mutation of report.mutations) {
      assert.equal(mutation.status, "detected_expected_rules", mutation.id);
      assert.deepEqual(mutation.missingRuleIds, []);
      assert.match(mutation.manifestSha256, /^[a-f0-9]{64}$/);
      assert.ok(fs.existsSync(path.join(mutation.subjectDir, "logs", "check.stdout.log")));
      assert.ok(fs.existsSync(path.join(mutation.subjectDir, "logs", "check.audit.jsonl")));
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("mutation injection study can dry-run and select templates", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-mutation-injection-dry-"));
  try {
    const outPath = path.join(rootDir, "report.json");
    const sentinelPath = path.join(rootDir, "work", "private-import", "sentinel.txt");
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, "keep me");

    const result = runMutationStudy([
      "--workdir",
      path.join(rootDir, "work"),
      "--out",
      outPath,
      "--dry-run",
      "--template",
      "private-import,unowned-source",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.dryRun, true);
    assert.equal(report.summary.total, 2);
    assert.equal(report.summary.planned, 2);
    assert.equal(report.summary.executed, 0);
    assert.equal(report.summary.recall, null);
    assert.deepEqual(report.mutations.map((mutation) => mutation.id), ["private-import", "unowned-source"]);
    assert.ok(report.mutations.every((mutation) => mutation.status === "planned"));
    assert.equal(fs.readFileSync(sentinelPath, "utf8"), "keep me");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("mutation injection study rejects unknown templates", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-mutation-injection-bad-"));
  try {
    const result = runMutationStudy([
      "--workdir",
      path.join(rootDir, "work"),
      "--out",
      path.join(rootDir, "report.json"),
      "--template",
      "missing-template",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown mutation template/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
