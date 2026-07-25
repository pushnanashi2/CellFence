import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(".");
const scriptPath = path.join(repoRoot, "scripts", "public-surface-replay-smoke.mjs");

function runSmoke(args, cwd = repoRoot) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

test("public surface replay smoke seals a rule-scoped next-cycle packet", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-public-surface-replay-smoke-"));
  let report;
  try {
    const outPath = path.join(rootDir, "smoke.json");
    const result = runSmoke([
      "--subjects",
      "3",
      "--workdir",
      path.join(rootDir, "work"),
      "--out",
      outPath,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /public surface replay smoke passed/);
    report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.schemaVersion, "cellfence.public-surface-replay-smoke.v1");
    assert.match(report.limitation, /synthetic mechanism validation/);
    assert.equal(report.subjects, 3);
    assert.equal(report.ruleId, "CELLFENCE_PUBLIC_SYMBOL_MISMATCH");
    assert.equal(report.history.replayed, 3);
    assert.equal(report.history.singleCommitIntroductions, 3);
    assert.equal(report.history.introducedFindingsByRule.CELLFENCE_PUBLIC_SYMBOL_MISMATCH, 3);
    assert.deepEqual(report.nextCycle.includedRules, ["CELLFENCE_PUBLIC_SYMBOL_MISMATCH"]);
    assert.equal(report.nextCycle.selectedFindings, 3);
    assert.equal(report.nextCycle.assignments, 6);
    assert.equal(report.nextCycle.preflightValid, true);
    assert.equal(report.nextCycle.claimReady, false);
    assert.equal(report.normalizedFindings, 3);
    assert.match(report.nextCycle.unlabeledBundleArtifactSetSha256, /^[a-f0-9]{64}$/);
    assert.match(report.nextCycle.blindWorklistArtifactSetSha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(path.join(report.bundleDir, "SHA256SUMS")), true);
    assert.equal(fs.existsSync(path.join(report.blindWorklistDir, "SHA256SUMS")), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    if (report?.cycleDir) fs.rmSync(report.cycleDir, { recursive: true, force: true });
  }
});

test("public surface replay smoke rejects invalid subject counts before writing output", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-public-surface-replay-smoke-bad-"));
  try {
    const outPath = path.join(rootDir, "smoke.json");
    const result = runSmoke([
      "--subjects",
      "0",
      "--workdir",
      path.join(rootDir, "work"),
      "--out",
      outPath,
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--subjects must be an integer/);
    assert.equal(fs.existsSync(outPath), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("public surface replay smoke keeps existing workdir children intact", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-public-surface-replay-smoke-safe-"));
  let report;
  try {
    const workDir = path.join(rootDir, "work");
    const sentinelPath = path.join(workDir, "existing", "sentinel.txt");
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, "do not delete");
    const outPath = path.join(rootDir, "smoke.json");
    const result = runSmoke([
      "--subjects",
      "1",
      "--workdir",
      workDir,
      "--out",
      outPath,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(sentinelPath, "utf8"), "do not delete");
    const runDirs = fs.readdirSync(workDir).filter((entry) => entry.startsWith("run-"));
    assert.equal(runDirs.length, 1);
    report = JSON.parse(fs.readFileSync(outPath, "utf8"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    if (report?.cycleDir) fs.rmSync(report.cycleDir, { recursive: true, force: true });
  }
});
