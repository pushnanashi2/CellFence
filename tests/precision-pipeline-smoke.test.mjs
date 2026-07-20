import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(".");
const scriptPath = path.join(repoRoot, "scripts", "precision-pipeline-smoke.mjs");

function runPrecisionSmoke(args, cwd = repoRoot) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

test("precision pipeline smoke builds, labels, validates, and reports insufficient evidence", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-pipeline-smoke-"));
  try {
    const outPath = path.join(rootDir, "smoke.json");
    const result = runPrecisionSmoke(["--workdir", path.join(rootDir, "work"), "--out", outPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /precision pipeline smoke passed/);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.schemaVersion, "cellfence.precision-pipeline-smoke.v1");
    assert.equal(report.normalizedFindings, 3);
    assert.equal(report.precisionEligibleSampledFindings, 3);
    assert.equal(report.decision.status, "insufficient_evidence");
    assert.equal(report.decision.observedBlockingPrecision, 1);
    assert.match(report.artifactSetSha256, /^[a-f0-9]{64}$/);
    assert.match(report.preLabelArtifactSetSha256, /^[a-f0-9]{64}$/);
    assert.match(report.worklistArtifactSetSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(report.preLabelArtifactSetSha256, report.artifactSetSha256);
    assert.equal(fs.existsSync(path.join(report.bundleDir, "SHA256SUMS")), true);
    assert.equal(fs.existsSync(path.join(report.worklistDir, "SHA256SUMS")), true);
    assert.equal(report.worklistSummary.selectedFindings, 3);
    assert.equal(report.worklistSummary.assignments, 6);
    assert.equal(fs.existsSync(report.reviewedCorpusReportPath), true);
    assert.equal(fs.existsSync(report.labelReadinessPath), true);
    const labelReadiness = JSON.parse(fs.readFileSync(report.labelReadinessPath, "utf8"));
    assert.equal(labelReadiness.ok, true);
    assert.equal(labelReadiness.summary.fullyLabeledFindings, 3);
    const protocol = JSON.parse(fs.readFileSync(report.protocolPath, "utf8"));
    assert.equal(protocol.claim.artifactSetSha256, report.artifactSetSha256);
    assert.equal(protocol.claim.preLabelArtifactSetSha256, report.preLabelArtifactSetSha256);
    assert.equal(protocol.claim.worklistArtifactSetSha256, report.worklistArtifactSetSha256);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("precision pipeline smoke rejects missing option values without deleting cwd children", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-pipeline-smoke-missing-"));
  try {
    const sentinelPath = path.join(rootDir, "run-sentinel", "sentinel.txt");
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, "do not delete");
    const result = runPrecisionSmoke(["--workdir"], rootDir);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--workdir requires a value/);
    assert.equal(fs.readFileSync(sentinelPath, "utf8"), "do not delete");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("precision pipeline smoke keeps existing workdir children intact", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-pipeline-smoke-safe-"));
  try {
    const workDir = path.join(rootDir, "work");
    const sentinelPath = path.join(workDir, "bundle-labeled", "sentinel.txt");
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, "do not delete");
    const result = runPrecisionSmoke(["--workdir", workDir, "--out", path.join(rootDir, "smoke.json")]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(sentinelPath, "utf8"), "do not delete");
    const runDirs = fs.readdirSync(workDir).filter((entry) => entry.startsWith("run-"));
    assert.equal(runDirs.length, 1);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
