import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const scriptPath = path.join(root, "scripts/corpus-precision-claim.mjs");

function runClaim(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "");
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listFiles(baseDir) {
  const files = [];
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath));
    else if (entry.isFile() && entry.name !== "SHA256SUMS") files.push(fullPath);
  }
  return files.sort();
}

function writeSha256Sums(bundleDir) {
  const lines = listFiles(bundleDir).map((filePath) => {
    const relativePath = path.relative(bundleDir, filePath).replace(/\\/g, "/");
    return `${hashFile(filePath)}  ${relativePath}`;
  });
  fs.writeFileSync(path.join(bundleDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

function createFinding(index, patch = {}) {
  const subjectNumber = (index % 20) + 1;
  const ruleId = index % 2 === 0 ? "CELLFENCE_PRIVATE_IMPORT" : "CELLFENCE_UNDECLARED_CONSUMER";
  return {
    schemaVersion: "cellfence.corpus-finding.v1",
    studyId: "fixture-claim",
    findingId: `sha256:${String(index).padStart(64, "0")}`,
    occurrenceIndex: 0,
    subjectId: `subject-${subjectNumber}`,
    repository: `https://github.com/example/subject-${subjectNumber}.git`,
    commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    gitTree: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    manifestSha256: "c".repeat(64),
    manifestStrategy: "copy",
    manifestReviewStatus: "reviewed",
    precisionEligible: true,
    ruleId,
    severity: "error",
    filePath: `src/consumer-${index}/use.ts`,
    line: 1,
    message: "fixture finding",
    cellfenceFingerprint: `fingerprint-${index}`,
    cellId: "consumer",
    producerCellId: "producer",
    outcome: "rejected",
    ...patch,
  };
}

function labelsFor(findings, label = "true_positive") {
  return findings.flatMap((finding) => [
    {
      schemaVersion: "cellfence.corpus-label.v1",
      studyId: "fixture-claim",
      findingId: finding.findingId,
      rater: "reviewer-a",
      label,
      rationale: "independent fixture label a",
    },
    {
      schemaVersion: "cellfence.corpus-label.v1",
      studyId: "fixture-claim",
      findingId: finding.findingId,
      rater: "reviewer-b",
      label,
      rationale: "independent fixture label b",
    },
  ]);
}

function createBundle(tempDir, findings, labels) {
  const bundleDir = path.join(tempDir, "bundle");
  fs.mkdirSync(bundleDir, { recursive: true });
  writeJson(path.join(bundleDir, "study.json"), {
    schemaVersion: "cellfence.corpus-evidence-bundle.v1",
    studyId: "fixture-claim",
    createdAt: "2026-07-18T00:00:00.000Z",
    environment: {
      harnessCommit: "dddddddddddddddddddddddddddddddddddddddd",
    },
    summary: {
      normalizedFindings: findings.length,
      sampledFindings: findings.length,
    },
  });
  writeJson(path.join(bundleDir, "corpus.json"), {
    schemaVersion: "cellfence.corpus.v1",
    subjects: [],
  });
  writeJson(path.join(bundleDir, "report.json"), {
    schemaVersion: "cellfence.corpus-study.v1",
    subjects: [],
  });
  writeJson(path.join(bundleDir, "sampling.json"), {
    schemaVersion: "cellfence.corpus-sampling.v1",
    seed: "sha256:fixture",
    sampledFindingIds: findings.map((finding) => finding.findingId),
  });
  writeJsonl(path.join(bundleDir, "findings.normalized.jsonl"), findings);
  writeJsonl(path.join(bundleDir, "findings.sampled.jsonl"), findings);
  writeJsonl(path.join(bundleDir, "labels.jsonl"), labels);
  writeSha256Sums(bundleDir);
  return bundleDir;
}

function createProtocol(tempDir, patch = {}) {
  const protocolPath = path.join(tempDir, "protocol.json");
  writeJson(protocolPath, {
    schemaVersion: "cellfence.precision-claim-protocol.v1",
    studyId: "fixture-claim",
    claim: {
      toolCommit: "dddddddddddddddddddddddddddddddddddddddd",
      targetPopulation: "reviewed TS/JS workspace repositories",
      supportedSyntaxProfile: "ts-js-supported-v1",
      includedRules: [
        "CELLFENCE_PRIVATE_IMPORT",
        "CELLFENCE_UNDECLARED_CONSUMER",
      ],
      primaryMetric: "blocking_precision",
      minimumPrecision: 0.99,
      confidence: 0.95,
    },
    samplingPlan: {
      maxRepositoryContribution: 0.1,
    },
    labelingPlan: {
      minimumIndependentRaters: 2,
      requireAdjudicationForDisagreements: true,
    },
    ...patch,
  });
  return protocolPath;
}

test("corpus precision claim passes only when the lower confidence bound clears the protocol threshold", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-pass-"));
  try {
    const findings = Array.from({ length: 299 }, (_, index) => createFinding(index));
    const bundleDir = createBundle(tempDir, findings, labelsFor(findings));
    const protocolPath = createProtocol(tempDir);

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "pass");
    assert.equal(report.metrics.occurrence.blocking.trials, 299);
    assert.equal(report.metrics.powerAnalysis.zeroFalsePositiveRequiredTrials, 299);
    assert.ok(report.decision.oneSidedLowerBound >= 0.99);
    assert.equal(report.metrics.repositories.maxRepositoryContribution <= 0.1, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim reports insufficient evidence for a perfect but underpowered sample", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-short-"));
  try {
    const findings = Array.from({ length: 50 }, (_, index) => createFinding(index));
    const bundleDir = createBundle(tempDir, findings, labelsFor(findings));
    const protocolPath = createProtocol(tempDir, {
      samplingPlan: {
        maxRepositoryContribution: 1,
      },
    });

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "insufficient_evidence");
    assert.equal(report.metrics.occurrence.blocking.observedPrecision, 1);
    assert.ok(report.decision.oneSidedLowerBound < 0.99);
    assert.match(report.labelQuality.warnings.join("\n"), /zero observed blocking failures/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim requires independent labels and adjudicates disagreements", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-labels-"));
  try {
    const findings = [createFinding(0)];
    const labels = [
      {
        schemaVersion: "cellfence.corpus-label.v1",
        studyId: "fixture-claim",
        findingId: findings[0].findingId,
        rater: "reviewer-a",
        label: "true_positive",
        rationale: "first opinion",
      },
      {
        schemaVersion: "cellfence.corpus-label.v1",
        studyId: "fixture-claim",
        findingId: findings[0].findingId,
        rater: "reviewer-b",
        label: "false_positive",
        rationale: "second opinion",
      },
    ];
    const bundleDir = createBundle(tempDir, findings, labels);
    const protocolPath = createProtocol(tempDir, {
      claim: {
        includedRules: ["CELLFENCE_PRIVATE_IMPORT"],
        primaryMetric: "blocking_precision",
        minimumPrecision: 0.5,
        confidence: 0.95,
      },
      samplingPlan: {
        maxRepositoryContribution: 1,
      },
    });

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "invalid");
    assert.match(report.labelQuality.issues.join("\n"), /conflicting labels and no adjudication/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim counts needs_policy as semantic success but blocking failure", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-needs-policy-"));
  try {
    const findings = [createFinding(0), createFinding(1)];
    const labels = [
      ...labelsFor([findings[0]], "true_positive"),
      ...labelsFor([findings[1]], "needs_policy"),
    ];
    const bundleDir = createBundle(tempDir, findings, labels);
    const protocolPath = createProtocol(tempDir, {
      samplingPlan: {
        maxRepositoryContribution: 1,
      },
    });

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.metrics.occurrence.blocking.successes, 1);
    assert.equal(report.metrics.occurrence.blocking.trials, 2);
    assert.equal(report.metrics.occurrence.blocking.observedPrecision, 0.5);
    assert.equal(report.metrics.occurrence.semanticCorrectness.successes, 2);
    assert.equal(report.metrics.occurrence.semanticCorrectness.observedPrecision, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
