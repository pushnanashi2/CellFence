import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const scriptPath = path.join(root, "scripts", "precision-claim-preflight.mjs");
const fixtureManifest = {
  schemaVersion: "cellfence.manifest.v1",
  cells: [],
};
const fixtureManifestSha256 = crypto.createHash("sha256").update(`${JSON.stringify(fixtureManifest, null, 2)}\n`).digest("hex");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "");
}

function runPreflight(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function finding(index, patch = {}) {
  return {
    schemaVersion: "cellfence.corpus-finding.v1",
    studyId: "preflight-fixture",
    findingId: `sha256:${String(index).repeat(64).slice(0, 64)}`,
    subjectId: `subject-${index}`,
    repository: `https://github.com/example/subject-${index}.git`,
    precisionEligible: true,
    ruleId: "CELLFENCE_PRIVATE_IMPORT",
    severity: "error",
    filePath: `src/${index}.ts`,
    line: index,
    message: "fixture finding",
    ...patch,
  };
}

function label(findingId, rater, round) {
  return {
    schemaVersion: "cellfence.corpus-label.v1",
    studyId: "preflight-fixture",
    findingId,
    rater,
    round,
    assignmentId: `${round}-${findingId.slice("sha256:".length, "sha256:".length + 8)}`,
    evidencePackageId: `evidence-${findingId.slice("sha256:".length, "sha256:".length + 8)}`,
    sawPeerLabels: false,
    label: "true_positive",
    rationale: `${rater} fixture rationale`,
  };
}

function protocol(patch = {}) {
  return {
    schemaVersion: "cellfence.precision-claim-protocol.v1",
    studyId: "preflight-fixture",
    claim: {
      includedRules: ["CELLFENCE_PRIVATE_IMPORT"],
      primaryMetric: "blocking_precision",
      minimumPrecision: 0.5,
      confidence: 0.75,
      blockingSeverities: ["error"],
    },
    samplingPlan: {
      maxRepositoryContribution: 1,
    },
    ...patch,
  };
}

function createBundle(tempDir, findings, labels, patch = {}) {
  const bundleDir = path.join(tempDir, "bundle");
  const subjects = [...new Map(findings.map((entry) => [entry.subjectId, entry])).values()];
  const manifestCopies = [];
  for (const subject of subjects) {
    const relativePath = `manifests/${subject.subjectId}.json`;
    writeJson(path.join(bundleDir, relativePath), fixtureManifest);
    manifestCopies.push({
      subjectId: subject.subjectId,
      path: relativePath,
      sha256: fixtureManifestSha256,
    });
  }
  writeJson(path.join(bundleDir, "study.json"), {
    schemaVersion: "cellfence.corpus-evidence-bundle.v1",
    studyId: "preflight-fixture",
    environment: {
      harnessDirty: false,
    },
    manifestCopies,
    ...patch.study,
  });
  writeJson(path.join(bundleDir, "corpus.json"), {
    schemaVersion: "cellfence.corpus.v1",
    subjects: subjects.map((subject) => ({
      id: subject.subjectId,
      repository: subject.repository,
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      manifest: {
        strategy: "copy",
        source: `manifests/${subject.subjectId}.json`,
        reviewStatus: "reviewed",
        review: {
          reviewers: ["reviewer-a"],
          boundaryEvidence: ["fixture boundary"],
        },
      },
    })),
    ...patch.corpus,
  });
  writeJson(path.join(bundleDir, "sampling.json"), {
    schemaVersion: "cellfence.corpus-sampling.v1",
    sampledFindingIds: findings.map((entry) => entry.findingId),
    ...patch.sampling,
  });
  writeJsonl(path.join(bundleDir, "findings.normalized.jsonl"), findings);
  writeJsonl(path.join(bundleDir, "labels.jsonl"), labels);
  return bundleDir;
}

test("precision claim preflight accepts a labeled, balanced bundle with enough power", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-ok-"));
  try {
    const findings = [finding(1), finding(2)];
    const labels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]);
    const bundleDir = createBundle(tempDir, findings, labels);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol());

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.claimReady, true);
    assert.equal(report.protocol.requiredZeroFalsePositiveFindingsPerRule, 2);
    assert.equal(report.selectedByRule.CELLFENCE_PRIVATE_IMPORT.additionalTruePositiveTrialsNeeded, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight reports dirty, unlabeled, and underpowered evidence separately", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-underpowered-"));
  try {
    const findings = [finding(1)];
    const bundleDir = createBundle(tempDir, findings, [], {
      study: {
        environment: {
          harnessDirty: true,
        },
      },
    });
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: {
        includedRules: ["CELLFENCE_PRIVATE_IMPORT"],
        primaryMetric: "blocking_precision",
        minimumPrecision: 0.99,
        confidence: 0.95,
        blockingSeverities: ["error"],
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.claimReady, false);
    assert.match(report.gateFailures.join("\n"), /dirty CellFence worktree/);
    assert.match(report.gateFailures.join("\n"), /not fully independently labeled/);
    assert.match(report.gateFailures.join("\n"), /299 zero-false-positive findings/);
    assert.equal(report.selectedByRule.CELLFENCE_PRIVATE_IMPORT.sampleDeficitBeforeLabeling, 298);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight rejects repository concentration before claim evaluation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-contribution-"));
  try {
    const findings = [finding(1, { repository: "https://github.com/example/one.git" }), finding(2, { repository: "https://github.com/example/one.git" })];
    const labels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]);
    const bundleDir = createBundle(tempDir, findings, labels);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      samplingPlan: {
        maxRepositoryContribution: 0.5,
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.repositoryContribution.maxRepositoryContribution, 1);
    assert.match(report.gateFailures.join("\n"), /contributes 100.0%/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight gates rater provenance when protocol requires it", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-rater-"));
  try {
    const findings = [finding(1)];
    const labels = [
      label(findings[0].findingId, "agent-blind-first", "blind_first"),
      label(findings[0].findingId, "reviewer-b", "blind_second"),
    ];
    labels[1].raterType = "human";
    const bundleDir = createBundle(tempDir, findings, labels);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      labelingPlan: {
        requireKnownRaterType: true,
        allowedRaterTypes: ["human"],
        allowNonHumanRaters: false,
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /missing raterType\/raterClass/);
    assert.match(report.issues.join("\n"), /non-human/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight gates external manifest review provenance", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-manifest-review-"));
  try {
    const findings = [finding(1)];
    const labels = [
      label(findings[0].findingId, "reviewer-a", "blind_first"),
      label(findings[0].findingId, "reviewer-b", "blind_second"),
    ];
    const bundleDir = createBundle(tempDir, findings, labels, {
      corpus: {
        subjects: [
          {
            id: "subject-1",
            repository: "https://github.com/example/subject-1.git",
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            manifest: {
              strategy: "copy",
              source: "manifests/subject-1.json",
              reviewStatus: "reviewed",
              review: {
                reviewerAttestations: [
                  {
                    id: "reviewer-a",
                    reviewerType: "human",
                    independent: true,
                  },
                ],
                reviewedAt: "2026-07-20",
                reviewedManifestSha256: "0".repeat(64),
                scope: "package/workspace boundary manifest review",
                boundaryEvidence: ["fixture boundary"],
              },
            },
          },
        ],
      },
    });
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      manifestReviewPlan: {
        requireExternalAttestations: true,
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /reviewedManifestSha256 does not match sealed manifest copy/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
