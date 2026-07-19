import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const studyScript = path.join(root, "scripts", "agent-effectiveness-study.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

function git(rootDir, args) {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function runStudy(args) {
  return spawnSync(process.execPath, [studyScript, ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

function writeStudyInputs(rootDir, options = {}) {
  const corpusPath = path.join(rootDir, "corpus.json");
  const scenariosPath = path.join(rootDir, "scenarios.json");
  writeJson(corpusPath, {
    schemaVersion: "cellfence.agent-effectiveness.corpus.v1",
    studyId: options.studyId || "agent-ab-smoke",
    seed: options.seed || "fixed-seed",
    subjects: options.subjects || [
      {
        id: "planned",
        repository: "https://example.invalid/repo.git",
        commit: "0123456789abcdef0123456789abcdef01234567",
        manifest: { strategy: "existing" },
      },
    ],
  });
  writeJson(scenariosPath, {
    schemaVersion: "cellfence.agent-effectiveness.scenarios.v1",
    scenarios: options.scenarios || [
      {
        id: "extract-service",
        title: "Extract a service module",
        task: "Move request formatting into a reusable service module while keeping public imports stable.",
        expectedScale: {
          filesChanged: 3,
          insertions: 80,
          deletions: 20,
        },
        riskTags: ["public-api", "ownership"],
        successCriteria: ["The feature still builds.", "No private import is introduced."],
        antiGoals: ["Do not change package publishing metadata."],
      },
    ],
  });
  return { corpusPath, scenariosPath };
}

function createFixtureRepository(rootDir) {
  git(rootDir, ["init"]);
  git(rootDir, ["config", "user.email", "cellfence@example.invalid"]);
  git(rootDir, ["config", "user.name", "CellFence Test"]);
  fs.mkdirSync(path.join(rootDir, "src/app"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "src/app/public.ts"), "export const app = true;\n");
  writeJson(path.join(rootDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      requiredRules: ["CELLFENCE_UNOWNED_SOURCE"],
    },
    cells: [
      {
        id: "app",
        ownedPaths: ["src/app/**"],
        publicEntry: "src/app/public.ts",
        publicSymbols: ["app"],
        consumes: [],
        producesArtifacts: [],
      },
    ],
  });
  git(rootDir, ["add", "."]);
  git(rootDir, ["commit", "--quiet", "-m", "initial"]);
  return git(rootDir, ["rev-parse", "HEAD"]);
}

test("agent effectiveness study dry-run creates deterministic planned assignments", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-agent-study-dry-"));
  try {
    const { corpusPath, scenariosPath } = writeStudyInputs(tempDir);
    const outPath = path.join(tempDir, "report.json");
    const outPath2 = path.join(tempDir, "report-2.json");

    const first = runStudy([
      "--corpus",
      corpusPath,
      "--scenarios",
      scenariosPath,
      "--workdir",
      path.join(tempDir, "work"),
      "--out",
      outPath,
      "--dry-run",
    ]);
    const second = runStudy([
      "--corpus",
      corpusPath,
      "--scenarios",
      scenariosPath,
      "--workdir",
      path.join(tempDir, "work-2"),
      "--out",
      outPath2,
      "--dry-run",
    ]);

    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const report2 = JSON.parse(fs.readFileSync(outPath2, "utf8"));
    assert.equal(report.schemaVersion, "cellfence.agent-effectiveness-study.v1");
    assert.equal(report.seed, "fixed-seed");
    assert.equal(report.summary.subjects, 1);
    assert.equal(report.summary.scenarios, 1);
    assert.equal(report.summary.assignments, 2);
    assert.equal(report.summary.plannedSubjects, 1);
    assert.deepEqual(new Set(report.assignments.map((assignment) => assignment.arm)), new Set(["cellfence", "control"]));
    assert.ok(report.assignments.every((assignment) => assignment.seed === "fixed-seed"));
    assert.ok(report.assignments.every((assignment) => assignment.orderKey.length === 64));
    assert.match(report.evidenceSetSha256, /^[a-f0-9]{64}$/);
    assert.equal(report.evidenceSetSha256, report2.evidenceSetSha256);
    assert.deepEqual(
      report.assignments.map((assignment) => assignment.assignmentId),
      report2.assignments.map((assignment) => assignment.assignmentId),
    );
    const changedScenarios = JSON.parse(fs.readFileSync(scenariosPath, "utf8"));
    changedScenarios.scenarios[0].task = "Change the scenario text without changing the seed.";
    writeJson(scenariosPath, changedScenarios);
    const changedPath = path.join(tempDir, "report-changed.json");
    const changed = runStudy([
      "--corpus",
      corpusPath,
      "--scenarios",
      scenariosPath,
      "--workdir",
      path.join(tempDir, "work-3"),
      "--out",
      changedPath,
      "--dry-run",
    ]);
    assert.equal(changed.status, 0, changed.stderr || changed.stdout);
    const changedReport = JSON.parse(fs.readFileSync(changedPath, "utf8"));
    assert.notDeepEqual(
      report.assignments.map((assignment) => assignment.assignmentId),
      changedReport.assignments.map((assignment) => assignment.assignmentId),
    );
    assert.notEqual(report.evidenceSetSha256, changedReport.evidenceSetSha256);
    assert.equal(report.safety.targetDependenciesInstalled, false);
    assert.equal(report.safety.targetPackageScriptsExecuted, false);
    assert.equal(report.safety.upstreamIssuesOrPullRequestsOpened, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent effectiveness study rejects floating refs by default", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-agent-study-floating-"));
  try {
    const { corpusPath, scenariosPath } = writeStudyInputs(tempDir, {
      subjects: [
        {
          id: "floating",
          repository: "https://example.invalid/repo.git",
          ref: "main",
          manifest: { strategy: "existing" },
        },
      ],
    });

    const result = runStudy([
      "--corpus",
      corpusPath,
      "--scenarios",
      scenariosPath,
      "--out",
      path.join(tempDir, "report.json"),
      "--dry-run",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires exact 40-hex commit/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent effectiveness study keeps floating refs proof-ineligible even with complete labels", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-agent-study-floating-claim-"));
  try {
    const { corpusPath, scenariosPath } = writeStudyInputs(tempDir, {
      subjects: [
        {
          id: "floating",
          repository: "https://example.invalid/repo.git",
          ref: "main",
          manifest: { strategy: "existing" },
        },
      ],
    });
    const planPath = path.join(tempDir, "plan.json");
    const planned = runStudy([
      "--corpus",
      corpusPath,
      "--scenarios",
      scenariosPath,
      "--out",
      planPath,
      "--dry-run",
      "--allow-floating-ref",
    ]);
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    const runsPath = path.join(tempDir, "runs.jsonl");
    const judgmentsPath = path.join(tempDir, "judgments.jsonl");
    writeJsonl(runsPath, plan.assignments.map((assignment, index) => ({
      schemaVersion: "cellfence.agent-effectiveness.run.v1",
      studyId: "agent-ab-smoke",
      assignmentId: assignment.assignmentId,
      agentId: `agent-${index}`,
      status: "completed",
    })));
    writeJsonl(judgmentsPath, plan.assignments.map((assignment, index) => ({
      schemaVersion: "cellfence.agent-effectiveness.judgment.v1",
      studyId: "agent-ab-smoke",
      assignmentId: assignment.assignmentId,
      judgeId: `judge-${index}`,
      taskSuccess: "pass",
      frictionCost: "low",
      promiseLabel: "promising",
      boundaryViolations: 0,
      publicApiDrift: 0,
      resourceContractDrift: 0,
      reviewability: 5,
      rationale: "Complete labels do not make a floating ref claim-eligible.",
    })));
    const outPath = path.join(tempDir, "report.json");

    const result = runStudy([
      "--corpus",
      corpusPath,
      "--scenarios",
      scenariosPath,
      "--runs",
      runsPath,
      "--judgments",
      judgmentsPath,
      "--out",
      outPath,
      "--dry-run",
      "--allow-floating-ref",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.summary.validationFindings, 0);
    assert.equal(report.claimEligibility.exactCommitPinned, false);
    assert.equal(report.claimEligibility.eligible, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent effectiveness study binds copy manifest content to assignment identity", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-agent-study-copy-hash-"));
  try {
    const manifestPath = path.join(tempDir, "manifests", "fixture.cellfence.manifest.json");
    writeJson(manifestPath, {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        requireOwnership: true,
        include: ["src/**"],
        requiredRules: ["CELLFENCE_UNOWNED_SOURCE"],
      },
      cells: [
        {
          id: "app",
          ownedPaths: ["src/app/**"],
          publicEntry: "src/app/public.ts",
          publicSymbols: ["app"],
          consumes: [],
          producesArtifacts: [],
        },
      ],
    });
    const { corpusPath, scenariosPath } = writeStudyInputs(tempDir, {
      subjects: [
        {
          id: "copy-manifest",
          repository: "https://example.invalid/repo.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
          manifest: {
            strategy: "copy",
            source: "manifests/fixture.cellfence.manifest.json",
            reviewStatus: "reviewed",
          },
        },
      ],
    });
    const firstPath = path.join(tempDir, "first.json");
    const first = runStudy([
      "--corpus",
      corpusPath,
      "--scenarios",
      scenariosPath,
      "--out",
      firstPath,
      "--dry-run",
    ]);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstReport = JSON.parse(fs.readFileSync(firstPath, "utf8"));

    const changedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    changedManifest.cells[0].publicSymbols.push("extra");
    writeJson(manifestPath, changedManifest);
    const secondPath = path.join(tempDir, "second.json");
    const second = runStudy([
      "--corpus",
      corpusPath,
      "--scenarios",
      scenariosPath,
      "--out",
      secondPath,
      "--dry-run",
    ]);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondReport = JSON.parse(fs.readFileSync(secondPath, "utf8"));

    assert.notDeepEqual(
      firstReport.assignments.map((assignment) => assignment.assignmentId),
      secondReport.assignments.map((assignment) => assignment.assignmentId),
    );
    assert.notDeepEqual(
      firstReport.assignments.map((assignment) => assignment.subjectSha256),
      secondReport.assignments.map((assignment) => assignment.subjectSha256),
    );
    assert.notEqual(firstReport.evidenceSetSha256, secondReport.evidenceSetSha256);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent effectiveness study clones exact commits and writes per-arm task packs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-agent-study-clone-"));
  try {
    const fixtureRepo = path.join(tempDir, "repo");
    fs.mkdirSync(fixtureRepo, { recursive: true });
    const commit = createFixtureRepository(fixtureRepo);
    const { corpusPath, scenariosPath } = writeStudyInputs(tempDir, {
      subjects: [
        {
          id: "fixture-repo",
          repository: fixtureRepo,
          commit,
          manifest: {
            strategy: "existing",
            path: "cellfence.manifest.json",
          },
        },
      ],
    });
    const workDir = path.join(tempDir, "work");
    const outPath = path.join(tempDir, "report.json");

    const result = runStudy([
      "--corpus",
      corpusPath,
      "--scenarios",
      scenariosPath,
      "--workdir",
      workDir,
      "--out",
      outPath,
      "--clone-mode",
      "full",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.summary.preparedSubjects, 1);
    assert.equal(report.subjects[0].status, "prepared");
    assert.equal(report.subjects[0].commit, commit);
    assert.match(report.subjects[0].gitTree, /^[a-f0-9]{40}$/);
    assert.match(report.subjects[0].manifest.sha256, /^[a-f0-9]{64}$/);
    assert.equal(report.subjects[0].assignments, 2);
    const assignmentRoot = path.join(workDir, "assignments");
    const taskFiles = fs.readdirSync(assignmentRoot, { recursive: true })
      .filter((entry) => entry.endsWith("TASK.md"))
      .map((entry) => fs.readFileSync(path.join(assignmentRoot, entry), "utf8"));
    assert.equal(taskFiles.length, 2);
    const cellfenceTask = taskFiles.find((content) => content.includes("Use CellFence as part of the edit loop."));
    const controlTask = taskFiles.find((content) => content.includes("Do not use CellFence guidance, context, or check output while editing."));
    assert.ok(cellfenceTask);
    assert.ok(controlTask);
    assert.match(cellfenceTask, /Manifest: `/);
    assert.doesNotMatch(controlTask, /Manifest: `/);
    assert.ok(taskFiles.every((content) => content.includes("Do not open upstream issues, pull requests, comments, or discussions.")));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent effectiveness study rejects existing manifest symlinks that escape the checkout", { skip: process.platform === "win32" ? "symlink setup requires elevated privileges on Windows" : false }, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-agent-study-symlink-"));
  try {
    const sourceRepo = path.join(tempDir, "repo");
    const outsideDir = path.join(tempDir, "outside");
    fs.mkdirSync(sourceRepo, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    writeJson(path.join(outsideDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      governance: { requireOwnership: true },
      cells: [],
    });
    git(sourceRepo, ["init"]);
    git(sourceRepo, ["config", "user.email", "cellfence@example.invalid"]);
    git(sourceRepo, ["config", "user.name", "CellFence Test"]);
    fs.mkdirSync(path.join(sourceRepo, "src/app"), { recursive: true });
    fs.writeFileSync(path.join(sourceRepo, "src/app/public.ts"), "export const app = true;\n");
    fs.symlinkSync(path.join(outsideDir, "cellfence.manifest.json"), path.join(sourceRepo, "cellfence.manifest.json"));
    git(sourceRepo, ["add", "."]);
    git(sourceRepo, ["commit", "--quiet", "-m", "symlink manifest"]);
    const commit = git(sourceRepo, ["rev-parse", "HEAD"]);
    const { corpusPath, scenariosPath } = writeStudyInputs(tempDir, {
      subjects: [
        {
          id: "symlink-manifest",
          repository: sourceRepo,
          commit,
          manifest: {
            strategy: "existing",
            path: "cellfence.manifest.json",
          },
        },
      ],
    });

    const result = runStudy([
      "--corpus",
      corpusPath,
      "--scenarios",
      scenariosPath,
      "--workdir",
      path.join(tempDir, "work"),
      "--out",
      path.join(tempDir, "report.json"),
      "--clone-mode",
      "full",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /manifest\.path resolves outside its root/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent effectiveness study aggregates execution and judge JSONL by arm", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-agent-study-judge-"));
  try {
    const { corpusPath, scenariosPath } = writeStudyInputs(tempDir);
    const planPath = path.join(tempDir, "plan.json");
    const planned = runStudy([
      "--corpus",
      corpusPath,
      "--scenarios",
      scenariosPath,
      "--out",
      planPath,
      "--dry-run",
    ]);
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    const cellfenceAssignment = plan.assignments.find((assignment) => assignment.arm === "cellfence");
    const controlAssignment = plan.assignments.find((assignment) => assignment.arm === "control");
    const runsPath = path.join(tempDir, "runs.jsonl");
    const judgmentsPath = path.join(tempDir, "judgments.jsonl");
    writeJsonl(runsPath, [
      {
        schemaVersion: "cellfence.agent-effectiveness.run.v1",
        studyId: "agent-ab-smoke",
        assignmentId: cellfenceAssignment.assignmentId,
        agentId: "agent-a",
        status: "completed",
        diffStat: { filesChanged: 3, insertions: 50, deletions: 10 },
      },
      {
        schemaVersion: "cellfence.agent-effectiveness.run.v1",
        studyId: "agent-ab-smoke",
        assignmentId: controlAssignment.assignmentId,
        agentId: "agent-b",
        status: "completed",
        diffStat: { filesChanged: 5, insertions: 90, deletions: 12 },
      },
    ]);
    writeJsonl(judgmentsPath, [
      {
        schemaVersion: "cellfence.agent-effectiveness.judgment.v1",
        studyId: "agent-ab-smoke",
        assignmentId: cellfenceAssignment.assignmentId,
        judgeId: "judge-1",
        taskSuccess: "pass",
        frictionCost: "low",
        promiseLabel: "promising",
        boundaryViolations: 0,
        publicApiDrift: 0,
        resourceContractDrift: 0,
        reviewability: 5,
        rationale: "The patch stayed inside the intended public surface.",
      },
      {
        schemaVersion: "cellfence.agent-effectiveness.judgment.v1",
        studyId: "agent-ab-smoke",
        assignmentId: controlAssignment.assignmentId,
        judgeId: "judge-1",
        taskSuccess: "partial",
        frictionCost: "none",
        promiseLabel: "neutral",
        boundaryViolations: 2,
        publicApiDrift: 1,
        resourceContractDrift: 0,
        reviewability: 3,
        rationale: "The patch worked but introduced direct internal imports.",
      },
    ]);
    const outPath = path.join(tempDir, "report.json");

    const result = runStudy([
      "--corpus",
      corpusPath,
      "--scenarios",
      scenariosPath,
      "--runs",
      runsPath,
      "--judgments",
      judgmentsPath,
      "--out",
      outPath,
      "--dry-run",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.summary.runs, 2);
    assert.equal(report.summary.judgments, 2);
    assert.equal(report.summary.validationFindings, 0);
    assert.equal(report.claimEligibility.eligible, true);
    assert.equal(report.metrics.byArm.cellfence.passRate, 1);
    assert.equal(report.metrics.byArm.cellfence.boundaryViolationRate, 0);
    assert.equal(report.metrics.byArm.control.passRate, 0);
    assert.equal(report.metrics.byArm.control.boundaryViolationRate, 1);
    assert.equal(report.metrics.pairedScenarioSummary.pairs, 1);
    assert.equal(report.metrics.pairedScenarioSummary.averageBoundaryViolationDelta, -2);
    assert.equal(report.metrics.pairedScenarioSummary.averageReviewabilityDelta, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent effectiveness study reports unknown judge assignment ids as validation findings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-agent-study-unknown-"));
  try {
    const { corpusPath, scenariosPath } = writeStudyInputs(tempDir);
    const judgmentsPath = path.join(tempDir, "judgments.jsonl");
    writeJsonl(judgmentsPath, [
      {
        schemaVersion: "cellfence.agent-effectiveness.judgment.v1",
        studyId: "agent-ab-smoke",
        assignmentId: "sha256:unknown",
        judgeId: "judge-1",
        taskSuccess: "fail",
        frictionCost: "unknown",
        promiseLabel: "inconclusive",
        boundaryViolations: 0,
        publicApiDrift: 0,
        resourceContractDrift: 0,
        reviewability: 1,
        rationale: "Unknown assignment should not be silently accepted.",
      },
    ]);
    const outPath = path.join(tempDir, "report.json");

    const result = runStudy([
      "--corpus",
      corpusPath,
      "--scenarios",
      scenariosPath,
      "--judgments",
      judgmentsPath,
      "--out",
      outPath,
      "--dry-run",
    ]);

    assert.equal(result.status, 1);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.ok(report.summary.validationFindings >= 1);
    assert.ok(report.judgments.validationFindings.some((finding) => /unknown assignmentId/.test(finding)));
    assert.equal(report.claimEligibility.eligible, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
