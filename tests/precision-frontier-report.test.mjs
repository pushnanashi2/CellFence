import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const scriptPath = path.join(root, "scripts", "precision-frontier-report.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runFrontier(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function createClaimReport(tempDir) {
  const reportPath = path.join(tempDir, "claim-report.json");
  writeJson(reportPath, {
    schemaVersion: "cellfence.precision-claim-report.v1",
    protocol: {
      studyId: "fixture-reviewed",
      includedRules: ["CELLFENCE_PRIVATE_IMPORT", "CELLFENCE_UNDECLARED_CONSUMER"],
      minimumPrecision: 0.99,
      confidence: 0.95,
      blockingSeverities: ["error"],
      maxRepositoryContribution: 0.1,
      targetPopulation: "fixture reviewed corpus",
    },
    decision: {
      status: "insufficient_evidence",
      reason: "pooled occurrence lower bound is below target",
      observedBlockingPrecision: 1,
      oneSidedLowerBound: 0.5,
      target: 0.99,
      confidence: 0.95,
    },
    metrics: {
      occurrence: {
        blocking: {
          successes: 12,
          trials: 12,
          observedPrecision: 1,
          oneSidedLowerBound: 0.5,
        },
      },
      uniqueFingerprint: {
        blocking: {
          successes: 12,
          trials: 12,
          observedPrecision: 1,
          oneSidedLowerBound: 0.5,
        },
      },
      byRule: {
        CELLFENCE_PRIVATE_IMPORT: {
          blocking: {
            successes: 10,
            trials: 10,
            observedPrecision: 1,
            oneSidedLowerBound: 0.6,
          },
        },
        CELLFENCE_UNDECLARED_CONSUMER: {
          blocking: {
            successes: 2,
            trials: 2,
            observedPrecision: 1,
            oneSidedLowerBound: 0.2,
          },
        },
      },
      repositories: {
        repositoryMacroPrecision: 1,
        maxRepositoryContribution: 0.75,
        repositories: [
          {
            repository: "https://github.com/example/a.git",
            trials: 9,
            observedBlockingPrecision: 1,
            oneSidedLowerBound: 0.7,
          },
          {
            repository: "https://github.com/example/b.git",
            trials: 3,
            observedBlockingPrecision: 1,
            oneSidedLowerBound: 0.4,
          },
        ],
      },
    },
    claimGates: {
      failures: ["pooled occurrence lower bound is below target"],
    },
  });
  return reportPath;
}

function createCandidateBundle(tempDir) {
  const bundleDir = path.join(tempDir, "candidate-bundle");
  writeJson(path.join(bundleDir, "study.json"), {
    schemaVersion: "cellfence.corpus-evidence-bundle.v1",
    studyId: "candidate-infer",
    environment: {
      harnessCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      harnessDirty: false,
    },
    manifestCopies: [
      {
        subjectId: "candidate-a",
        path: "manifests/candidate-a.json",
        sha256: "b".repeat(64),
      },
    ],
  });
  writeJson(path.join(bundleDir, "sampling.json"), {
    schemaVersion: "cellfence.corpus-sampling.v1",
      sampledFindingIds: ["sha256:1".padEnd(71, "1"), "sha256:2".padEnd(71, "2"), "sha256:3".padEnd(71, "3")],
  });
  writeJsonl(path.join(bundleDir, "findings.normalized.jsonl"), [
    {
      schemaVersion: "cellfence.corpus-finding.v1",
      studyId: "candidate-infer",
      findingId: "sha256:1".padEnd(71, "1"),
      subjectId: "candidate-a",
      repository: "https://github.com/example/candidate-a.git",
      commit: "c".repeat(40),
      manifestStrategy: "infer",
      manifestReviewStatus: "generated",
      precisionEligible: true,
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      severity: "error",
      filePath: "src/a.ts",
      message: "private import",
    },
    {
      schemaVersion: "cellfence.corpus-finding.v1",
      studyId: "candidate-infer",
      findingId: "sha256:2".padEnd(71, "2"),
      subjectId: "candidate-a",
      repository: "https://github.com/example/candidate-a.git",
      commit: "c".repeat(40),
      manifestStrategy: "infer",
      manifestReviewStatus: "generated",
      precisionEligible: false,
      ruleId: "CELLFENCE_UNDECLARED_CONSUMER",
      severity: "error",
      filePath: "src/b.ts",
      message: "undeclared consumer",
    },
    {
      schemaVersion: "cellfence.corpus-finding.v1",
      studyId: "candidate-infer",
      findingId: "sha256:3".padEnd(71, "3"),
      subjectId: "candidate-a",
      repository: "https://github.com/example/candidate-a.git",
      commit: "c".repeat(40),
      manifestStrategy: "infer",
      manifestReviewStatus: "generated",
      precisionEligible: false,
      ruleId: "CELLFENCE_UNDECLARED_CONSUMER",
      severity: "warning",
      filePath: "src/warning.ts",
      message: "warning outside the blocking claim",
    },
  ]);
  return bundleDir;
}

test("precision frontier reports claim gaps and keeps infer candidates diagnostic", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-frontier-"));
  try {
    const claimReport = createClaimReport(tempDir);
    const candidateBundle = createCandidateBundle(tempDir);
    const outPath = path.join(tempDir, "frontier.json");
    const markdownPath = path.join(tempDir, "frontier.md");

    const result = runFrontier([
      "--reviewed-claim-report",
      claimReport,
      "--candidate-bundle",
      candidateBundle,
      "--out",
      outPath,
      "--markdown",
      markdownPath,
    ]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = readJson(outPath);
    assert.equal(report.schemaVersion, "cellfence.precision-frontier-report.v1");
    assert.equal(report.decision.status, "not_ready");
    assert.equal(report.protocol.zeroFalsePositiveRequiredTrials, 299);
    assert.deepEqual(report.candidatePool.includedSeverities, ["error"]);
    assert.equal(report.candidatePool.includedFindings, 2);
    assert.equal(report.candidatePool.sampledIncludedFindings, 2);
    assert.equal(report.candidatePool.claimReadyIncludedFindings, 0);
    assert.equal(report.candidatePool.rawPrecisionEligibleIncludedFindings, 1);
    assert.deepEqual(report.candidatePool.byRequirement, {
      reviewed_manifest_required: 2,
    });
    assert.equal(report.candidatePool.topSubjects[0].nextAction, "review_manifest_before_claim");
    assert.match(report.decision.blockers.join("\n"), /candidate bundle has included findings but none are claim-ready/);
    assert.match(fs.readFileSync(markdownPath, "utf8"), /Precision Claim Frontier/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
