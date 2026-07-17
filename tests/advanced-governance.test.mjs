import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkCommitEvidence,
  checkDesignDocs,
  checkMutationReport,
  checkRepository,
  checkTaskManifest,
  createBaselineAudit,
  createManifestFromServiceManifests,
  stampDesignDoc,
  verifyManifestFromServiceManifests,
} from "../packages/engine/dist/index.js";

const CLI_PATH = path.resolve("packages/cli/dist/index.js");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function git(rootDir, args) {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function initGit(rootDir) {
  for (const args of [
    ["init"],
    ["config", "user.email", "cellfence@example.invalid"],
    ["config", "user.name", "CellFence Test"],
  ]) git(rootDir, args);
}

test("service manifest adapter imports and verifies the core service boundary fields", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-service-adapter-"));
  try {
    fs.mkdirSync(path.join(rootDir, "systems/platform"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "systems/platform/public.ts"), "export const platform = true;\n");
    writeJson(path.join(rootDir, "systems/platform/service.json"), {
      serviceId: "platform",
      ownedPaths: ["systems/platform/**"],
      allowedServiceImports: [],
      consumes: { systems: [] },
      produces: { exports: { entry: "systems/platform/public.ts", symbols: ["platform"] }, artifacts: [{ id: "ignored", path: "data/**" }] },
    });
    fs.mkdirSync(path.join(rootDir, "systems/admin-api"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "systems/admin-api/public.ts"), "export const adminApi = true;\n");
    writeJson(path.join(rootDir, "systems/admin-api/service.json"), {
      serviceId: "admin-api",
      ownedPaths: ["systems/admin-api/**"],
      allowedServiceImports: ["platform"],
      consumes: { systems: ["platform"] },
      produces: { exports: { entry: "systems/admin-api/public.ts", symbols: ["adminApi"] } },
    });

    const imported = createManifestFromServiceManifests({ rootDir, serviceManifestPaths: ["systems/*/service.json"] });
    assert.deepEqual(imported.manifest.cells.map((cell) => cell.id), ["admin-api", "platform"]);
    assert.deepEqual(imported.manifest.cells.find((cell) => cell.id === "admin-api").consumes, [{ cell: "platform" }]);
    assert.ok(imported.warnings.some((warning) => warning.field === "produces.artifacts"));

    const verified = verifyManifestFromServiceManifests({ rootDir, manifest: imported.manifest, serviceManifestPaths: ["systems/*/service.json"] });
    assert.equal(verified.ok, true, JSON.stringify(verified.findings));

    const drifted = structuredClone(imported.manifest);
    drifted.cells.find((cell) => cell.id === "admin-api").consumes = [];
    const driftResult = verifyManifestFromServiceManifests({ rootDir, manifest: drifted, serviceManifestPaths: ["systems/*/service.json"] });
    assert.equal(driftResult.ok, false);
    assert.equal(driftResult.findings[0].ruleId, "CELLFENCE_SERVICE_MANIFEST_DRIFT");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service manifest adapter stays aligned with sanitized Cash service manifests", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-cash-service-fixture-"));
  try {
    const fixture = JSON.parse(fs.readFileSync(path.resolve("tests/fixtures/cash-service-manifests.v1.json"), "utf8"));
    assert.equal(fixture.serviceCount, 18);
    for (const service of fixture.manifests) {
      writeJson(path.join(rootDir, "systems", service.serviceId, "service.json"), service);
    }

    const imported = createManifestFromServiceManifests({ rootDir, serviceManifestPaths: ["systems/*/service.json"] });
    const cellIds = imported.manifest.cells.map((cell) => cell.id);
    assert.deepEqual(cellIds, [
      "admin-api",
      "agent-autopilot",
      "alpha-discovery",
      "alpha-review",
      "disclosure-ingestion",
      "entity-master",
      "event-eval",
      "experiment-evaluation",
      "factor-eval",
      "llm-gateway",
      "market-data",
      "ops-runtime",
      "platform",
      "portfolio-state",
      "qualitative-eval",
      "report-output",
      "research-pipelines",
      "sec-eval",
    ]);
    assert.deepEqual(imported.manifest.cells.find((cell) => cell.id === "admin-api").consumes, [
      { cell: "alpha-review" },
      { cell: "disclosure-ingestion" },
      { cell: "event-eval" },
      { cell: "experiment-evaluation" },
      { cell: "llm-gateway" },
      { cell: "market-data" },
      { cell: "ops-runtime" },
      { cell: "platform" },
      { cell: "portfolio-state" },
      { cell: "report-output" },
      { cell: "sec-eval" },
    ]);
    assert.equal(imported.manifest.cells.find((cell) => cell.id === "platform").publicEntry, "systems/platform/public.ts");
    assert.ok(imported.manifest.cells.find((cell) => cell.id === "research-pipelines").publicSymbols.includes("loadResearchGoals"));
    assert.ok(imported.warnings.some((warning) => warning.serviceId === "platform" && warning.field === "produces.artifacts"));

    const verified = verifyManifestFromServiceManifests({ rootDir, manifest: imported.manifest, serviceManifestPaths: ["systems/*/service.json"] });
    assert.equal(verified.ok, true, JSON.stringify(verified.findings));

    const drifted = structuredClone(imported.manifest);
    drifted.cells.find((cell) => cell.id === "admin-api").consumes = [{ cell: "platform" }];
    const driftResult = verifyManifestFromServiceManifests({ rootDir, manifest: drifted, serviceManifestPaths: ["systems/*/service.json"] });
    assert.equal(driftResult.ok, false);
    assert.ok(driftResult.findings.some((finding) => finding.ruleId === "CELLFENCE_SERVICE_MANIFEST_DRIFT" && finding.cellId === "admin-api"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("path classes block source imports from runtime and report mixed source-runtime changes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-path-classes-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/app"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "runtime/state"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/app/public.ts"), "import { state } from '../../runtime/state/public.js';\nexport const app = state;\n");
    fs.writeFileSync(path.join(rootDir, "runtime/state/public.ts"), "export const state = true;\n");
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        requireOwnership: true,
        include: ["src/**", "runtime/**"],
        pathClasses: [
          { id: "source", kind: "source", paths: ["src/**"] },
          { id: "runtime", kind: "runtime", paths: ["runtime/**"] },
        ],
      },
      cells: [
        { id: "app", ownedPaths: ["src/app/**"], publicEntry: "src/app/public.ts", publicSymbols: ["app"], consumes: [{ cell: "state" }], producesArtifacts: [] },
        { id: "state", ownedPaths: ["runtime/state/**"], publicEntry: "runtime/state/public.ts", publicSymbols: ["state"], consumes: [], producesArtifacts: [] },
      ],
    });
    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json", changedFiles: ["src/app/public.ts", "runtime/state/public.ts"] });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.ruleId === "CELLFENCE_SOURCE_IMPORTS_RUNTIME"));
    assert.ok(result.warnings.some((finding) => finding.ruleId === "CELLFENCE_MIXED_SOURCE_RUNTIME_CHANGE"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task manifests constrain changed files to the task envelope", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-task-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/app"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/app/public.ts"), "export const app = true;\n");
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{ id: "app", ownedPaths: ["src/app/**"], publicEntry: "src/app/public.ts", publicSymbols: ["app"], consumes: [], producesArtifacts: [] }],
    });
    writeJson(path.join(rootDir, ".cellfence/tasks/task.json"), {
      id: "task-1",
      allowedWritePaths: ["src/app/**"],
      forbiddenPaths: ["src/app/forbidden.ts"],
      requiredGates: ["cellfence baseline check"],
      maxFilesChanged: 1,
    });
    initGit(rootDir);
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-m", "base"]);
    fs.writeFileSync(path.join(rootDir, "src/app/forbidden.ts"), "export const forbidden = true;\n");
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "cellfence.manifest.json"), "utf8"));
    const result = checkTaskManifest({ rootDir, manifest, taskPath: ".cellfence/tasks/task.json" });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.ruleId === "CELLFENCE_TASK_FORBIDDEN_PATH"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("design docs are stamped against public surface hashes and fail stale checks", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-docs-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/app"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/app/public.ts"), "export const app = true;\n");
    const manifest = {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{ id: "app", ownedPaths: ["src/app/**"], publicEntry: "src/app/public.ts", publicSymbols: ["app"], consumes: [], producesArtifacts: [] }],
    };
    const stamped = stampDesignDoc({ rootDir, manifest, cellId: "app", docPath: "docs/app.md" });
    assert.equal(stamped.ok, true, JSON.stringify(stamped.findings));
    fs.appendFileSync(path.join(rootDir, "src/app/public.ts"), "export const changed = true;\n");
    const stale = checkDesignDocs({ rootDir, manifest, docPaths: ["docs/app.md"] });
    assert.equal(stale.ok, false);
    assert.equal(stale.findings[0].ruleId, "CELLFENCE_DOC_SURFACE_STALE");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("mutation report ingestion aggregates per cell and enforces a score threshold", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-mutation-"));
  try {
    const manifest = {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{ id: "app", ownedPaths: ["src/app/**"], publicEntry: "src/app/public.ts", publicSymbols: ["app"], consumes: [], producesArtifacts: [] }],
    };
    writeJson(path.join(rootDir, "mutation.json"), {
      files: {
        "src/app/public.ts": {
          mutants: [
            { status: "Killed" },
            { status: "Survived" },
            { status: "Ignored" },
          ],
        },
      },
    });
    const result = checkMutationReport({ rootDir, manifest, reportPath: "mutation.json", minScore: 90 });
    assert.equal(result.ok, false);
    assert.equal(result.cells.app.killed, 1);
    assert.equal(result.cells.app.survived, 1);
    assert.equal(result.cells.app.ignored, 1);
    assert.equal(result.findings[0].ruleId, "CELLFENCE_MUTATION_SCORE_BELOW_THRESHOLD");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("baseline audit flags baseline-only commits", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-baseline-audit-"));
  try {
    initGit(rootDir);
    fs.writeFileSync(path.join(rootDir, "cellfence.baseline.json"), "{}\n");
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-m", "base"]);
    fs.writeFileSync(path.join(rootDir, "cellfence.baseline.json"), "{\"changed\":true}\n");
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-m", "Update baseline only"]);
    const result = createBaselineAudit({ rootDir, baselinePath: "cellfence.baseline.json", maxCommits: 10 });
    assert.equal(result.ok, false);
    assert.equal(result.baselineOnlyCommits, 2);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("commit evidence checks sections, trailers, changed cells, and test declarations", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-commit-evidence-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/app"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "src/app/public.ts"), "export const app = true;\n");
    const manifest = {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{ id: "app", ownedPaths: ["src/app/**"], publicEntry: "src/app/public.ts", publicSymbols: ["app"], consumes: [], producesArtifacts: [] }],
    };
    initGit(rootDir);
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-m", "base"]);
    fs.appendFileSync(path.join(rootDir, "src/app/public.ts"), "export const changed = true;\n");
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-m", "Bad commit"]);
    const result = checkCommitEvidence({ rootDir, manifest, commit: "HEAD" });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.ruleId === "CELLFENCE_COMMIT_EVIDENCE_MISSING"));
    assert.ok(result.findings.some((finding) => finding.ruleId === "CELLFENCE_COMMIT_TRAILER_MISSING"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CLI exposes service-manifest import and verify commands", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-cli-service-import-"));
  try {
    fs.mkdirSync(path.join(rootDir, "systems/app"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "systems/app/public.ts"), "export const app = true;\n");
    writeJson(path.join(rootDir, "systems/app/service.json"), {
      serviceId: "app",
      ownedPaths: ["systems/app/**"],
      allowedServiceImports: [],
      consumes: { systems: [] },
      produces: { exports: { entry: "systems/app/public.ts", symbols: ["app"] } },
    });
    const init = spawnSync("node", [CLI_PATH, "init", "--from", "systems/*/service.json"], { cwd: rootDir, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    const verify = spawnSync("node", [CLI_PATH, "manifest", "verify", "--from", "systems/*/service.json", "--json"], { cwd: rootDir, encoding: "utf8" });
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
    const parsed = JSON.parse(verify.stdout);
    assert.equal(parsed.ok, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
