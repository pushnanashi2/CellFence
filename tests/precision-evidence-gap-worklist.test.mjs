import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(".");
const scriptPath = path.join(repoRoot, "scripts", "precision-evidence-gap-worklist.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runGaps(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

function createPreflight(tempDir) {
  const preflightPath = path.join(tempDir, "preflight.json");
  writeJson(preflightPath, {
    schemaVersion: "cellfence.precision-claim-preflight.v1",
    studyId: "fixture-round",
    claimReady: false,
    protocol: {
      studyId: "fixture-round",
      minimumPrecision: 0.99,
      confidence: 0.95,
      includedRules: [
        "CELLFENCE_PRIVATE_IMPORT",
        "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
      ],
      maxRepositoryContribution: 0.1,
      requireExternalIndependentLabels: true,
      requireExternalManifestReview: true,
    },
    summary: {
      selectedFindings: 4,
      missingLabels: 4,
    },
    selectedByRule: {
      CELLFENCE_PRIVATE_IMPORT: {
        selectedFindings: 3,
        requiredZeroFalsePositiveFindings: 3,
        sampleDeficitBeforeLabeling: 0,
        counts: { unlabeled: 3 },
      },
      CELLFENCE_PUBLIC_SYMBOL_MISMATCH: {
        selectedFindings: 1,
        requiredZeroFalsePositiveFindings: 3,
        sampleDeficitBeforeLabeling: 2,
        counts: { unlabeled: 1 },
      },
    },
    repositoryContribution: {
      maxRepositoryContribution: 0.75,
      limit: 0.1,
      feasibleWithCurrentRepositoryCount: true,
      repositories: [
        {
          repository: "https://github.com/example/a.git",
          selectedFindings: 3,
          contribution: 0.75,
          overLimit: true,
          additionalOtherFindingsNeeded: 26,
        },
      ],
    },
    externalRaterCoverage: {
      required: 1,
      externalRaterTypes: ["human", "organization"],
      selectedFindings: 4,
      coveredFindings: 0,
      findingsMissingExternalIndependentLabels: 4,
      findings: [
        {
          findingId: "sha256:a",
          subjectId: "a",
          ruleId: "CELLFENCE_PRIVATE_IMPORT",
          externalIndependentRaters: 0,
          requiredExternalIndependentRaters: 1,
          ok: false,
        },
      ],
    },
    issues: [
      "subject-a external manifest review requires review.reviewerAttestations",
      "subject-a external manifest review requires review.reviewedAt",
      "subject-b external manifest review requires review.reviewedManifestSha256",
    ],
    gateFailures: [
      "4 selected findings are not fully independently labeled",
    ],
  });
  return preflightPath;
}

function createExpansionPlan(tempDir) {
  const planPath = path.join(tempDir, "expansion.json");
  writeJson(planPath, {
    schemaVersion: "cellfence.precision-corpus-expansion-plan.v1",
    candidatePool: {
      sampledCandidateFindingsByRule: {
        CELLFENCE_PRIVATE_IMPORT: 5,
      },
      rawCandidateFindingsByRule: {
        CELLFENCE_PRIVATE_IMPORT: 7,
      },
      topCandidates: [
        { subjectId: "candidate-a" },
      ],
      topCandidateResidual: {
        residualDeficits: {
          CELLFENCE_PUBLIC_SYMBOL_MISMATCH: 2,
        },
      },
    },
  });
  return planPath;
}

test("precision evidence gap worklist preserves blockers without claiming readiness", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-gap-worklist-"));
  try {
    const preflightPath = createPreflight(tempDir);
    const expansionPath = createExpansionPlan(tempDir);
    const nextCyclePath = path.join(tempDir, "summary.json");
    const outPath = path.join(tempDir, "gaps.json");
    const markdownPath = path.join(tempDir, "gaps.md");
    writeJson(nextCyclePath, {
      artifacts: { blindWorklist: "reports/corpus/fixture/blind-worklist" },
    });

    const result = runGaps([
      "--preflight",
      preflightPath,
      "--next-cycle",
      nextCyclePath,
      "--expansion-plan",
      expansionPath,
      "--out",
      outPath,
      "--markdown",
      markdownPath,
    ]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = readJson(outPath);
    assert.equal(report.schemaVersion, "cellfence.precision-evidence-gap-worklist.v1");
    assert.equal(report.claimStatus.claimAllowedByThisWorklist, false);
    assert.deepEqual(report.tasks.map((task) => task.type), [
      "external_manifest_attestation",
      "manual_label",
      "external_independent_label",
      "repository_balance",
      "rule_sample_deficit",
    ]);
    assert.equal(report.tasks.find((task) => task.type === "external_manifest_attestation").subjects.length, 2);
    assert.equal(report.tasks.find((task) => task.type === "manual_label").worklist, "reports/corpus/fixture/blind-worklist");
    const publicSurfaceTask = report.tasks.find((task) => task.ruleId === "CELLFENCE_PUBLIC_SYMBOL_MISMATCH");
    assert.equal(publicSurfaceTask.sampledCandidateFindings, 0);
    assert.match(publicSurfaceTask.action, /rule-specific reviewed holdout/);
    assert.match(fs.readFileSync(markdownPath, "utf8"), /Precision Evidence Gap Worklist/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision evidence gap worklist exits cleanly when preflight is already claim ready", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-gap-worklist-ready-"));
  try {
    const preflightPath = path.join(tempDir, "preflight.json");
    writeJson(preflightPath, {
      schemaVersion: "cellfence.precision-claim-preflight.v1",
      studyId: "ready",
      claimReady: true,
      protocol: {
        includedRules: ["CELLFENCE_PRIVATE_IMPORT"],
        requireExternalIndependentLabels: true,
        requireExternalManifestReview: true,
      },
      summary: {
        selectedFindings: 3,
        missingLabels: 0,
      },
      selectedByRule: {
        CELLFENCE_PRIVATE_IMPORT: {
          selectedFindings: 3,
          requiredZeroFalsePositiveFindings: 3,
          sampleDeficitBeforeLabeling: 0,
          counts: { unlabeled: 0 },
        },
      },
      repositoryContribution: {
        maxRepositoryContribution: 0.1,
        limit: 0.1,
        feasibleWithCurrentRepositoryCount: true,
        repositories: [],
      },
      externalRaterCoverage: {
        findingsMissingExternalIndependentLabels: 0,
      },
      issues: [],
      gateFailures: [],
    });

    const result = runGaps(["--preflight", preflightPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.claimStatus.claimAllowedByThisWorklist, true);
    assert.deepEqual(report.tasks, []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision evidence gap worklist rejects missing option values", () => {
  const result = runGaps(["--preflight"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--preflight requires a value/);
});
