import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import baseMutationConfig from "../stryker.conf.mjs";
import {
  MUTATION_SCOPES,
  mutationScopeById,
  mutationScopesForFiles,
  normalizeRepositoryPath,
  validateMutationScopeCoverage,
} from "./mutation-scopes.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");

function gitOutput(args, rootDir = repositoryRoot) {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8" });
}

function nulSeparatedPaths(output) {
  return output.split("\0").filter(Boolean).map(normalizeRepositoryPath);
}

export function parseMutationChangedArgs(args) {
  const options = {
    baseRef: undefined,
    headRef: "HEAD",
    files: [],
    scopes: [],
    force: false,
    incremental: true,
    plan: false,
    dryRunOnly: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--base" || argument === "--head" || argument === "--file" || argument === "--files" || argument === "--scope") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--base") options.baseRef = value;
      if (argument === "--head") options.headRef = value;
      if (argument === "--file") options.files.push(value);
      if (argument === "--files") options.files.push(...value.split(",").filter(Boolean));
      if (argument === "--scope") options.scopes.push(value);
      continue;
    }
    if (argument === "--force") options.force = true;
    else if (argument === "--no-incremental") options.incremental = false;
    else if (argument === "--plan") options.plan = true;
    else if (argument === "--dry-run-only") options.dryRunOnly = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function gitRefExists(ref, rootDir = repositoryRoot) {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: rootDir,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveMutationBaseRef(rootDir = repositoryRoot, environment = process.env) {
  const candidates = [environment.CELLFENCE_MUTATION_BASE, "origin/main", "main", "HEAD~1"].filter(Boolean);
  const baseRef = candidates.find((candidate) => gitRefExists(candidate, rootDir));
  if (!baseRef) {
    throw new Error("Unable to resolve a mutation base ref; pass --base or set CELLFENCE_MUTATION_BASE");
  }
  return baseRef;
}

export function collectChangedFiles(baseRef, headRef = "HEAD", rootDir = repositoryRoot) {
  const changed = new Set(nulSeparatedPaths(gitOutput([
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--diff-filter=ACMRD",
    `${baseRef}...${headRef}`,
  ], rootDir)));

  if (headRef === "HEAD") {
    for (const args of [
      ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=ACMRD", "HEAD"],
      ["diff", "--cached", "--name-only", "-z", "--no-renames", "--diff-filter=ACMRD", "HEAD"],
      ["ls-files", "--others", "--exclude-standard", "-z"],
    ]) {
      for (const filePath of nulSeparatedPaths(gitOutput(args, rootDir))) changed.add(filePath);
    }
  }

  return [...changed].sort();
}

function runScope(scope, options) {
  fs.mkdirSync(path.join(repositoryRoot, "reports/mutation/changed"), { recursive: true });
  fs.mkdirSync(path.join(repositoryRoot, "reports/mutation/incremental"), { recursive: true });
  const strykerPath = path.join(repositoryRoot, "node_modules/@stryker-mutator/core/bin/stryker.js");
  const args = [strykerPath, "run", "stryker.changed.conf.mjs"];
  if (options.force) args.push("--force");
  if (options.dryRunOnly) args.push("--dryRunOnly");
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CELLFENCE_MUTATION_SCOPE: scope.id,
      CELLFENCE_MUTATION_INCREMENTAL: options.incremental ? "1" : "0",
    },
    stdio: "inherit",
  });
  const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  const execution = {
    id: scope.id,
    mutate: scope.mutate,
    tests: scope.tests,
    elapsedMs: Math.round(Number(elapsedSeconds) * 1000),
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message,
    status: !result.error && result.status === 0 ? "passed" : "failed",
  };
  console.log(`Mutation scope ${scope.id} ${execution.status} in ${elapsedSeconds}s`);
  return execution;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

function gitRevision(ref, rootDir = repositoryRoot) {
  try {
    return gitOutput(["rev-parse", `${ref}^{commit}`], rootDir).trim();
  } catch {
    return null;
  }
}

export function mutationChangedPlan(options, rootDir = repositoryRoot) {
  validateMutationScopeCoverage(baseMutationConfig.mutate);
  const explicitScopes = options.scopes.map((scopeId) => {
    const scope = mutationScopeById(scopeId);
    if (!scope) throw new Error(`Unknown mutation scope: ${scopeId}`);
    return scope;
  });
  const explicitSelection = options.files.length > 0 || explicitScopes.length > 0;
  const baseRef = options.baseRef ?? (explicitSelection ? "HEAD" : resolveMutationBaseRef(rootDir));
  const changedFiles = options.files.length > 0
    ? [...new Set(options.files.map(normalizeRepositoryPath))].sort()
    : explicitScopes.length > 0 ? [] : collectChangedFiles(baseRef, options.headRef, rootDir);
  const scopes = explicitScopes.length > 0
    ? MUTATION_SCOPES.filter((scope) => explicitScopes.some((selected) => selected.id === scope.id))
    : mutationScopesForFiles(changedFiles);
  return {
    baseRef,
    headRef: options.headRef,
    baseSha: gitRevision(baseRef, rootDir),
    headSha: gitRevision(options.headRef, rootDir),
    changedFiles,
    scopes,
  };
}

export function createMutationSummary(plan, executions, startedAt, completedAt = new Date().toISOString(), reason) {
  return {
    schemaVersion: "cellfence.mutation-summary.v1",
    startedAt,
    completedAt,
    baseRef: plan.baseRef,
    headRef: plan.headRef,
    baseSha: plan.baseSha,
    headSha: plan.headSha,
    changedFiles: plan.changedFiles,
    executions,
    ok: executions.every((execution) => execution.status === "passed"),
    ...(reason ? { reason } : {}),
  };
}

export function main(args = process.argv.slice(2)) {
  const options = parseMutationChangedArgs(args);
  const plan = mutationChangedPlan(options);
  const reportRoot = path.join(repositoryRoot, "reports/mutation/changed");
  writeJsonAtomic(path.join(reportRoot, "plan.json"), {
    schemaVersion: "cellfence.mutation-plan.v1",
    ...plan,
  });
  console.log(`Mutation diff: ${plan.baseRef}...${plan.headRef}`);
  console.log(`Changed files considered: ${plan.changedFiles.length}`);
  if (plan.scopes.length === 0) {
    const timestamp = new Date().toISOString();
    writeJsonAtomic(
      path.join(reportRoot, "summary.json"),
      createMutationSummary(plan, [], timestamp, timestamp, "no mutation-covered files changed"),
    );
    console.log("No mutation-covered production files changed; scoped mutation has nothing to run.");
    return;
  }
  for (const scope of plan.scopes) {
    console.log(`Scope ${scope.id}: ${scope.mutate} -> ${scope.tests.join(", ")}`);
  }
  if (options.plan) return;
  const startedAt = new Date().toISOString();
  const executions = [];
  for (const scope of plan.scopes) executions.push(runScope(scope, options));
  const summary = createMutationSummary(plan, executions, startedAt);
  writeJsonAtomic(path.join(reportRoot, "summary.json"), summary);
  if (!summary.ok) {
    const failedScopes = executions.filter((execution) => execution.status === "failed").map((execution) => execution.id);
    throw new Error(`Mutation scopes failed: ${failedScopes.join(", ")}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
