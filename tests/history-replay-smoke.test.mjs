import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(".");

function runHistoryReplaySmoke(args) {
  return spawnSync(process.execPath, [path.join(repoRoot, "scripts", "history-replay-smoke.mjs"), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

function runHistoryReplaySmokeFrom(cwd, args) {
  return spawnSync(process.execPath, [path.join(repoRoot, "scripts", "history-replay-smoke.mjs"), ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

test("history replay smoke creates a local exact-commit replay report", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-history-replay-smoke-"));
  try {
    const outPath = path.join(rootDir, "report.json");
    const result = runHistoryReplaySmoke(["--workdir", path.join(rootDir, "work"), "--out", outPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /history replay smoke passed/);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.schemaVersion, "cellfence.history-replay-study.v1");
    assert.equal(report.summary.replayed, 1);
    assert.equal(report.summary.singleCommitIntroductions, 1);
    assert.equal(report.summary.expectations.passed, 1);
    assert.equal(report.subjects[0].proofEligibility, "counterfactual_candidate_requires_manual_label");
    assert.equal(report.subjects[0].introducedFindingsByRule.CELLFENCE_PRIVATE_IMPORT, 1);
    assert.ok(report.subjects[0].baselineReplay.check.findingsByRule.CELLFENCE_PRIVATE_IMPORT >= 1);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("history replay smoke rejects unknown arguments before writing output", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-history-replay-smoke-bad-"));
  try {
    const outPath = path.join(rootDir, "report.json");
    const result = runHistoryReplaySmoke(["--workdir", path.join(rootDir, "work"), "--out", outPath, "--surprise"]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown argument/);
    assert.equal(fs.existsSync(outPath), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("history replay smoke rejects missing option values without touching cwd-like workdirs", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-history-replay-smoke-missing-"));
  try {
    const sentinelPath = path.join(rootDir, "source", "sentinel.txt");
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, "do not delete");
    const result = runHistoryReplaySmokeFrom(rootDir, ["--workdir"]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--workdir requires a value/);
    assert.equal(fs.readFileSync(sentinelPath, "utf8"), "do not delete");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("history replay smoke does not delete existing workdir children", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-history-replay-smoke-safe-"));
  try {
    const workDir = path.join(rootDir, "work");
    const sentinelPath = path.join(workDir, "source", "sentinel.txt");
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, "do not delete");
    const result = runHistoryReplaySmoke(["--workdir", workDir, "--out", path.join(rootDir, "report.json")]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(sentinelPath, "utf8"), "do not delete");
    const runDirs = fs.readdirSync(workDir).filter((entry) => entry.startsWith("run-"));
    assert.equal(runDirs.length, 1);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
