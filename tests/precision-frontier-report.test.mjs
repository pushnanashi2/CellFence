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
      requireExternalIndependentRaters: true,
      externalRaterTypes: ["human", "organization"],
      minimumExternalIndependentRaters: 1,
      requireExternalManifestReview: true,
      allowedManifestReviewerTypes: ["human", "organization"],
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
  writeJson(path.join(bundleDir, "corpus.json"), {
    schemaVersion: "cellfence.corpus.v1",
    subjects: [
      {
        id: "candidate-a",
        repository: "https://github.com/example/candidate-a.git",
        commit: "c".repeat(40),
        manifest: {
          strategy: "infer",
          reviewStatus: "generated",
        },
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
    assert.equal(report.candidatePool.claimPreflightRequiredIncludedFindings, 0);
    assert.equal(report.candidatePool.rawPrecisionEligibleIncludedFindings, 1);
    assert.deepEqual(report.candidatePool.byRequirement, {
      reviewed_manifest_required: 2,
    });
    assert.equal(report.candidatePool.topSubjects[0].nextAction, "review_manifest_before_claim");
    assert.match(report.decision.blockers.join("\n"), /candidate bundle has included findings but none have reached the claim-preflight-required state/);
    assert.match(fs.readFileSync(markdownPath, "utf8"), /Precision Claim Frontier/);
    assert.match(fs.readFileSync(markdownPath, "utf8"), /Findings requiring claim preflight/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision frontier keeps history replay candidates behind labels", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-frontier-history-"));
  try {
    const claimReport = createClaimReport(tempDir);
    const bundleDir = path.join(tempDir, "history-bundle");
    const findingId = "sha256:4".padEnd(71, "4");
    const manifestSha256 = "d".repeat(64);
    writeJson(path.join(bundleDir, "study.json"), {
      schemaVersion: "cellfence.corpus-evidence-bundle.v1",
      studyId: "history-replay",
      environment: {
        harnessCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        harnessDirty: false,
      },
      manifestCopies: [
        {
          subjectId: "history-a",
          phase: "before",
          path: "manifests/history-a.before.json",
          sha256: manifestSha256,
        },
      ],
    });
    writeJson(path.join(bundleDir, "corpus.json"), {
      schemaVersion: "cellfence.history-replay.v1",
      subjects: [
        {
          id: "history-a",
          repository: "https://github.com/example/history-a.git",
          beforeCommit: "a".repeat(40),
          afterCommit: "b".repeat(40),
          before: {
            manifest: {
              strategy: "copy",
              source: "manifests/history-a.before.json",
              reviewStatus: "reviewed",
              review: {
                reviewedAt: "2026-07-25",
                scope: "public surface drift replay fixture",
                reviewedManifestSha256: manifestSha256,
                reviewerAttestations: [
                  {
                    id: "external-reviewer",
                    reviewerType: "human",
                    independent: true,
                  },
                ],
              },
            },
          },
          after: {
            manifest: {
              strategy: "reuse-before",
            },
          },
        },
      ],
    });
    writeJson(path.join(bundleDir, "sampling.json"), {
      schemaVersion: "cellfence.corpus-sampling.v1",
      sampledFindingIds: [findingId],
    });
    writeJsonl(path.join(bundleDir, "labels.jsonl"), []);
    writeJsonl(path.join(bundleDir, "findings.normalized.jsonl"), [
      {
        schemaVersion: "cellfence.corpus-finding.v1",
        studyId: "history-replay",
        findingId,
        subjectId: "history-a",
        repository: "https://github.com/example/history-a.git",
        commit: "b".repeat(40),
        manifestStrategy: "reuse-before",
        manifestReviewStatus: "reviewed",
        precisionEligible: true,
        ruleId: "CELLFENCE_PRIVATE_IMPORT",
        severity: "error",
        filePath: "src/after.ts",
        message: "introduced private import",
        replay: {
          proofEligibility: "counterfactual_candidate_requires_manual_label",
          replayKind: "single_commit_intro",
          introducedChangedFile: true,
        },
      },
    ]);

    const result = runFrontier([
      "--reviewed-claim-report",
      claimReport,
      "--candidate-bundle",
      bundleDir,
    ]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.candidatePool.includedFindings, 1);
    assert.equal(report.candidatePool.rawPrecisionEligibleIncludedFindings, 1);
    assert.equal(report.candidatePool.claimPreflightRequiredIncludedFindings, 0);
    assert.deepEqual(report.candidatePool.byRequirement, {
      blind_label_required: 1,
    });
    assert.equal(report.candidatePool.topSubjects[0].nextAction, "complete_blind_labels");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision frontier reports repository balance from preflight inputs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-frontier-preflight-"));
  try {
    const preflightPath = path.join(tempDir, "preflight.json");
    const markdownPath = path.join(tempDir, "frontier.md");
    writeJson(preflightPath, {
      schemaVersion: "cellfence.precision-claim-preflight.v1",
      studyId: "preflight-fixture",
      claimReady: false,
      protocol: {
        includedRules: ["CELLFENCE_PRIVATE_IMPORT"],
        minimumPrecision: 0.99,
        confidence: 0.95,
        blockingSeverities: ["error"],
        maxRepositoryContribution: 0.1,
      },
      summary: {
        selectedFindings: 10,
        missingLabels: 10,
      },
      selectedByRule: {
        CELLFENCE_PRIVATE_IMPORT: {
          selectedFindings: 10,
          requiredZeroFalsePositiveFindings: 299,
          sampleDeficitBeforeLabeling: 289,
          counts: { unlabeled: 10 },
        },
      },
      repositoryContribution: {
        maxRepositoryContribution: 0.7,
        limit: 0.1,
        repositories: [
          {
            repository: "https://github.com/example/large.git",
            selectedFindings: 7,
            contribution: 0.7,
            overLimit: true,
            additionalOtherFindingsNeeded: 60,
          },
        ],
      },
      gateFailures: [
        "https://github.com/example/large.git contributes 70.0% of selected findings; limit is 10.0%",
      ],
    });

    const result = runFrontier([
      "--reviewed-claim-report",
      preflightPath,
      "--markdown",
      markdownPath,
    ]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.protocol.studyId, "preflight-fixture");
    assert.equal(report.currentReviewedClaim.status, "preflight_not_ready");
    assert.equal(report.repositoryDilution.countKind, "selected_findings");
    assert.equal(report.repositoryDilution.totalSelectedFindings, 10);
    assert.equal(Object.hasOwn(report.repositoryDilution, "totalTrials"), false);
    assert.equal(report.repositoryDilution.repositoriesOverCap.length, 1);
    assert.equal(report.repositoryDilution.repositoriesOverCap[0].selectedFindings, 7);
    assert.equal(Object.hasOwn(report.repositoryDilution.repositoriesOverCap[0], "trials"), false);
    assert.equal(report.repositoryDilution.repositoriesOverCap[0].additionalOutsideRepositoryForCap, 60);
    assert.match(report.decision.blockers.join("\n"), /add 60 outside-repository selected finding\(s\)/);
    const markdown = fs.readFileSync(markdownPath, "utf8");
    assert.match(markdown, /\| Repository \| Selected findings \| Contribution \| Additional outside selected findings \|/);
    assert.doesNotMatch(markdown, /Additional outside trials/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision frontier keeps agent-only labels out of claim preflight input", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-frontier-agent-labels-"));
  try {
    const claimReport = createClaimReport(tempDir);
    const bundleDir = path.join(tempDir, "candidate-bundle");
    const findingId = "sha256:5".padEnd(71, "5");
    const manifestSha256 = "e".repeat(64);
    writeJson(path.join(bundleDir, "study.json"), {
      schemaVersion: "cellfence.corpus-evidence-bundle.v1",
      studyId: "agent-label-candidate",
      environment: {
        harnessCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        harnessDirty: false,
      },
      manifestCopies: [
        {
          subjectId: "candidate-a",
          path: "manifests/candidate-a.json",
          sha256: manifestSha256,
        },
      ],
    });
    writeJson(path.join(bundleDir, "corpus.json"), {
      schemaVersion: "cellfence.corpus.v1",
      subjects: [
        {
          id: "candidate-a",
          repository: "https://github.com/example/candidate-a.git",
          commit: "c".repeat(40),
          manifest: {
            strategy: "copy",
            reviewStatus: "reviewed",
            review: {
              reviewedAt: "2026-07-25",
              scope: "agent-label fixture",
              reviewedManifestSha256: manifestSha256,
              reviewerAttestations: [
                {
                  id: "external-reviewer",
                  reviewerType: "human",
                  independent: true,
                },
              ],
            },
          },
        },
      ],
    });
    writeJson(path.join(bundleDir, "sampling.json"), {
      schemaVersion: "cellfence.corpus-sampling.v1",
      sampledFindingIds: [findingId],
    });
    writeJsonl(path.join(bundleDir, "labels.jsonl"), [
      {
        schemaVersion: "cellfence.corpus-label.v1",
        studyId: "agent-label-candidate",
        findingId,
        rater: "codex-agent-a",
        raterType: "agent",
        round: "blind_first",
        assignmentId: "blind-a",
        evidencePackageId: "pkg-a",
        sawPeerLabels: false,
        label: "true_positive",
        rationale: "agent diagnostic label",
      },
      {
        schemaVersion: "cellfence.corpus-label.v1",
        studyId: "agent-label-candidate",
        findingId,
        rater: "codex-agent-b",
        raterType: "agent",
        round: "blind_second",
        assignmentId: "blind-b",
        evidencePackageId: "pkg-b",
        sawPeerLabels: false,
        label: "true_positive",
        rationale: "second agent diagnostic label",
      },
    ]);
    writeJsonl(path.join(bundleDir, "findings.normalized.jsonl"), [
      {
        schemaVersion: "cellfence.corpus-finding.v1",
        studyId: "agent-label-candidate",
        findingId,
        subjectId: "candidate-a",
        repository: "https://github.com/example/candidate-a.git",
        commit: "c".repeat(40),
        manifestStrategy: "copy",
        manifestReviewStatus: "reviewed",
        precisionEligible: true,
        ruleId: "CELLFENCE_PRIVATE_IMPORT",
        severity: "error",
        filePath: "src/a.ts",
        message: "private import",
      },
    ]);

    const result = runFrontier([
      "--reviewed-claim-report",
      claimReport,
      "--candidate-bundle",
      bundleDir,
    ]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.candidatePool.claimPreflightRequiredIncludedFindings, 0);
    assert.deepEqual(report.candidatePool.byRequirement, {
      external_independent_label_required: 1,
    });
    assert.equal(report.candidatePool.topSubjects[0].nextAction, "collect_external_independent_label");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
