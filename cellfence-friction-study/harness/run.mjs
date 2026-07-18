#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const studyRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(studyRoot, "..");

function parseArgs(argv) {
  const args = {
    fixtures: path.join(studyRoot, "fixtures"),
    results: path.join(studyRoot, "results"),
    conditions: path.join(studyRoot, "harness", "conditions.example.json"),
    mode: "simulate-updated",
    repeats: 1,
    limit: 0,
    agentCommand: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fixtures") args.fixtures = path.resolve(argv[++index]);
    else if (arg === "--results") args.results = path.resolve(argv[++index]);
    else if (arg === "--conditions") args.conditions = path.resolve(argv[++index]);
    else if (arg === "--mode") args.mode = argv[++index];
    else if (arg === "--repeats") args.repeats = Number(argv[++index]);
    else if (arg === "--limit") args.limit = Number(argv[++index]);
    else if (arg === "--agent-command") args.agentCommand = argv[++index];
    else if (arg === "--help") {
      console.log("Usage: run.mjs [--mode simulate-updated|simulate-hand-edit|simulate-rule-disabled|external] [--repeats 1] [--limit n] [--agent-command command]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!["simulate-updated", "simulate-hand-edit", "simulate-rule-disabled", "external"].includes(args.mode)) {
    throw new Error(`unsupported mode ${args.mode}`);
  }
  if (args.mode === "external" && !args.agentCommand) {
    throw new Error("--agent-command is required for --mode external");
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(sourcePath), targetPath);
    else fs.copyFileSync(sourcePath, targetPath);
  }
}

function conditionCommand(condition) {
  return condition.cellfenceCommand.map((part) => part.replaceAll("{repoRoot}", repoRoot).replaceAll("{studyRoot}", studyRoot));
}

function createRunner(logPath, condition) {
  const cellfenceCommand = conditionCommand(condition);
  const envBase = {
    ...process.env,
    ...(condition.env || {}),
  };
  function run(argv, options = {}) {
    const startedAt = new Date().toISOString();
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: { ...envBase, ...(options.env || {}) },
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      shell: Boolean(options.shell),
    });
    const record = {
      startedAt,
      cwd: options.cwd,
      argv,
      command: argv.join(" "),
      status: result.status,
      signal: result.signal,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
    return record;
  }
  return {
    run,
    cellfence(args, options = {}) {
      return run([...cellfenceCommand, ...args], options);
    },
  };
}

function setupGit(runner, repoDir) {
  runner.run(["git", "init", "-q"], { cwd: repoDir });
  runner.run(["git", "config", "user.email", "cellfence-study@example.invalid"], { cwd: repoDir });
  runner.run(["git", "config", "user.name", "CellFence Study"], { cwd: repoDir });
  runner.run(["git", "add", "."], { cwd: repoDir });
  runner.run(["git", "commit", "-m", "initial fixture", "-q"], { cwd: repoDir });
}

function applyFixtureChange(runner, fixtureDir, repoDir) {
  runner.run(["node", path.join(fixtureDir, "apply-change.mjs")], { cwd: repoDir });
}

function weakenRatchetRules(manifestPath) {
  const manifest = readJson(manifestPath);
  manifest.rules = {
    ...(manifest.rules || {}),
    CELLFENCE_RATCHET_PUBLIC_SYMBOL_SET_CHANGE: "off",
    CELLFENCE_RATCHET_DEPENDENCY_EDGE_CHANGE: "off",
    CELLFENCE_RATCHET_PUBLIC_SURFACE_SIGNATURE_CHANGE: "off",
  };
  writeJson(manifestPath, manifest);
}

function finalCheck(runner, repoDir) {
  return runner.cellfence(["baseline", "check"], { cwd: repoDir });
}

