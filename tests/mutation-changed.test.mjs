import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import baseMutationConfig from "../stryker.conf.mjs";
import {
  MUTATION_SCOPES,
  createChangedMutationConfig,
  isMutationInfrastructurePath,
  mutationScopeMatrix,
  mutationScopeTestCommand,
  mutationScopesForFiles,
  normalizeRepositoryPath,
  validateMutationGovernanceConfig,
  validateMutationScopeCoverage,
} from "../scripts/mutation-scopes.mjs";
import {
  collectChangedFiles,
  createMutationSummary,
  mutationChangedPlan,
  mutationScopesRequiringFreshRun,
  packageLockWorkspaceDirsForDiff,
  parseMutationChangedArgs,
  resolveMutationBaseRef,
  summarizeMutationJsonReport,
} from "../scripts/mutation-changed.mjs";
import {
  formatMissingMutationStepSummary,
  formatMutationStepSummary,
} from "../scripts/mutation-step-summary.mjs";

const root = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(root, "scripts/mutation-changed.mjs");

function git(rootDir, args) {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8" });
}

function createGitRepository() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-mutation-changed-"));
  git(rootDir, ["init", "-q", "-b", "main"]);
  git(rootDir, ["config", "user.name", "CellFence Test"]);
  git(rootDir, ["config", "user.email", "test@example.com"]);
  fs.mkdirSync(path.join(rootDir, "packages/engine/src"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "packages/engine/src/file-index.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(rootDir, "unstaged.txt"), "base\n");
  git(rootDir, ["add", "."]);
  git(rootDir, ["commit", "-qm", "base"]);
  return rootDir;
}

test("mutation scope map exactly covers the full Stryker mutate set", () => {
  assert.doesNotThrow(() => validateMutationScopeCoverage(baseMutationConfig.mutate));
  assert.doesNotThrow(() => validateMutationGovernanceConfig(baseMutationConfig, { requireNonIncremental: true }));
  assert.equal(MUTATION_SCOPES.length, baseMutationConfig.mutate.length);
  assert.throws(
    () => validateMutationScopeCoverage([...baseMutationConfig.mutate, "packages/new/dist/index.js"]),
    /missing scopes: packages\/new\/dist\/index\.js/,
  );
  assert.throws(
    () => validateMutationScopeCoverage(baseMutationConfig.mutate, [
      ...MUTATION_SCOPES,
      { ...MUTATION_SCOPES[0], tests: [] },
    ]),
    /duplicate scope ids: schema.*duplicate sources: packages\/schema\/src\/index\.ts.*duplicate scoped targets: packages\/schema\/dist\/index\.js.*scopes without tests: schema/,
  );
  assert.throws(
    () => validateMutationGovernanceConfig({
      ...baseMutationConfig,
      thresholds: { high: 99, low: 100, break: 100 },
    }, { requireNonIncremental: true }),
    /thresholds\.high must be 100/,
  );
  assert.throws(
    () => validateMutationGovernanceConfig({ ...baseMutationConfig, incremental: true }, { requireNonIncremental: true }),
    /full mutation config incremental must be false/,
  );
});

test("mutation matrix is stable and exactly covers the authoritative targets", () => {
  const matrix = mutationScopeMatrix();
  assert.deepEqual(matrix.map((entry) => entry.id), MUTATION_SCOPES.map((scope) => scope.id));
  assert.deepEqual(matrix.map((entry) => entry.source), MUTATION_SCOPES.map((scope) => scope.source));
  const result = spawnSync(process.execPath, [path.join(root, "scripts/mutation-matrix.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { include: matrix });
});

test("mutation scopes select source and compiled paths with cross-platform normalization", () => {
  assert.equal(normalizeRepositoryPath(".\\packages\\engine\\src\\file-index.ts"), "packages/engine/src/file-index.ts");
  assert.equal(
    normalizeRepositoryPath(path.join(root, "packages/engine/src/file-index.ts"), root),
    "packages/engine/src/file-index.ts",
  );
  assert.equal(
    normalizeRepositoryPath("C:\\repo\\packages\\engine\\src\\file-index.ts", "C:\\repo"),
    "packages/engine/src/file-index.ts",
  );
  assert.throws(
    () => normalizeRepositoryPath(path.join(os.tmpdir(), "outside.ts"), root),
    /outside the repository/,
  );
  assert.deepEqual(
    mutationScopesForFiles([
      "packages/engine/src/file-index.ts",
      "packages\\schema\\dist\\index.js",
      "packages/github-action-baseline-gate/src/baseline-gate.ts",
      "README.md",
    ]).map((scope) => scope.id),
    [
      "schema",
      "engine-module-resolution",
      "engine-file-index",
      "engine-glob-overlap",
      "engine-resource-access",
      "github-action-baseline-gate",
    ],
  );
  assert.deepEqual(
    mutationScopesForFiles(["packages/engine/src/glob.ts"]).map((scope) => scope.id),
    ["engine-file-index"],
  );
  assert.deepEqual(
    mutationScopesForFiles(["packages/plugin-agent-budget/src/glob.ts"]).map((scope) => scope.id),
    ["plugin-agent-budget"],
  );
  assert.deepEqual(
    mutationScopesForFiles(["packages/plugin-blast-radius/src/glob.ts"]).map((scope) => scope.id),
    ["plugin-blast-radius"],
  );
  assert.deepEqual(
    mutationScopesForFiles(["packages/engine/src/python-inspector-runner.ts"]).map((scope) => scope.id),
    ["engine-module-resolution", "engine-resource-access"],
  );
  assert.deepEqual(
    mutationScopesForFiles(["packages/schema/schemas/manifest.schema.json"]).map((scope) => scope.id),
    ["schema"],
  );
});

test("changed mutation config keeps full thresholds and isolates tests and caches", () => {
  const scope = MUTATION_SCOPES.find((candidate) => candidate.id === "engine-command-execution");
  const config = createChangedMutationConfig(baseMutationConfig, scope);
  assert.deepEqual(config.thresholds, { high: 100, low: 100, break: 100 });
  assert.deepEqual(config.mutate, ["packages/engine/dist/command-execution.js"]);
  assert.equal(config.commandRunner.command, "node --test tests/command-execution.test.mjs");
  assert.equal(config.concurrency, baseMutationConfig.concurrency);
  assert.equal(config.incremental, true);
  assert.equal(config.incrementalFile, "reports/mutation/incremental/engine-command-execution.json");
  assert.equal(config.jsonReporter.fileName, "reports/mutation/changed/engine-command-execution.json");
  assert.equal(path.isAbsolute(config.tempDirName), true);
  assert.doesNotMatch(config.tempDirName, /\/\.stryker-tmp\//);
  assert.ok(config.ignorePatterns.includes("/.stryker-tmp"));
  assert.ok(config.ignorePatterns.includes("/tmp"));

  const parallelConfig = createChangedMutationConfig(baseMutationConfig, scope, { outerJobs: 3 });
  assert.equal(parallelConfig.concurrency, 1);

  const heavyScope = MUTATION_SCOPES.find((candidate) => candidate.id === "engine-module-resolution");
  const heavyParallelConfig = createChangedMutationConfig(baseMutationConfig, heavyScope, { outerJobs: 3 });
  assert.equal(heavyParallelConfig.concurrency, 2);
});

test("official plugin mutation scopes run only matching plugin tests", () => {
  const adapterScope = MUTATION_SCOPES.find((candidate) => candidate.id === "adapter-opentelemetry");
  assert.equal(
    mutationScopeTestCommand(adapterScope),
    "node --test --test-name-pattern 'opentelemetry adapter handles|opentelemetry adapter mutation smoke|opentelemetry adapter ignores|opentelemetry adapter covers|opentelemetry adapter preserves|opentelemetry adapter applies|opentelemetry adapter recognizes|opentelemetry adapter distinguishes' tests/official-plugins.test.mjs",
  );

  const schemaScope = MUTATION_SCOPES.find((candidate) => candidate.id === "schema");
  assert.equal(
    mutationScopeTestCommand(schemaScope),
    "node --test tests/schema-validation.test.mjs && node --test --test-name-pattern 'opentelemetry adapter handles|opentelemetry adapter mutation smoke|opentelemetry adapter ignores|opentelemetry adapter covers|opentelemetry adapter preserves|opentelemetry adapter applies|opentelemetry adapter recognizes|opentelemetry adapter distinguishes' tests/official-plugins.test.mjs",
  );
});

test("changed file collection includes committed, staged, unstaged, and untracked paths", (context) => {
  const rootDir = createGitRepository();
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const base = git(rootDir, ["rev-parse", "HEAD"]).trim();
  fs.writeFileSync(path.join(rootDir, "packages/engine/src/file-index.ts"), "export const value = 2;\n");
  git(rootDir, ["add", "packages/engine/src/file-index.ts"]);
  git(rootDir, ["commit", "-qm", "committed change"]);
  fs.writeFileSync(path.join(rootDir, "staged.txt"), "staged\n");
  git(rootDir, ["add", "staged.txt"]);
  fs.writeFileSync(path.join(rootDir, "unstaged.txt"), "changed\n");
  fs.writeFileSync(path.join(rootDir, "untracked.txt"), "untracked\n");
  const headSha = git(rootDir, ["rev-parse", "HEAD"]).trim();
  assert.deepEqual(collectChangedFiles(base, "HEAD", rootDir), [
    "packages/engine/src/file-index.ts",
    "staged.txt",
    "unstaged.txt",
    "untracked.txt",
  ]);
  assert.deepEqual(collectChangedFiles(base, headSha, rootDir), [
    "packages/engine/src/file-index.ts",
    "staged.txt",
    "unstaged.txt",
    "untracked.txt",
  ]);
});

test("changed file collection preserves deleted paths and both sides of renames", (context) => {
  const rootDir = createGitRepository();
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(rootDir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "tests/file-index.test.mjs"), "// covered test\n");
  fs.writeFileSync(path.join(rootDir, "tests/old-name.test.mjs"), "// renamed test\n");
  git(rootDir, ["add", "."]);
  git(rootDir, ["commit", "-qm", "add tests"]);
  const base = git(rootDir, ["rev-parse", "HEAD"]).trim();
  fs.rmSync(path.join(rootDir, "tests/file-index.test.mjs"));
  fs.renameSync(path.join(rootDir, "tests/old-name.test.mjs"), path.join(rootDir, "tests/new-name.test.mjs"));
  git(rootDir, ["add", "-A"]);
  git(rootDir, ["commit", "-qm", "delete and rename tests"]);
  assert.deepEqual(collectChangedFiles(base, "HEAD", rootDir), [
    "tests/file-index.test.mjs",
    "tests/new-name.test.mjs",
    "tests/old-name.test.mjs",
  ]);
});

test("changed file collection preserves git type changes", (context) => {
  const rootDir = createGitRepository();
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(rootDir, "type-change-target.txt"), "base\n");
  git(rootDir, ["add", "."]);
  git(rootDir, ["commit", "-qm", "add regular file"]);
  const base = git(rootDir, ["rev-parse", "HEAD"]).trim();
  fs.rmSync(path.join(rootDir, "type-change-target.txt"));
  fs.symlinkSync("packages/engine/src/file-index.ts", path.join(rootDir, "type-change-target.txt"));
  git(rootDir, ["add", "-A"]);
  git(rootDir, ["commit", "-qm", "change file type"]);
  assert.deepEqual(collectChangedFiles(base, "HEAD", rootDir), ["type-change-target.txt"]);
});

test("base ref resolution honors an explicit environment ref and falls back locally", (context) => {
  const rootDir = createGitRepository();
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  assert.equal(resolveMutationBaseRef(rootDir, { CELLFENCE_MUTATION_BASE: "HEAD" }), "HEAD");
  assert.equal(resolveMutationBaseRef(rootDir, {}), "main");
});

test("mutation changed argument parsing rejects missing and unknown options", () => {
  assert.deepEqual(parseMutationChangedArgs([
    "--base", "origin/main", "--head", "HEAD", "--files", "a.ts,b.ts", "--file", "c.ts",
    "--jobs", "3", "--force", "--no-incremental", "--plan", "--dry-run-only",
  ]), {
    baseRef: "origin/main",
    headRef: "HEAD",
    files: ["a.ts", "b.ts", "c.ts"],
    scopes: [],
    force: true,
    incremental: false,
    plan: true,
    dryRunOnly: true,
    jobs: 3,
  });
  assert.throws(() => parseMutationChangedArgs(["--base"]), /--base requires a value/);
  assert.throws(() => parseMutationChangedArgs(["--jobs", "0"]), /integer from 1 to 4/);
  assert.throws(() => parseMutationChangedArgs(["--jobs", "5"]), /integer from 1 to 4/);
  assert.throws(() => parseMutationChangedArgs(["--unknown"]), /Unknown option/);
});

test("mutation summary preserves failed scope evidence before the runner exits", () => {
  const plan = {
    baseRef: "base",
    headRef: "head",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    changedFiles: ["packages/engine/src/file-index.ts"],
  };
  const executions = [{ id: "engine-file-index", status: "failed", exitCode: 1, elapsedMs: 12 }];
  assert.deepEqual(createMutationSummary(plan, executions, "start", "end"), {
    schemaVersion: "cellfence.mutation-summary.v1",
    startedAt: "start",
    completedAt: "end",
    baseRef: "base",
    headRef: "head",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    changedFiles: ["packages/engine/src/file-index.ts"],
    executions,
    ok: false,
  });
});

test("mutation summary records a successful no-work decision", () => {
  const plan = {
    baseRef: "base",
    headRef: "head",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    changedFiles: ["README.md"],
  };
  assert.deepEqual(createMutationSummary(plan, [], "start", "end", "no mutation-covered files changed"), {
    schemaVersion: "cellfence.mutation-summary.v1",
    startedAt: "start",
    completedAt: "end",
    baseRef: "base",
    headRef: "head",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    changedFiles: ["README.md"],
    executions: [],
    ok: true,
    reason: "no mutation-covered files changed",
  });
});

test("mutation summary can roll up Stryker JSON results", (context) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-mutation-report-"));
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const reportPath = path.join(rootDir, "scope.json");
  fs.writeFileSync(reportPath, `${JSON.stringify({
    files: {
      "packages/example.js": {
        mutants: [
          { status: "Killed" },
          { status: "Timeout" },
          { status: "Survived" },
          { status: "NoCoverage" },
          { status: "RuntimeError" },
          { status: "CompileError" },
          { status: "Ignored" },
        ],
      },
    },
  })}\n`);
  assert.deepEqual(summarizeMutationJsonReport(reportPath), {
    total: 4,
    killed: 1,
    timeout: 1,
    survived: 1,
    noCoverage: 1,
    runtimeErrors: 1,
    compileErrors: 1,
    ignored: 1,
    mutationScore: 50,
  });
  assert.equal(summarizeMutationJsonReport(path.join(rootDir, "missing.json")), undefined);
});

test("mutation step summary renders scope rollups and missing-summary evidence", () => {
  const markdown = formatMutationStepSummary({
    ok: false,
    baseRef: "origin/main",
    headRef: "HEAD",
    changedFiles: ["scripts/mutation-changed.mjs"],
    executions: [{
      id: "engine-file-index",
      status: "failed",
      elapsedMs: 1200,
      reportPath: "reports/mutation/changed/engine-file-index.json",
      result: {
        mutationScore: 99.5,
        killed: 199,
        timeout: 1,
        survived: 1,
        noCoverage: 0,
        runtimeErrors: 1,
        compileErrors: 1,
      },
    }],
  });
  assert.match(markdown, /## CellFence Mutation/);
  assert.match(markdown, /origin\/main\.\.\.HEAD/);
  assert.match(markdown, /engine-file-index/);
  assert.match(markdown, /99\.5/);
  assert.match(markdown, /errors/);
  assert.match(
    formatMissingMutationStepSummary(path.join(root, "reports/mutation/changed/summary.json")),
    /was not produced/,
  );
});

test("mutation changed plan reports the exact target and dedicated tests", () => {
  const result = spawnSync(process.execPath, [
    scriptPath,
    "--files",
    "packages/engine/src/command-execution.ts,README.md",
    "--base",
    "HEAD",
    "--plan",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Scope engine-command-execution: packages\/engine\/dist\/command-execution\.js/);
  assert.match(result.stdout, /tests\/command-execution\.test\.mjs/);
  assert.doesNotMatch(result.stdout, /tests\/module-resolution\.test\.mjs/);
});

test("mutation scopes rerun for dedicated source and test changes only", () => {
  const allScopeIds = MUTATION_SCOPES.map((scope) => scope.id);
  assert.deepEqual(
    mutationScopesForFiles(["tests/file-index.test.mjs"]).map((scope) => scope.id),
    ["engine-file-index", "engine-glob-overlap"],
  );
  assert.deepEqual(
    mutationScopesForFiles([
      "stryker.conf.mjs",
      "stryker.changed.conf.mjs",
      "scripts/mutation-changed.mjs",
      "scripts/mutation-scopes.mjs",
      ".github/workflows/mutation-audit.yml",
    ]).map((scope) => scope.id),
    allScopeIds,
  );
  assert.deepEqual(
    mutationScopesForFiles(["package-lock.json"]).map((scope) => scope.id),
    allScopeIds,
    "manual package-lock selection stays conservative without a parsed lockfile diff",
  );
  assert.deepEqual(
    mutationScopesForFiles(["package-lock.json"], MUTATION_SCOPES, {
      packageLockWorkspaceDirs: ["packages/engine"],
    }).map((scope) => scope.id),
    [
      "engine-module-resolution",
      "engine-command-execution",
      "engine-file-index",
      "engine-glob-overlap",
      "engine-resource-access",
    ],
  );
  assert.equal(isMutationInfrastructurePath(".github/workflows/ci.yml"), true);
  assert.deepEqual(
    mutationScopesForFiles(["tests/file-index.test.mjs"]).map((scope) => scope.id),
    ["engine-file-index", "engine-glob-overlap"],
    "a deleted dedicated test path must continue to select its mutation scopes",
  );
  assert.deepEqual(
    mutationScopesForFiles(["packages/github-action-baseline-gate/src/baseline-gate.ts"]).map((scope) => scope.id),
    ["github-action-baseline-gate"],
  );
});

test("package-lock-only changes narrow to safely attributed workspaces", (context) => {
  const rootDir = createGitRepository();
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const writePackageLock = (packages) => {
    fs.writeFileSync(path.join(rootDir, "package-lock.json"), `${JSON.stringify({
      name: "cellfence-workspace",
      lockfileVersion: 3,
      packages,
    }, null, 2)}\n`);
  };
  writePackageLock({
    "": { name: "cellfence-workspace", workspaces: ["packages/*"] },
    "packages/engine": { name: "@cellfence/engine", dependencies: { "@cellfence/schema": "0.2.1" } },
    "packages/schema": { name: "@cellfence/schema" },
  });
  git(rootDir, ["add", "package-lock.json"]);
  git(rootDir, ["commit", "-qm", "add package lock"]);
  const base = git(rootDir, ["rev-parse", "HEAD"]).trim();

  writePackageLock({
    "": { name: "cellfence-workspace", workspaces: ["packages/*"] },
    "packages/engine": { name: "@cellfence/engine", dependencies: { "@cellfence/schema": "0.2.1", typescript: "^5.5.4" } },
    "packages/schema": { name: "@cellfence/schema" },
  });

  assert.deepEqual(packageLockWorkspaceDirsForDiff(base, "HEAD", rootDir), ["packages/engine"]);
  assert.deepEqual(
    mutationChangedPlan(parseMutationChangedArgs(["--base", base]), rootDir).scopes.map((scope) => scope.id),
    [
      "engine-module-resolution",
      "engine-command-execution",
      "engine-file-index",
      "engine-glob-overlap",
      "engine-resource-access",
    ],
  );
});

test("package-lock changes fall back to every scope when attribution is shared", (context) => {
  const rootDir = createGitRepository();
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const writePackageLock = (packages) => {
    fs.writeFileSync(path.join(rootDir, "package-lock.json"), `${JSON.stringify({
      name: "cellfence-workspace",
      lockfileVersion: 3,
      packages,
    }, null, 2)}\n`);
  };
  writePackageLock({
    "": { name: "cellfence-workspace", workspaces: ["packages/*"] },
    "packages/engine": { name: "@cellfence/engine" },
  });
  git(rootDir, ["add", "package-lock.json"]);
  git(rootDir, ["commit", "-qm", "add package lock"]);
  const base = git(rootDir, ["rev-parse", "HEAD"]).trim();

  writePackageLock({
    "": { name: "cellfence-workspace", workspaces: ["packages/*"] },
    "packages/engine": { name: "@cellfence/engine" },
    "node_modules/shared-tool": { version: "1.0.0" },
  });

  assert.equal(packageLockWorkspaceDirsForDiff(base, "HEAD", rootDir), undefined);
  assert.deepEqual(
    mutationChangedPlan(parseMutationChangedArgs(["--base", base]), rootDir).scopes.map((scope) => scope.id),
    MUTATION_SCOPES.map((scope) => scope.id),
  );
});

test("dedicated test changes force a fresh incremental mutation run for their scopes", () => {
  assert.deepEqual(
    [...mutationScopesRequiringFreshRun(["tests/module-resolution.test.mjs"])],
    ["engine-module-resolution"],
  );
  assert.deepEqual(
    [...mutationScopesRequiringFreshRun(["scripts/mutation-scopes.mjs"])],
    MUTATION_SCOPES.map((scope) => scope.id),
  );
  assert.deepEqual(
    [...mutationScopesRequiringFreshRun(["packages/engine/src/glob.ts"])],
    ["engine-file-index"],
  );
  assert.deepEqual(
    [...mutationScopesRequiringFreshRun(["README.md"])],
    [],
  );
});

test("explicit scope plans retain local changed files for fresh incremental decisions", (context) => {
  const rootDir = createGitRepository();
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(rootDir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "tests/file-index.test.mjs"), "// base\n");
  git(rootDir, ["add", "."]);
  git(rootDir, ["commit", "-qm", "add scoped test"]);
  fs.writeFileSync(path.join(rootDir, "tests/file-index.test.mjs"), "// changed\n");
  const plan = mutationChangedPlan(parseMutationChangedArgs(["--scope", "engine-file-index"]), rootDir);
  assert.deepEqual(plan.changedFiles, ["tests/file-index.test.mjs"]);
  assert.deepEqual(plan.scopes.map((scope) => scope.id), ["engine-file-index"]);
  assert.deepEqual([...mutationScopesRequiringFreshRun(plan.changedFiles, plan.scopes)], ["engine-file-index"]);
});

test("mutation changed accepts an explicit stable scope id without a comparison ref", () => {
  const result = spawnSync(process.execPath, [
    scriptPath,
    "--scope",
    "engine-file-index",
    "--plan",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Scope engine-file-index:/);
  assert.doesNotMatch(result.stdout, /Scope schema:/);
});
