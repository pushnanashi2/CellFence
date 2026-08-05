import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import baseMutationConfig from "../stryker.conf.mjs";
import {
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
    force: false,
    incremental: true,
    plan: false,
    dryRunOnly: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--base" || argument === "--head" || argument === "--file" || argument === "--files") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--base") options.baseRef = value;
      if (argument === "--head") options.headRef = value;
      if (argument === "--file") options.files.push(value);
      if (argument === "--files") options.files.push(...value.split(",").filter(Boolean));
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
    "--diff-filter=ACMR",
    `${baseRef}...${headRef}`,
  ], rootDir)));

  if (headRef === "HEAD") {
    for (const args of [
      ["diff", "--name-only", "-z", "--diff-filter=ACMR", "HEAD"],
      ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR", "HEAD"],
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
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Mutation scope ${scope.id} failed with exit code ${result.status ?? "unknown"}`);
  }
  const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  console.log(`Mutation scope ${scope.id} passed in ${elapsedSeconds}s`);
}

export function mutationChangedPlan(options, rootDir = repositoryRoot) {
  validateMutationScopeCoverage(baseMutationConfig.mutate);
  const baseRef = options.baseRef ?? resolveMutationBaseRef(rootDir);
  const changedFiles = options.files.length > 0
    ? [...new Set(options.files.map(normalizeRepositoryPath))].sort()
    : collectChangedFiles(baseRef, options.headRef, rootDir);
  return {
    baseRef,
    headRef: options.headRef,
    changedFiles,
    scopes: mutationScopesForFiles(changedFiles),
  };
}

export function main(args = process.argv.slice(2)) {
  const options = parseMutationChangedArgs(args);
  const plan = mutationChangedPlan(options);
  console.log(`Mutation diff: ${plan.baseRef}...${plan.headRef}`);
  console.log(`Changed files considered: ${plan.changedFiles.length}`);
  if (plan.scopes.length === 0) {
    console.log("No mutation-covered production files changed; scoped mutation has nothing to run.");
    return;
  }
  for (const scope of plan.scopes) {
    console.log(`Scope ${scope.id}: ${scope.mutate} -> ${scope.tests.join(", ")}`);
  }
  if (options.plan) return;
  for (const scope of plan.scopes) runScope(scope, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
