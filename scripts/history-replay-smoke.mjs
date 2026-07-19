#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkDir = path.join(repoRoot, "tmp", "history-replay-smoke");
const defaultOutPath = path.join(repoRoot, "reports", "history-replay-smoke.json");

function usage() {
  console.error(`Usage: node scripts/history-replay-smoke.mjs [--workdir tmp/history-replay-smoke] [--out reports/history-replay-smoke.json]

Creates a local git fixture with a clean before commit and a private-import
after commit, then runs scripts/history-replay-study.mjs against exact commits.
This is a smoke test for the replay mechanism, not public-OSS precision evidence.`);
}

function parseArgs(argv) {
  const parsed = {
    workDir: defaultWorkDir,
    outPath: defaultOutPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workdir") {
      parsed.workDir = path.resolve(requireValue(argv, index, "--workdir"));
      index += 1;
    } else if (argument.startsWith("--workdir=")) {
      parsed.workDir = path.resolve(requireInlineValue(argument, "--workdir=", "--workdir"));
    } else if (argument === "--out") {
      parsed.outPath = path.resolve(requireValue(argv, index, "--out"));
      index += 1;
    } else if (argument.startsWith("--out=")) {
      parsed.outPath = path.resolve(requireInlineValue(argument, "--out=", "--out"));
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.workDir) throw new Error("--workdir requires a non-empty path");
  if (!parsed.outPath) throw new Error("--out requires a non-empty path");
  return parsed;
}

function requireValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${optionName} requires a value`);
  return value;
}

function requireInlineValue(argument, prefix, optionName) {
  const value = argument.slice(prefix.length);
  if (!value) throw new Error(`${optionName} requires a value`);
  return value;
}

function writeFile(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${Array.isArray(lines) ? lines.join("\n") : lines}\n`);
}

function writeJson(filePath, value) {
  writeFile(filePath, JSON.stringify(value, null, 2));
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
      LC_ALL: "C",
      TZ: "UTC",
    },
    maxBuffer: 100 * 1024 * 1024,
    timeout: options.timeoutMs || 120_000,
  });
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || result.error?.message || `exit ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function createFixtureRepository(sourceDir) {
  fs.mkdirSync(sourceDir, { recursive: true });
  run("git", ["init"], { cwd: sourceDir });
  run("git", ["config", "user.email", "cellfence@example.invalid"], { cwd: sourceDir });
  run("git", ["config", "user.name", "CellFence Smoke"], { cwd: sourceDir });
  writeFile(path.join(sourceDir, "src/core/public.ts"), "export const core = true;");
  writeFile(path.join(sourceDir, "src/core/internal.ts"), "export const hidden = true;");
  writeFile(path.join(sourceDir, "src/app/public.ts"), [
    "import { core } from '../core/public';",
    "export const app = core;",
  ]);
  writeJson(path.join(sourceDir, "cellfence.manifest.json"), {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      requiredRules: [
        "CELLFENCE_PRIVATE_IMPORT",
        "CELLFENCE_UNDECLARED_CONSUMER",
        "CELLFENCE_UNOWNED_SOURCE",
      ],
    },
    cells: [
      {
        id: "app",
        ownedPaths: ["src/app/**"],
        publicEntry: "src/app/public.ts",
        publicSymbols: ["app"],
        consumes: [{ cell: "core" }],
        producesArtifacts: [],
      },
      {
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["core"],
        consumes: [],
        producesArtifacts: [],
      },
    ],
  });
  run("git", ["add", "."], { cwd: sourceDir });
  run("git", ["commit", "--quiet", "-m", "initial boundary"], { cwd: sourceDir });
  const beforeCommit = run("git", ["rev-parse", "HEAD"], { cwd: sourceDir });

  writeFile(path.join(sourceDir, "src/app/leak.ts"), [
    "import { hidden } from '../core/internal';",
    "export const leak = hidden;",
  ]);
  run("git", ["add", "."], { cwd: sourceDir });
  run("git", ["commit", "--quiet", "-m", "introduce private import"], { cwd: sourceDir });
  const afterCommit = run("git", ["rev-parse", "HEAD"], { cwd: sourceDir });
  return { beforeCommit, afterCommit };
}

function assertSmokeReport(report) {
  const subject = report.subjects?.[0];
  const introduced = subject?.introducedFindingsByRule || {};
  const baselineFindings = subject?.baselineReplay?.check?.findingsByRule || {};
  const failures = [];
  if (report.schemaVersion !== "cellfence.history-replay-study.v1") failures.push("unexpected report schema");
  if (report.summary?.replayed !== 1) failures.push("expected one replayed subject");
  if (report.summary?.singleCommitIntroductions !== 1) failures.push("expected one single-commit introduction");
  if (subject?.proofEligibility !== "counterfactual_candidate_requires_manual_label") {
    failures.push(`expected counterfactual replay candidate, got ${subject?.proofEligibility}`);
  }
  if (introduced.CELLFENCE_PRIVATE_IMPORT !== 1) failures.push("expected introduced CELLFENCE_PRIVATE_IMPORT");
  if (!baselineFindings.CELLFENCE_PRIVATE_IMPORT) failures.push("expected baseline replay private-import finding");
  if (subject?.expectation?.status !== "passed") failures.push("expected replay expectation to pass");
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  try {
    fs.mkdirSync(options.workDir, { recursive: true });
    const runDir = fs.mkdtempSync(path.join(options.workDir, "run-"));
    const sourceDir = path.join(runDir, "source");
    const replayWorkDir = path.join(runDir, "replay-work");
    const corpusPath = path.join(runDir, "corpus.json");
    const { beforeCommit, afterCommit } = createFixtureRepository(sourceDir);
    writeJson(corpusPath, {
      schemaVersion: "cellfence.history-replay.v1",
      subjects: [
        {
          id: "history-smoke-private-import",
          repository: sourceDir,
          beforeCommit,
          afterCommit,
          manifest: {
            strategy: "existing",
            path: "cellfence.manifest.json",
          },
          baseline: {
            enabled: true,
          },
          expected: {
            beforeExitCode: 0,
            afterExitCode: 1,
            introducedRuleIds: ["CELLFENCE_PRIVATE_IMPORT"],
            baselineRuleIds: ["CELLFENCE_PRIVATE_IMPORT"],
          },
        },
      ],
    });
    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    run(process.execPath, [
      path.join(repoRoot, "scripts", "history-replay-study.mjs"),
      "--corpus",
      corpusPath,
      "--workdir",
      replayWorkDir,
      "--out",
      options.outPath,
      "--clone-mode",
      "full",
    ], { cwd: repoRoot, timeoutMs: 300_000 });
    const report = JSON.parse(fs.readFileSync(options.outPath, "utf8"));
    assertSmokeReport(report);
    console.log(`history replay smoke passed: ${report.summary.replayed}/1 replayed; ${report.summary.singleCommitIntroductions}/1 single-commit introduction`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = main();