function runAgentMode(args, runner, condition, fixtureDir, repoDir, taskPath, logPath) {
  if (args.mode === "simulate-updated") {
    runner.cellfence(["baseline", "check"], { cwd: repoDir });
    runner.cellfence(["baseline", "update"], { cwd: repoDir });
    return finalCheck(runner, repoDir);
  }
  if (args.mode === "simulate-hand-edit") {
    runner.cellfence(["baseline", "check"], { cwd: repoDir });
    const candidate = path.join(repoDir, ".candidate-baseline.json");
    runner.cellfence(["baseline", "create", "--baseline", candidate], { cwd: repoDir });
    fs.copyFileSync(candidate, path.join(repoDir, "cellfence.baseline.json"));
    return finalCheck(runner, repoDir);
  }
  if (args.mode === "simulate-rule-disabled") {
    runner.cellfence(["baseline", "check"], { cwd: repoDir });
    weakenRatchetRules(path.join(repoDir, "cellfence.manifest.json"));
    return finalCheck(runner, repoDir);
  }
  const env = {
    CELLFENCE_STUDY_REPO: repoDir,
    CELLFENCE_STUDY_TASK: fs.readFileSync(taskPath, "utf8"),
    CELLFENCE_STUDY_CONDITION: condition.id,
    CELLFENCE_STUDY_FIXTURE: path.basename(fixtureDir),
    CELLFENCE_STUDY_CELLFENCE: conditionCommand(condition).join(" "),
    CELLFENCE_STUDY_COMMAND_LOG: logPath,
  };
  runner.run([args.agentCommand], { cwd: repoDir, env, shell: true });
  return finalCheck(runner, repoDir);
}

function sortedFixtureDirs(fixturesRoot) {
  return fs.readdirSync(fixturesRoot)
    .filter((entry) => fs.existsSync(path.join(fixturesRoot, entry, "label.json")))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.join(fixturesRoot, entry));
}

const args = parseArgs(process.argv.slice(2));
const conditionConfig = readJson(args.conditions);
const conditions = conditionConfig.conditions || [];
if (conditions.length < 1) throw new Error("condition file must contain at least one condition");

const fixtureDirs = sortedFixtureDirs(args.fixtures);
const selectedFixtures = args.limit > 0 ? fixtureDirs.slice(0, args.limit) : fixtureDirs;
if (selectedFixtures.length === 0) throw new Error(`no fixtures found in ${args.fixtures}`);

const trialsRoot = path.join(args.results, "trials");
fs.mkdirSync(trialsRoot, { recursive: true });

let trialCount = 0;
for (const condition of conditions) {
  for (const fixtureDir of selectedFixtures) {
    for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
      const fixtureId = path.basename(fixtureDir);
      const trialId = `${condition.id}__${fixtureId}__r${repeat}`;
      const trialDir = path.join(trialsRoot, trialId);
      fs.rmSync(trialDir, { recursive: true, force: true });
      fs.mkdirSync(trialDir, { recursive: true });
      const repoDir = path.join(trialDir, "repo");
      copyDir(path.join(fixtureDir, "repo"), repoDir);
      const logPath = path.join(trialDir, "command-log.jsonl");
      const runner = createRunner(logPath, condition);

      setupGit(runner, repoDir);
      runner.cellfence(["baseline", "create"], { cwd: repoDir });
      runner.run(["git", "add", "."], { cwd: repoDir });
      runner.run(["git", "commit", "-m", "accept baseline", "-q"], { cwd: repoDir });
      fs.copyFileSync(path.join(repoDir, "cellfence.baseline.json"), path.join(trialDir, "baseline-before.json"));
      fs.copyFileSync(path.join(repoDir, "cellfence.manifest.json"), path.join(trialDir, "manifest-before.json"));

      applyFixtureChange(runner, fixtureDir, repoDir);
      const finalResult = runAgentMode(args, runner, condition, fixtureDir, repoDir, path.join(fixtureDir, "task.md"), logPath);
      fs.copyFileSync(path.join(repoDir, "cellfence.baseline.json"), path.join(trialDir, "baseline-after.json"));
      fs.copyFileSync(path.join(repoDir, "cellfence.manifest.json"), path.join(trialDir, "manifest-after.json"));
      const diff = runner.run(["git", "diff", "--", "."], { cwd: repoDir });
      fs.writeFileSync(path.join(trialDir, "final.diff"), diff.stdout);
      fs.copyFileSync(path.join(fixtureDir, "label.json"), path.join(trialDir, "label.json"));
      fs.copyFileSync(path.join(fixtureDir, "task.md"), path.join(trialDir, "task.md"));
      writeJson(path.join(trialDir, "trial.json"), {
        trialId,
        condition: condition.id,
        fixture: fixtureId,
        mode: args.mode,
        repeat,
        finalCheckStatus: finalResult.status,
        repoPath: "repo",
      });
      trialCount += 1;
    }
  }
}

console.log(`ran ${trialCount} trials into ${trialsRoot}`);
