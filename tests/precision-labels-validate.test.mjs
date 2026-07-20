import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const scriptPath = path.join(root, "scripts", "precision-labels-validate.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "");
}

function runValidator(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function finding(id, patch = {}) {
  return {
    schemaVersion: "cellfence.corpus-finding.v1",
    studyId: "label-fixture",
    findingId: `sha256:${id.repeat(64).slice(0, 64)}`,
    subjectId: "demo",
    repository: "https://github.com/example/demo.git",
    precisionEligible: true,
    ruleId: "CELLFENCE_PRIVATE_IMPORT",
    severity: "error",
    ...patch,
  };
}

function label(findingId, rater, value, patch = {}) {
  const isAdjudication = patch.role === "adjudicator" || patch.adjudication === true || patch.adjudicated === true;
  const round = patch.round || (isAdjudication ? "adjudication" : rater.endsWith("-b") ? "blind_second" : "blind_first");
  return {
    schemaVersion: "cellfence.corpus-label.v1",
    studyId: "label-fixture",
    findingId,
    rater,
    round,
    assignmentId: `${round}-${rater}-${findingId.slice("sha256:".length, "sha256:".length + 8)}`,
    evidencePackageId: `evidence-${findingId.slice("sha256:".length, "sha256:".length + 8)}`,
    sawPeerLabels: isAdjudication ? true : false,
    label: value,
    rationale: `${rater} fixture rationale`,
    ...patch,
  };
}

function createBundle(tempDir, labels) {
  const bundleDir = path.join(tempDir, "bundle");
  const findings = [finding("a"), finding("b")];
  writeJson(path.join(bundleDir, "study.json"), {
    schemaVersion: "cellfence.corpus-evidence-bundle.v1",
    studyId: "label-fixture",
  });
  writeJson(path.join(bundleDir, "sampling.json"), {
    schemaVersion: "cellfence.corpus-sampling.v1",
    sampledFindingIds: findings.map((entry) => entry.findingId),
  });
  writeJsonl(path.join(bundleDir, "findings.normalized.jsonl"), findings);
  writeJsonl(path.join(bundleDir, "labels.jsonl"), labels(findings));
  return { bundleDir, findings };
}

test("precision labels validator accepts independent labels plus separate adjudication", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-ok-"));
  try {
    const { bundleDir } = createBundle(tempDir, (findings) => [
      label(findings[0].findingId, "reviewer-a", "true_positive"),
      label(findings[0].findingId, "reviewer-b", "true_positive"),
      label(findings[1].findingId, "reviewer-a", "true_positive"),
      label(findings[1].findingId, "reviewer-b", "false_positive"),
      label(findings[1].findingId, "adjudicator-c", "needs_policy", { role: "adjudicator" }),
    ]);

    const result = runValidator(["--bundle", bundleDir]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.summary.fullyLabeledFindings, 2);
    assert.equal(report.summary.adjudicatedFindings, 1);
    assert.equal(report.summary.finalLabelCounts.true_positive, 1);
    assert.equal(report.summary.finalLabelCounts.needs_policy, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects independent labels without blind metadata", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-blind-missing-"));
  try {
    const { bundleDir } = createBundle(tempDir, (findings) => [
      {
        schemaVersion: "cellfence.corpus-label.v1",
        studyId: "label-fixture",
        findingId: findings[0].findingId,
        rater: "reviewer-a",
        label: "true_positive",
        rationale: "missing blind fields",
      },
      label(findings[0].findingId, "reviewer-b", "true_positive"),
      label(findings[1].findingId, "reviewer-a", "true_positive"),
      label(findings[1].findingId, "reviewer-b", "true_positive"),
    ]);

    const result = runValidator(["--bundle", bundleDir]);

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /missing assignmentId|independent label must use round/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects two first-round labels for the same finding", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-two-first-"));
  try {
    const { bundleDir } = createBundle(tempDir, (findings) => [
      label(findings[0].findingId, "reviewer-a", "true_positive", { round: "blind_first" }),
      label(findings[0].findingId, "reviewer-b", "true_positive", { round: "blind_first" }),
      label(findings[1].findingId, "reviewer-a", "true_positive"),
      label(findings[1].findingId, "reviewer-b", "true_positive"),
    ]);

    const result = runValidator(["--bundle", bundleDir]);

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /exactly one blind_first and one blind_second/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects second-round labels that saw peer labels", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-peer-visible-"));
  try {
    const { bundleDir } = createBundle(tempDir, (findings) => [
      label(findings[0].findingId, "reviewer-a", "true_positive"),
      label(findings[0].findingId, "reviewer-b", "true_positive", { sawPeerLabels: true }),
      label(findings[1].findingId, "reviewer-a", "true_positive"),
      label(findings[1].findingId, "reviewer-b", "true_positive"),
    ]);

    const result = runValidator(["--bundle", bundleDir]);

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /sawPeerLabels=false/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects incomplete independent labeling", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-missing-"));
  try {
    const { bundleDir } = createBundle(tempDir, (findings) => [
      label(findings[0].findingId, "reviewer-a", "true_positive"),
      label(findings[1].findingId, "reviewer-a", "true_positive"),
      label(findings[1].findingId, "reviewer-b", "true_positive"),
    ]);

    const result = runValidator(["--bundle", bundleDir]);

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.match(report.issues.join("\n"), /1 independent labels; 2 required/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
