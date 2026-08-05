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
  mutationScopesForFiles,
  normalizeRepositoryPath,
  validateMutationScopeCoverage,
} from "../scripts/mutation-scopes.mjs";
import {
  collectChangedFiles,
  parseMutationChangedArgs,
  resolveMutationBaseRef,
} from "../scripts/mutation-changed.mjs";

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
});

test("mutation scopes select source and compiled paths with cross-platform normalization", () => {
  assert.equal(normalizeRepositoryPath(".\\packages\\engine\\src\\file-index.ts"), "packages/engine/src/file-index.ts");
  assert.deepEqual(
    mutationScopesForFiles([
      "packages/engine/src/file-index.ts",
      "packages\\schema\\dist\\index.js",
      "README.md",
    ]).map((scope) => scope.id),
    ["schema", "engine-file-index"],
  );
});

test("changed mutation config keeps full thresholds and isolates tests and caches", () => {
  const scope = MUTATION_SCOPES.find((candidate) => candidate.id === "engine-command-execution");
  const config = createChangedMutationConfig(baseMutationConfig, scope);
  assert.deepEqual(config.thresholds, { high: 100, low: 100, break: 100 });
  assert.deepEqual(config.mutate, ["packages/engine/dist/command-execution.js"]);
  assert.equal(config.commandRunner.command, "node --test tests/command-execution.test.mjs");
  assert.equal(config.incremental, true);
  assert.equal(config.incrementalFile, "reports/mutation/incremental/engine-command-execution.json");
  assert.equal(config.jsonReporter.fileName, "reports/mutation/changed/engine-command-execution.json");
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
  assert.deepEqual(collectChangedFiles(base, "HEAD", rootDir), [
    "packages/engine/src/file-index.ts",
    "staged.txt",
    "unstaged.txt",
    "untracked.txt",
  ]);
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
    "--force", "--no-incremental", "--plan", "--dry-run-only",
  ]), {
    baseRef: "origin/main",
    headRef: "HEAD",
    files: ["a.ts", "b.ts", "c.ts"],
    force: true,
    incremental: false,
    plan: true,
    dryRunOnly: true,
  });
  assert.throws(() => parseMutationChangedArgs(["--base"]), /--base requires a value/);
  assert.throws(() => parseMutationChangedArgs(["--unknown"]), /Unknown option/);
});

test("mutation changed plan reports the exact target and dedicated tests", () => {
  const result = spawnSync(process.execPath, [
    scriptPath,
    "--files",
    "packages/engine/src/file-index.ts,README.md",
    "--base",
    "HEAD",
    "--plan",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Scope engine-file-index: packages\/engine\/dist\/file-index\.js/);
  assert.match(result.stdout, /tests\/file-index\.test\.mjs/);
  assert.doesNotMatch(result.stdout, /tests\/module-resolution\.test\.mjs/);
});
