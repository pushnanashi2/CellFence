import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const scriptPath = path.join(root, "scripts", "precision-label-transfer.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "");
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function runTransfer(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function finding(id, patch = {}) {
  return {
    schemaVersion: "cellfence.corpus-finding.v1",
    studyId: "source-study",
    findingId: id,
    subjectId: "demo",
    repository: "https://github.com/example/demo.git",
    precisionEligible: true,
    ruleId: "CELLFENCE_PRIVATE_IMPORT",
    severity: "error",
    filePath: "src/demo.ts",
    message: "fixture",
    ...patch,
  };
}

function label(findingId, rater, round) {
  return {
    schemaVersion: "cellfence.corpus-label.v1",
    studyId: "source-study",
    findingId,
    rater,
    round,
    assignmentId: `${round}-${rater}-${findingId.slice(-6)}`,
    evidencePackageId: `evidence-${findingId.slice(-6)}`,
    sawPeerLabels: false,
    label: "true_positive",
    rationale: `${rater} fixture label`,
  };
}

function createBundle(baseDir, studyId, findings, labels = []) {
  const bundleDir = path.join(baseDir, studyId);
  writeJson(path.join(bundleDir, "study.json"), {
    schemaVersion: "cellfence.corpus-evidence-bundle.v1",
    studyId,
  });
  writeJson(path.join(bundleDir, "sampling.json"), {
    schemaVersion: "cellfence.corpus-sampling.v1",
    sampledFindingIds: findings.map((entry) => entry.findingId),
  });
  writeJsonl(path.join(bundleDir, "findings.normalized.jsonl"), findings.map((entry) => ({ ...entry, studyId })));
  writeJsonl(path.join(bundleDir, "labels.jsonl"), labels);
  return bundleDir;
}

test("precision label transfer rewrites study ids and drops disappeared findings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-transfer-"));
  try {
    const kept = finding("sha256:111111");
    const stale = finding("sha256:222222");
    const sourceBundle = createBundle(tempDir, "source-study", [kept, stale], [
      {
        ...label(kept.findingId, "reviewer-a", "blind_first"),
        confidence: 0.9,
        method: "historical note",
        transferredFrom: { studyId: "older-study" },
      },
      label(kept.findingId, "reviewer-b", "blind_second"),
      label(stale.findingId, "reviewer-a", "blind_first"),
    ]);
    const targetBundle = createBundle(tempDir, "target-study", [kept]);
    const labelsPath = path.join(tempDir, "transferred.labels.jsonl");
    const reportPath = path.join(tempDir, "transfer.report.json");

    const result = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--out",
      labelsPath,
      "--report",
      reportPath,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const labels = readJsonl(labelsPath);
    assert.equal(labels.length, 2);
    assert.equal(labels[0].studyId, "target-study");
    assert.equal(labels[0].transferredFrom, undefined);
    assert.equal(labels[0].confidence, undefined);
    assert.equal(labels[0].method, undefined);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.ok, true);
    assert.equal(report.transferredLabelSources[0].sourceStudyId, "source-study");
    assert.equal(report.summary.staleSourceFindings, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label transfer reports newly sampled target findings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-transfer-missing-"));
  try {
    const kept = finding("sha256:111111");
    const fresh = finding("sha256:333333", { ruleId: "CELLFENCE_UNDECLARED_CONSUMER" });
    const sourceBundle = createBundle(tempDir, "source-study", [kept], [
      label(kept.findingId, "reviewer-a", "blind_first"),
      label(kept.findingId, "reviewer-b", "blind_second"),
    ]);
    const targetBundle = createBundle(tempDir, "target-study", [kept, fresh]);
    const labelsPath = path.join(tempDir, "transferred.labels.jsonl");

    const result = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--out",
      labelsPath,
    ]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.summary.missingTargetFindings, 1);
    assert.equal(report.missingByRule.CELLFENCE_UNDECLARED_CONSUMER, 1);

    const partial = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--out",
      labelsPath,
      "--allow-partial",
    ]);
    assert.equal(partial.status, 0, partial.stderr || partial.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label transfer merges supplemental labels for new findings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-transfer-supplemental-"));
  try {
    const kept = finding("sha256:111111");
    const fresh = finding("sha256:333333", { ruleId: "CELLFENCE_UNDECLARED_RESOURCE_ACCESS" });
    const sourceBundle = createBundle(tempDir, "source-study", [kept], [
      label(kept.findingId, "reviewer-a", "blind_first"),
      label(kept.findingId, "reviewer-b", "blind_second"),
    ]);
    const targetBundle = createBundle(tempDir, "target-study", [kept, fresh]);
    const supplementalPath = path.join(tempDir, "supplemental.jsonl");
    writeJsonl(supplementalPath, [
      label(fresh.findingId, "reviewer-a", "blind_first"),
      label(fresh.findingId, "reviewer-b", "blind_second"),
    ]);
    const labelsPath = path.join(tempDir, "transferred.labels.jsonl");

    const result = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--out",
      labelsPath,
      "--supplemental-labels",
      supplementalPath,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.missingTargetFindings, 0);
    assert.equal(report.summary.supplementalLabels, 2);
    const labels = readJsonl(labelsPath);
    assert.equal(labels.filter((entry) => entry.findingId === fresh.findingId).length, 2);
    assert.equal(labels.at(-1).studyId, "target-study");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label transfer can stamp known rater provenance on transferred labels", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-transfer-rater-type-"));
  try {
    const kept = finding("sha256:111111");
    const sourceBundle = createBundle(tempDir, "source-study", [kept], [
      label(kept.findingId, "reviewer-a", "blind_first"),
      { ...label(kept.findingId, "reviewer-b", "blind_second"), raterType: "human" },
    ]);
    const targetBundle = createBundle(tempDir, "target-study", [kept]);
    const labelsPath = path.join(tempDir, "transferred.labels.jsonl");

    const result = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--out",
      labelsPath,
      "--default-rater-type",
      "agent",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.defaultRaterTypeApplied, "agent");
    const labels = readJsonl(labelsPath);
    const stamped = labels.find((entry) => entry.rater === "reviewer-a");
    const preserved = labels.find((entry) => entry.rater === "reviewer-b");
    assert.equal(stamped.raterType, "agent");
    assert.equal(preserved.raterType, "human");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
