import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(root, "scripts", "precision-round-handoff.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function claimReport() {
  return {
    schemaVersion: "cellfence.precision-claim-report.v1",
    protocol: {
      minimumPrecision: 0.99,
      confidence: 0.95,
      maxRepositoryContribution: 0.1,
    },
    decision: {
      status: "insufficient_evidence",
      reason: "external labels missing",
    },
    metrics: {
      occurrence: {
        counts: {
          true_positive: 2,
          false_positive: 0,
          needs_policy: 1,
          invalid_setup: 0,
          out_of_scope: 0,
        },
        blocking: {
          successes: 2,
          trials: 3,
          observedPrecision: 2 / 3,
          oneSidedLowerBound: 0.2,
        },
        semanticCorrectness: {
          successes: 3,
          trials: 3,
          observedPrecision: 1,
          oneSidedLowerBound: 0.36,
        },
      },
      byRule: {
        CELLFENCE_PRIVATE_IMPORT: {
          blocking: {
            successes: 2,
            trials: 2,
            oneSidedLowerBound: 0.22,
          },
        },
        CELLFENCE_UNDECLARED_RESOURCE_ACCESS: {
          blocking: {
            successes: 0,
            trials: 1,
            oneSidedLowerBound: 0,
          },
        },
      },
      repositorySelection: {
        maxRepositoryContribution: 0.75,
        limit: 0.1,
        repositoriesWithSelectedFindings: 2,
        minimumRepositoriesWithSelectedFindings: 10,
        feasibleWithCurrentRepositoryCount: false,
        repositories: [
          {
            repository: "https://github.com/example/heavy.git",
            selectedFindings: 3,
            contribution: 0.75,
            overLimit: true,
            additionalOtherFindingsNeeded: 24,
          },
        ],
      },
      powerAnalysis: {
        zeroFalsePositiveRequiredTrials: 299,
      },
    },
    labelQuality: {
      externalRaterCoverage: {
        required: 1,
        externalRaterTypes: ["human", "organization"],
        selectedFindings: 4,
        coveredFindings: 0,
        findingsMissingExternalIndependentLabels: 4,
        totalExternalIndependentLabels: 0,
      },
    },
    claimGates: {
      failures: ["4 selected findings lack 1 external human/organization independent label(s)"],
    },
  };
}

function preflight() {
  return {
    schemaVersion: "cellfence.precision-claim-preflight.v1",
    summary: {
      successes: 2,
      trials: 3,
      observedPrecision: 2 / 3,
      oneSidedLowerBound: 0.2,
      additionalTruePositiveTrialsNeeded: 42,
    },
    selectedByRule: {
      CELLFENCE_PRIVATE_IMPORT: { selectedFindings: 2 },
      CELLFENCE_UNDECLARED_RESOURCE_ACCESS: { selectedFindings: 1 },
    },
  };
}

test("precision round handoff carries deficits through each requested round", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-round-handoff-"));
  const claimPath = path.join(tempDir, "claim.json");
  const preflightPath = path.join(tempDir, "preflight.json");
  const outJson = path.join(tempDir, "rounds.json");
  const outMd = path.join(tempDir, "rounds.md");
  writeJson(claimPath, claimReport());
  writeJson(preflightPath, preflight());

  execFileSync(process.execPath, [
    scriptPath,
    "--claim-report", claimPath,
    "--preflight", preflightPath,
    "--from-round", "18",
    "--to-round", "20",
    "--out-json", outJson,
    "--out-md", outMd,
  ], { cwd: root, encoding: "utf8" });

  const report = JSON.parse(fs.readFileSync(outJson, "utf8"));
  assert.equal(report.schemaVersion, "cellfence.precision-round-handoff.v1");
  assert.equal(report.handoffOnly, true);
  assert.equal(report.evidenceProgress, false);
  assert.equal(report.decision.status, "planning_only");
  assert.equal(report.range.rounds, 3);
  assert.deepEqual(report.rounds.map((round) => round.round), [18, 19, 20]);
  assert.ok(report.rounds.every((round) => round.noSyntheticEvidence === true));
  assert.ok(report.rounds.every((round) => round.handoffOnly === true));
  assert.ok(report.rounds.every((round) => round.evidenceProgress === false));
  assert.ok(report.rounds.every((round) => round.doesNotSatisfyEvidenceGate === true));
  assert.ok(report.rounds.every((round) => round.status === "insufficient-evidence"));
  assert.equal(report.currentSnapshot.externalRaterCoverage.findingsMissingExternalIndependentLabels, 4);
  assert.equal(report.residuals.externalRaterCoverage.findingsMissingExternalIndependentLabels, 4);
  assert.equal(report.currentSnapshot.blocking.additionalTruePositiveTrialsNeeded, 42);
  assert.ok(report.residuals.carryForwardTasks.some((task) => task.id === "external-labels"));
  assert.ok(report.residuals.carryForwardTasks.some((task) => task.id === "repo-balance"));
  assert.deepEqual(report.rounds[0].carryForwardTaskIds, report.residuals.carryForwardTasks.map((task) => task.id));
  assert.equal(report.rounds[0].carryForwardTaskRef, "#/residuals/carryForwardTasks");
  assert.match(fs.readFileSync(outMd, "utf8"), /\| 20 \| insufficient-evidence /);
  assert.match(fs.readFileSync(outMd, "utf8"), /Evidence progress: false/);
});

test("precision round handoff refuses an inverted round range", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-round-handoff-bad-"));
  const claimPath = path.join(tempDir, "claim.json");
  writeJson(claimPath, claimReport());

  assert.throws(() => {
    execFileSync(process.execPath, [
      scriptPath,
      "--claim-report", claimPath,
      "--from-round", "20",
      "--to-round", "18",
      "--out-json", path.join(tempDir, "rounds.json"),
    ], { cwd: root, encoding: "utf8", stdio: "pipe" });
  }, /to-round/);
});

test("precision round handoff rejects mismatched claim and preflight study ids", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-round-handoff-mismatch-"));
  const claimPath = path.join(tempDir, "claim.json");
  const preflightPath = path.join(tempDir, "preflight.json");
  const claim = claimReport();
  claim.protocol.studyId = "claim-study";
  const otherPreflight = preflight();
  otherPreflight.studyId = "other-study";
  writeJson(claimPath, claim);
  writeJson(preflightPath, otherPreflight);

  assert.throws(() => {
    execFileSync(process.execPath, [
      scriptPath,
      "--claim-report", claimPath,
      "--preflight", preflightPath,
      "--from-round", "18",
      "--to-round", "18",
      "--out-json", path.join(tempDir, "rounds.json"),
    ], { cwd: root, encoding: "utf8", stdio: "pipe" });
  }, /studyId mismatch/);
});
