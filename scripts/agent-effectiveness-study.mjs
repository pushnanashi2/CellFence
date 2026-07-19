#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkDir = path.join(repoRoot, "tmp", "agent-effectiveness-study");
const defaultOutPath = path.join(repoRoot, "reports", "agent-effectiveness-study.json");
const defaultManifestPath = "cellfence.manifest.json";
const corpusSchemaVersion = "cellfence.agent-effectiveness.corpus.v1";
const scenariosSchemaVersion = "cellfence.agent-effectiveness.scenarios.v1";
const runSchemaVersion = "cellfence.agent-effectiveness.run.v1";
const judgmentSchemaVersion = "cellfence.agent-effectiveness.judgment.v1";
const commandTimeouts = {
  clone: 600_000,
  checkout: 120_000,
  revParse: 60_000,
};
const arms = ["cellfence", "control"];
const runStatuses = new Set(["planned", "completed", "failed", "blocked", "timeout"]);
const taskOutcomes = new Set(["pass", "partial", "fail", "unknown"]);
const frictionCosts = new Set(["none", "low", "medium", "high", "unknown"]);
const promiseLabels = new Set(["promising", "neutral", "harmful", "inconclusive"]);

function usage() {
  console.error(`Usage: node scripts/agent-effectiveness-study.mjs --corpus corpus.json --scenarios scenarios.json [--workdir tmp/agent-effectiveness] [--out reports/agent-effectiveness.json] [--runs runs.jsonl] [--judgments judgments.jsonl] [--max-subjects n] [--max-scenarios n] [--dry-run] [--allow-floating-ref] [--clone-mode full|shallow] [--discard-checkouts]

Prepares a local A/B agent-effectiveness study from a frozen public-OSS corpus.
The harness clones exact commits, writes per-arm task packs, and aggregates
external execution and judge logs. It never installs target dependencies, never
runs target package scripts, and never opens upstream PRs or issues.`);
}

function parseArgs(argv) {
  const parsed = {
    corpusPath: "",
    scenariosPath: "",
    runsPath: "",
    judgmentsPath: "",
    workDir: defaultWorkDir,
    outPath: defaultOutPath,
    dryRun: false,
    allowFloatingRef: false,
    cloneMode: "full",
    discardCheckouts: false,
    maxSubjects: undefined,
    maxScenarios: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") {
      parsed.corpusPath = path.resolve(requireValue(argv, index, "--corpus"));
      index += 1;
    } else if (argument.startsWith("--corpus=")) {
      parsed.corpusPath = path.resolve(requireInlineValue(argument, "--corpus=", "--corpus"));
    } else if (argument === "--scenarios") {
      parsed.scenariosPath = path.resolve(requireValue(argv, index, "--scenarios"));
      index += 1;
    } else if (argument.startsWith("--scenarios=")) {
      parsed.scenariosPath = path.resolve(requireInlineValue(argument, "--scenarios=", "--scenarios"));
    } else if (argument === "--runs") {
      parsed.runsPath = path.resolve(requireValue(argv, index, "--runs"));
      index += 1;
    } else if (argument.startsWith("--runs=")) {
      parsed.runsPath = path.resolve(requireInlineValue(argument, "--runs=", "--runs"));
    } else if (argument === "--judgments") {
      parsed.judgmentsPath = path.resolve(requireValue(argv, index, "--judgments"));
      index += 1;
    } else if (argument.startsWith("--judgments=")) {
      parsed.judgmentsPath = path.resolve(requireInlineValue(argument, "--judgments=", "--judgments"));
    } else if (argument === "--workdir") {
      parsed.workDir = path.resolve(requireValue(argv, index, "--workdir"));
      index += 1;
    } else if (argument.startsWith("--workdir=")) {
      parsed.workDir = path.resolve(requireInlineValue(argument, "--workdir=", "--workdir"));
    } else if (argument === "--out") {
      parsed.outPath = path.resolve(requireValue(argv, index, "--out"));
      index += 1;
    } else if (argument.startsWith("--out=")) {
      parsed.outPath = path.resolve(requireInlineValue(argument, "--out=", "--out"));
    } else if (argument === "--max-subjects") {
      parsed.maxSubjects = parsePositiveInteger(requireValue(argv, index, "--max-subjects"), "--max-subjects");
      index += 1;
    } else if (argument.startsWith("--max-subjects=")) {
      parsed.maxSubjects = parsePositiveInteger(requireInlineValue(argument, "--max-subjects=", "--max-subjects"), "--max-subjects");
    } else if (argument === "--max-scenarios") {
      parsed.maxScenarios = parsePositiveInteger(requireValue(argv, index, "--max-scenarios"), "--max-scenarios");
      index += 1;
    } else if (argument.startsWith("--max-scenarios=")) {
      parsed.maxScenarios = parsePositiveInteger(requireInlineValue(argument, "--max-scenarios=", "--max-scenarios"), "--max-scenarios");
    } else if (argument === "--clone-mode") {
      parsed.cloneMode = requireValue(argv, index, "--clone-mode");
      index += 1;
    } else if (argument.startsWith("--clone-mode=")) {
      parsed.cloneMode = requireInlineValue(argument, "--clone-mode=", "--clone-mode");
    } else if (argument === "--dry-run") {
      parsed.dryRun = true;
    } else if (argument === "--allow-floating-ref") {
      parsed.allowFloatingRef = true;
    } else if (argument === "--discard-checkouts") {
      parsed.discardCheckouts = true;
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.corpusPath) throw new Error("--corpus is required");
  if (!parsed.scenariosPath) throw new Error("--scenarios is required");
  if (!["full", "shallow"].includes(parsed.cloneMode)) {
    throw new Error("--clone-mode must be full or shallow");
  }
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

function parsePositiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${optionName} must be a positive integer`);
  return parsed;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const values = [];
  for (const [index, line] of fs.readFileSync(filePath, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return values;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hashText(value) {
  return hashBuffer(Buffer.from(String(value)));
}

function hashFile(filePath) {
  return hashBuffer(fs.readFileSync(filePath));
}

function posixify(value) {
  return String(value).replace(/\\/g, "/").split(path.sep).join("/");
}

function slug(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "item";
}

function isPathWithin(baseDir, candidatePath, allowBase = false) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidatePath));
  if (relative === "") return allowBase;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveWithin(baseDir, relativePath, label, options = {}) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const resolved = path.resolve(baseDir, relativePath);
  if (!isPathWithin(baseDir, resolved, options.allowBase === true)) {
    throw new Error(`${label} escapes its root: ${relativePath}`);
  }
  return resolved;
}

function validateContainedRelativePath(relativePath, label) {
  resolveWithin(path.join(repoRoot, ".cellfence-path-root"), relativePath, label);
}

function assertRealPathWithin(baseDir, candidatePath, label) {
  const base = fs.realpathSync(baseDir);
  const candidate = fs.realpathSync(candidatePath);
  if (!isPathWithin(base, candidate, false)) throw new Error(`${label} resolves outside its root: ${candidatePath}`);
  return candidate;
}

function assertRegularFileWithin(baseDir, candidatePath, label) {
  const realPath = assertRealPathWithin(baseDir, candidatePath, label);
  if (!fs.statSync(realPath).isFile()) throw new Error(`${label} must resolve to a regular file`);
  return realPath;
}

function subjectDirectory(workDir, id) {
  return resolveWithin(workDir, `${slug(id)}-${hashText(id).slice(0, 12)}`, "subject id");
}

function assignmentDirectory(workDir, assignment) {
  return resolveWithin(workDir, path.join("assignments", `${slug(assignment.subjectId)}-${slug(assignment.scenarioId)}-${assignment.arm}-${assignment.assignmentId.slice(7, 19)}`), "assignment id");
}

function isExactCommit(value) {
  return /^[a-f0-9]{40}$/i.test(String(value || ""));
}

function run(command, args, options) {
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
      LC_ALL: "C",
      TZ: "UTC",
    },
    maxBuffer: 100 * 1024 * 1024,
    timeout: options.timeoutMs,
  });
  const errorCode = result.error && typeof result.error === "object" && "code" in result.error
    ? String(result.error.code)
    : undefined;
  const timedOut = errorCode === "ETIMEDOUT";
  return {
    command: [command, ...args].join(" "),
    status: result.status ?? (timedOut ? 124 : 1),
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? String(result.error.message || result.error) : undefined,
    errorCode,
    timedOut,
    timeoutMs: options.timeoutMs,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

function writeCommandLogs(subjectDir, name, result) {
  const logDir = path.join(subjectDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, `${name}.stdout.log`), result.stdout);
  fs.writeFileSync(path.join(logDir, `${name}.stderr.log`), result.stderr);
  writeJson(path.join(logDir, `${name}.meta.json`), result);
}

function validateId(id, label) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error(`${label} must contain only letters, numbers, dot, underscore, and dash`);
  }
}

function validateManifestDefinition(subject, corpusDir) {
  const manifest = subject.manifest || { strategy: "existing", path: defaultManifestPath };
  const strategy = manifest.strategy || "existing";
  if (!["existing", "copy", "infer"].includes(strategy)) {
    throw new Error(`${subject.id} manifest.strategy must be existing, copy, or infer`);
  }
  if (strategy === "existing") {
    if (manifest.path !== undefined) validateContainedRelativePath(manifest.path, `${subject.id} manifest.path`);
  } else if (strategy === "copy") {
    if (!manifest.source) throw new Error(`${subject.id} manifest.source is required for copy strategy`);
    const sourcePath = resolveWithin(corpusDir, manifest.source, `${subject.id} manifest.source`);
    if (!fs.existsSync(sourcePath)) throw new Error(`${subject.id} manifest.source does not exist: ${manifest.source}`);
    assertRegularFileWithin(corpusDir, sourcePath, `${subject.id} manifest.source`);
    if (manifest.reviewStatus && !["reviewed", "unreviewed"].includes(manifest.reviewStatus)) {
      throw new Error(`${subject.id} manifest.reviewStatus must be reviewed or unreviewed`);
    }
  } else if (strategy === "infer") {
    if (manifest.path || manifest.source) throw new Error(`${subject.id} infer manifest cannot specify path or source`);
  }
  return { ...manifest, strategy };
}

function validateCorpus(corpus, options, corpusDir) {
  if (corpus.schemaVersion !== corpusSchemaVersion) throw new Error(`corpus schemaVersion must be ${corpusSchemaVersion}`);
  if (!corpus.studyId || typeof corpus.studyId !== "string") throw new Error("corpus studyId is required");
  validateId(corpus.studyId, "corpus studyId");
  if (corpus.seed !== undefined && (typeof corpus.seed !== "string" || corpus.seed.length === 0)) {
    throw new Error("corpus seed must be a non-empty string");
  }
  if (!Array.isArray(corpus.subjects) || corpus.subjects.length === 0) throw new Error("corpus must contain at least one subject");
  const seen = new Set();
  for (const subject of corpus.subjects) {
    validateId(subject.id, "subject id");
    if (seen.has(subject.id)) throw new Error(`duplicate subject id ${subject.id}`);
    seen.add(subject.id);
    if (!subject.repository || typeof subject.repository !== "string") throw new Error(`${subject.id} repository is required`);
    if (subject.commit !== undefined && !isExactCommit(subject.commit)) throw new Error(`${subject.id} commit must be an exact 40-hex commit`);
    if (!subject.commit && !options.allowFloatingRef) {
      throw new Error(`${subject.id} requires exact 40-hex commit unless --allow-floating-ref is set`);
    }
    if (subject.ref !== undefined && typeof subject.ref !== "string") throw new Error(`${subject.id} ref must be a string`);
    validateManifestDefinition(subject, corpusDir);
  }
}

function validateScenarios(scenarios) {
  if (scenarios.schemaVersion !== scenariosSchemaVersion) throw new Error(`scenarios schemaVersion must be ${scenariosSchemaVersion}`);
  if (!Array.isArray(scenarios.scenarios) || scenarios.scenarios.length === 0) throw new Error("scenarios must contain at least one scenario");
  const seen = new Set();
  for (const scenario of scenarios.scenarios) {
    validateId(scenario.id, "scenario id");
    if (seen.has(scenario.id)) throw new Error(`duplicate scenario id ${scenario.id}`);
    seen.add(scenario.id);
    if (!scenario.title || typeof scenario.title !== "string") throw new Error(`${scenario.id} title is required`);
    if (!scenario.task || typeof scenario.task !== "string") throw new Error(`${scenario.id} task is required`);
    if (scenario.expectedScale) {
      for (const field of ["filesChanged", "insertions", "deletions"]) {
        if (scenario.expectedScale[field] !== undefined && (!Number.isInteger(scenario.expectedScale[field]) || scenario.expectedScale[field] < 0)) {
          throw new Error(`${scenario.id} expectedScale.${field} must be a non-negative integer`);
        }
      }
    }
    for (const field of ["riskTags", "successCriteria", "antiGoals"]) {
      if (scenario[field] !== undefined && (!Array.isArray(scenario[field]) || scenario[field].some((value) => typeof value !== "string"))) {
        throw new Error(`${scenario.id} ${field} must be a string array`);
      }
    }
  }
}

function cloneSubject(subject, subjectDir, options) {
  fs.rmSync(subjectDir, { recursive: true, force: true });
  fs.mkdirSync(subjectDir, { recursive: true });
  const checkoutDir = path.join(subjectDir, "checkout");
  const cloneArgs = options.cloneMode === "shallow"
    ? ["clone", "--no-tags", "--filter=blob:none", subject.repository, checkoutDir]
    : ["clone", "--no-tags", subject.repository, checkoutDir];
  const clone = run("git", cloneArgs, { cwd: subjectDir, timeoutMs: commandTimeouts.clone });
  writeCommandLogs(subjectDir, "clone", clone);
  if (clone.status !== 0) return { ok: false, stage: "clone", checkoutDir, result: clone };

  const targetRef = subject.commit || subject.ref || "HEAD";
  const checkout = run("git", ["checkout", "--detach", targetRef], { cwd: checkoutDir, timeoutMs: commandTimeouts.checkout });
  writeCommandLogs(subjectDir, "checkout", checkout);
  if (checkout.status !== 0) return { ok: false, stage: "checkout", checkoutDir, result: checkout };

  const head = run("git", ["rev-parse", "HEAD"], { cwd: checkoutDir, timeoutMs: commandTimeouts.revParse });
  writeCommandLogs(subjectDir, "rev-parse-head", head);
  if (head.status !== 0) return { ok: false, stage: "revParse", checkoutDir, result: head };

  const tree = run("git", ["rev-parse", "HEAD^{tree}"], { cwd: checkoutDir, timeoutMs: commandTimeouts.revParse });
  writeCommandLogs(subjectDir, "rev-parse-tree", tree);
  if (tree.status !== 0) return { ok: false, stage: "revParse", checkoutDir, result: tree };

  return {
    ok: true,
    checkoutDir,
    commit: head.stdout.trim(),
    gitTree: tree.stdout.trim(),
  };
}

function prepareManifest(subject, checkoutDir, corpusDir, subjectDir) {
  const manifest = validateManifestDefinition(subject, corpusDir);
  if (manifest.strategy === "existing") {
    const relativePath = manifest.path || defaultManifestPath;
    const effectivePath = resolveWithin(checkoutDir, relativePath, `${subject.id} manifest.path`);
    if (!fs.existsSync(effectivePath)) {
      return { strategy: "existing", status: "missing", path: relativePath, effectivePath };
    }
    const realManifestPath = assertRegularFileWithin(checkoutDir, effectivePath, `${subject.id} manifest.path`);
    return {
      strategy: "existing",
      status: "completed",
      path: relativePath,
      effectivePath: realManifestPath,
      sha256: hashFile(realManifestPath),
      reviewStatus: manifest.reviewStatus || "existing",
    };
  }
  if (manifest.strategy === "copy") {
    const sourcePath = resolveWithin(corpusDir, manifest.source, `${subject.id} manifest.source`);
    const realSourcePath = assertRegularFileWithin(corpusDir, sourcePath, `${subject.id} manifest.source`);
    const effectivePath = path.join(subjectDir, "control", "cellfence.manifest.json");
    fs.mkdirSync(path.dirname(effectivePath), { recursive: true });
    fs.copyFileSync(realSourcePath, effectivePath);
    return {
      strategy: "copy",
      status: "completed",
      source: manifest.source,
      effectivePath,
      sha256: hashFile(effectivePath),
      reviewStatus: manifest.reviewStatus || "unreviewed",
    };
  }
  return {
    strategy: "infer",
    status: "planned_only",
    effectivePath: path.join(subjectDir, "control", "cellfence.manifest.json"),
    reviewStatus: "generated",
  };
}

function subjectIdentity(subject, corpusDir) {
  const manifest = subject.manifest || { strategy: "existing", path: defaultManifestPath };
  const manifestIdentity = { ...manifest };
  if (manifestIdentity.strategy === "copy" && corpusDir) {
    const sourcePath = resolveWithin(corpusDir, manifestIdentity.source, `${subject.id} manifest.source`);
    manifestIdentity.sourceSha256 = hashFile(assertRegularFileWithin(corpusDir, sourcePath, `${subject.id} manifest.source`));
  }
  return hashText(JSON.stringify(canonicalize({
    id: subject.id,
    repository: subject.repository,
    commit: subject.commit || null,
    ref: subject.ref || null,
    manifest: manifestIdentity,
  })));
}

function scenarioIdentity(scenario) {
  return hashText(JSON.stringify(canonicalize(scenario)));
}

function assignmentId(studyId, seed, subject, scenario, arm, corpusDir) {
  return `sha256:${hashText([
    studyId,
    seed,
    subjectIdentity(subject, corpusDir),
    scenarioIdentity(scenario),
    arm,
  ].join("\0"))}`;
}

function createAssignments(studyId, seed, subjects, scenarios, corpusDir) {
  const assignments = [];
  for (const subject of subjects) {
    for (const scenario of scenarios) {
      for (const arm of arms) {
        const id = assignmentId(studyId, seed, subject, scenario, arm, corpusDir);
        assignments.push({
          schemaVersion: "cellfence.agent-effectiveness.assignment.v1",
          studyId,
          seed,
          assignmentId: id,
          orderKey: hashText([seed, id].join("\0")),
          subjectSha256: subjectIdentity(subject, corpusDir),
          scenarioSha256: scenarioIdentity(scenario),
          subjectId: subject.id,
          scenarioId: scenario.id,
          arm,
        });
      }
    }
  }
  return assignments
    .sort((left, right) => left.orderKey.localeCompare(right.orderKey))
    .map((assignment, index) => ({ ...assignment, trialIndex: index + 1 }));
}

function studySeed(corpus, options) {
  return corpus.seed || `sha256:${hashText([
    hashFile(options.corpusPath),
    hashFile(options.scenariosPath),
    corpus.studyId,
  ].join("\0"))}`;
}

function renderTaskPack({ corpus, subject, subjectResult, scenario, assignment, assignmentDir }) {
  const checkoutPath = subjectResult.checkoutDir ? posixify(subjectResult.checkoutDir) : "<checkout unavailable>";
  const manifestPath = subjectResult.manifest?.effectivePath ? posixify(subjectResult.manifest.effectivePath) : "<manifest unavailable>";
  const armGuidance = assignment.arm === "cellfence"
    ? [
      "Use CellFence as part of the edit loop.",
      "Before editing, inspect the fence context for the target task.",
      "After editing, run CellFence check and keep the finding output.",
      "Do not approve or update baselines unless the scenario explicitly asks for an approval workflow.",
    ]
    : [
      "Do not use CellFence guidance, context, or check output while editing.",
      "Use normal repository reasoning only.",
      "Keep ordinary build/test logs if you run any commands.",
    ];
  const lines = [
    `# Agent Effectiveness Task ${assignment.assignmentId}`,
    "",
    `Study: ${corpus.studyId}`,
    `Subject: ${subject.id}`,
    `Repository: ${subject.repository}`,
    `Commit: ${subjectResult.commit || subject.commit || subject.ref || "unknown"}`,
    `Scenario: ${scenario.id} - ${scenario.title}`,
    `Arm: ${assignment.arm}`,
    "",
    "## Safety",
    "",
    "- Work only in the local checkout.",
    "- Do not open upstream issues, pull requests, comments, or discussions.",
    "- Do not publish packages or upload artifacts externally.",
    "- Do not run target package install scripts unless a separate isolated-runtime protocol explicitly allows it.",
    "",
    "## Checkout",
    "",
    `Local checkout: \`${checkoutPath}\``,
    ...(assignment.arm === "cellfence" ? [`Manifest: \`${manifestPath}\``] : []),
    "",
    "## Arm Instructions",
    "",
    ...armGuidance.map((line) => `- ${line}`),
    "",
    "## Task",
    "",
    scenario.task.trim(),
    "",
    "## Success Criteria",
    "",
    ...(scenario.successCriteria || []).map((line) => `- ${line}`),
    "",
    "## Anti-Goals",
    "",
    ...(scenario.antiGoals || []).map((line) => `- ${line}`),
    "",
    "## Expected Scale",
    "",
    `\`\`\`json\n${JSON.stringify(scenario.expectedScale || {}, null, 2)}\n\`\`\``,
    "",
  ];
  fs.mkdirSync(assignmentDir, { recursive: true });
  fs.writeFileSync(path.join(assignmentDir, "TASK.md"), `${lines.join("\n")}\n`);
  writeJson(path.join(assignmentDir, "assignment.json"), assignment);
}

function runSubject(subject, corpus, scenarios, corpusDir, options) {
  const subjectDir = subjectDirectory(options.workDir, subject.id);
  const selectedScenarios = scenarios.scenarios.slice(0, options.maxScenarios || scenarios.scenarios.length);
  if (options.dryRun) {
    return {
      id: subject.id,
      repository: subject.repository,
      requestedCommit: subject.commit || null,
      requestedRef: subject.ref || null,
      status: "planned",
      subjectDir,
      manifest: validateManifestDefinition(subject, corpusDir),
      assignments: selectedScenarios.length * arms.length,
    };
  }

  const clone = cloneSubject(subject, subjectDir, options);
  if (!clone.ok) {
    return {
      id: subject.id,
      repository: subject.repository,
      requestedCommit: subject.commit || null,
      requestedRef: subject.ref || null,
      status: clone.result?.timedOut ? "timeout" : "failed",
      failureStage: clone.stage,
      failureStatus: clone.result?.status,
      failureMessage: clone.result?.stderr || clone.result?.stdout || clone.result?.error || `${clone.stage} failed`,
      subjectDir,
      checkoutDir: clone.checkoutDir,
      assignments: 0,
    };
  }

  const manifest = prepareManifest(subject, clone.checkoutDir, corpusDir, subjectDir);
  const subjectResult = {
    id: subject.id,
    repository: subject.repository,
    requestedCommit: subject.commit || null,
    requestedRef: subject.ref || null,
    status: manifest.status === "missing" ? "manifest_missing" : "prepared",
    subjectDir,
    checkoutDir: clone.checkoutDir,
    commit: clone.commit,
    gitTree: clone.gitTree,
    manifest,
    assignments: 0,
  };

  if (manifest.status === "missing") return subjectResult;

  for (const scenario of selectedScenarios) {
    for (const arm of arms) {
      const id = assignmentId(corpus.studyId, options.studySeed, subject, scenario, arm, corpusDir);
      const assignment = {
        schemaVersion: "cellfence.agent-effectiveness.assignment.v1",
        studyId: corpus.studyId,
        seed: options.studySeed,
        assignmentId: id,
        orderKey: hashText([options.studySeed, id].join("\0")),
        subjectSha256: subjectIdentity(subject, corpusDir),
        scenarioSha256: scenarioIdentity(scenario),
        subjectId: subject.id,
        scenarioId: scenario.id,
        arm,
        repository: subject.repository,
        commit: clone.commit,
        gitTree: clone.gitTree,
      };
      renderTaskPack({
        corpus,
        subject,
        subjectResult,
        scenario,
        assignment,
        assignmentDir: assignmentDirectory(options.workDir, assignment),
      });
      subjectResult.assignments += 1;
    }
  }

  if (options.discardCheckouts) fs.rmSync(clone.checkoutDir, { recursive: true, force: true });
  return subjectResult;
}

function validateRuns(runs, studyId, assignmentIds, options = {}) {
  const findings = [];
  const seen = new Set();
  const runsByAssignment = new Map();
  for (const [index, runRecord] of runs.entries()) {
    const prefix = `runs:${index + 1}`;
    if (runRecord.schemaVersion !== runSchemaVersion) findings.push(`${prefix} has unexpected schemaVersion`);
    if (runRecord.studyId !== studyId) findings.push(`${prefix} has unexpected studyId`);
    if (!assignmentIds.has(runRecord.assignmentId)) findings.push(`${prefix} references unknown assignmentId ${runRecord.assignmentId}`);
    if (assignmentIds.has(runRecord.assignmentId)) {
      const records = runsByAssignment.get(runRecord.assignmentId) || [];
      records.push(runRecord);
      runsByAssignment.set(runRecord.assignmentId, records);
    }
    if (!runRecord.agentId || typeof runRecord.agentId !== "string") findings.push(`${prefix} is missing agentId`);
    if (!runStatuses.has(runRecord.status)) findings.push(`${prefix} has unknown status ${runRecord.status}`);
    const duplicateKey = `${runRecord.assignmentId}\0${runRecord.agentId}`;
    if (seen.has(duplicateKey)) findings.push(`${prefix} duplicates assignment/agent run`);
    seen.add(duplicateKey);
    if (runRecord.diffStat) {
      for (const field of ["filesChanged", "insertions", "deletions"]) {
        if (runRecord.diffStat[field] !== undefined && (!Number.isInteger(runRecord.diffStat[field]) || runRecord.diffStat[field] < 0)) {
          findings.push(`${prefix} diffStat.${field} must be a non-negative integer`);
        }
      }
    }
  }
  if (options.requireCoverage) {
    for (const assignmentIdValue of assignmentIds) {
      const records = runsByAssignment.get(assignmentIdValue) || [];
      if (records.length === 0) findings.push(`runs missing assignmentId ${assignmentIdValue}`);
      if (records.length > 1) findings.push(`runs has multiple records for assignmentId ${assignmentIdValue}; provide one resolved run record per assignment`);
    }
  }
  return findings;
}

function validateJudgments(judgments, studyId, assignmentIds, options = {}) {
  const findings = [];
  const seen = new Set();
  const judgmentsByAssignment = new Map();
  for (const [index, judgment] of judgments.entries()) {
    const prefix = `judgments:${index + 1}`;
    if (judgment.schemaVersion !== judgmentSchemaVersion) findings.push(`${prefix} has unexpected schemaVersion`);
    if (judgment.studyId !== studyId) findings.push(`${prefix} has unexpected studyId`);
    if (!assignmentIds.has(judgment.assignmentId)) findings.push(`${prefix} references unknown assignmentId ${judgment.assignmentId}`);
    if (assignmentIds.has(judgment.assignmentId)) {
      const records = judgmentsByAssignment.get(judgment.assignmentId) || [];
      records.push(judgment);
      judgmentsByAssignment.set(judgment.assignmentId, records);
    }
    if (!judgment.judgeId || typeof judgment.judgeId !== "string") findings.push(`${prefix} is missing judgeId`);
    if (!taskOutcomes.has(judgment.taskSuccess)) findings.push(`${prefix} has unknown taskSuccess ${judgment.taskSuccess}`);
    if (!frictionCosts.has(judgment.frictionCost)) findings.push(`${prefix} has unknown frictionCost ${judgment.frictionCost}`);
    if (!promiseLabels.has(judgment.promiseLabel)) findings.push(`${prefix} has unknown promiseLabel ${judgment.promiseLabel}`);
    if (!judgment.rationale || typeof judgment.rationale !== "string" || judgment.rationale.trim().length === 0) findings.push(`${prefix} is missing rationale`);
    for (const field of ["boundaryViolations", "publicApiDrift", "resourceContractDrift"]) {
      if (!Number.isInteger(judgment[field]) || judgment[field] < 0) findings.push(`${prefix} ${field} must be a non-negative integer`);
    }
    if (!Number.isInteger(judgment.reviewability) || judgment.reviewability < 1 || judgment.reviewability > 5) {
      findings.push(`${prefix} reviewability must be an integer from 1 to 5`);
    }
    const duplicateKey = `${judgment.assignmentId}\0${judgment.judgeId}`;
    if (seen.has(duplicateKey)) findings.push(`${prefix} duplicates assignment/judge judgment`);
    seen.add(duplicateKey);
  }
  if (options.requireCoverage) {
    for (const assignmentIdValue of assignmentIds) {
      const records = judgmentsByAssignment.get(assignmentIdValue) || [];
      if (records.length === 0) findings.push(`judgments missing assignmentId ${assignmentIdValue}`);
      if (records.length > 1) findings.push(`judgments has multiple records for assignmentId ${assignmentIdValue}; provide one adjudicated judgment per assignment`);
    }
  }
  return findings;
}

function groupBy(values, keyFn) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFn(value);
    const existing = groups.get(key) || [];
    existing.push(value);
    groups.set(key, existing);
  }
  return groups;
}

function safeRatio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countBy(values, keyFn) {
  const counts = {};
  for (const value of values) {
    const key = keyFn(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function aggregateByArm(assignments, runs, judgments) {
  const assignmentById = new Map(assignments.map((assignment) => [assignment.assignmentId, assignment]));
  const output = {};
  for (const arm of arms) {
    const armAssignments = assignments.filter((assignment) => assignment.arm === arm);
    const armAssignmentIds = new Set(armAssignments.map((assignment) => assignment.assignmentId));
    const armRuns = runs.filter((runRecord) => armAssignmentIds.has(runRecord.assignmentId));
    const armJudgments = judgments.filter((judgment) => armAssignmentIds.has(judgment.assignmentId));
    output[arm] = {
      assignments: armAssignments.length,
      runs: armRuns.length,
      completedRuns: armRuns.filter((runRecord) => runRecord.status === "completed").length,
      runStatuses: countBy(armRuns, (runRecord) => runRecord.status),
      judgments: armJudgments.length,
      taskSuccess: countBy(armJudgments, (judgment) => judgment.taskSuccess),
      promiseLabels: countBy(armJudgments, (judgment) => judgment.promiseLabel),
      passRate: safeRatio(armJudgments.filter((judgment) => judgment.taskSuccess === "pass").length, armJudgments.length),
      boundaryViolationRate: safeRatio(armJudgments.filter((judgment) => judgment.boundaryViolations > 0).length, armJudgments.length),
      averageBoundaryViolations: average(armJudgments.map((judgment) => judgment.boundaryViolations)),
      averagePublicApiDrift: average(armJudgments.map((judgment) => judgment.publicApiDrift)),
      averageResourceContractDrift: average(armJudgments.map((judgment) => judgment.resourceContractDrift)),
      averageReviewability: average(armJudgments.map((judgment) => judgment.reviewability)),
      repositories: [...new Set(armAssignments.map((assignment) => assignmentById.get(assignment.assignmentId)?.subjectId).filter(Boolean))].length,
    };
  }
  return output;
}

function aggregateScenarioDeltas(assignments, judgments) {
  const rows = [];
  const judgmentsByAssignment = groupBy(judgments, (judgment) => judgment.assignmentId);
  const bySubjectScenario = groupBy(assignments, (assignment) => `${assignment.subjectId}\0${assignment.scenarioId}`);
  for (const [, pairedAssignments] of bySubjectScenario) {
    const cellfenceAssignment = pairedAssignments.find((assignment) => assignment.arm === "cellfence");
    const controlAssignment = pairedAssignments.find((assignment) => assignment.arm === "control");
    if (!cellfenceAssignment || !controlAssignment) continue;
    const cellfenceJudgment = (judgmentsByAssignment.get(cellfenceAssignment.assignmentId) || [])[0];
    const controlJudgment = (judgmentsByAssignment.get(controlAssignment.assignmentId) || [])[0];
    if (!cellfenceJudgment || !controlJudgment) continue;
    rows.push({
      subjectId: cellfenceAssignment.subjectId,
      scenarioId: cellfenceAssignment.scenarioId,
      boundaryViolationDelta: cellfenceJudgment.boundaryViolations - controlJudgment.boundaryViolations,
      reviewabilityDelta: cellfenceJudgment.reviewability - controlJudgment.reviewability,
      cellfencePromise: cellfenceJudgment.promiseLabel,
      controlPromise: controlJudgment.promiseLabel,
    });
  }
  return rows.sort((left, right) => `${left.subjectId}\0${left.scenarioId}`.localeCompare(`${right.subjectId}\0${right.scenarioId}`));
}

function environmentMetadata(options) {
  return {
    harnessCommit: gitCommit(repoRoot),
    harnessDirty: gitDirty(repoRoot),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    corpusSha256: hashFile(options.corpusPath),
    scenariosSha256: hashFile(options.scenariosPath),
    runsSha256: options.runsPath && fs.existsSync(options.runsPath) ? hashFile(options.runsPath) : null,
    judgmentsSha256: options.judgmentsPath && fs.existsSync(options.judgmentsPath) ? hashFile(options.judgmentsPath) : null,
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function evidenceSetSha256(report) {
  return hashText(JSON.stringify(canonicalize({
    schemaVersion: report.schemaVersion,
    studyId: report.studyId,
    seed: report.seed,
    dryRun: report.dryRun,
    cloneMode: report.cloneMode,
    safety: report.safety,
    environment: {
      corpusSha256: report.environment.corpusSha256,
      scenariosSha256: report.environment.scenariosSha256,
      runsSha256: report.environment.runsSha256,
      judgmentsSha256: report.environment.judgmentsSha256,
    },
    subjects: report.subjects.map((subject) => ({
      id: subject.id,
      repository: subject.repository,
      requestedCommit: subject.requestedCommit,
      requestedRef: subject.requestedRef,
      status: subject.status,
      commit: subject.commit,
      gitTree: subject.gitTree,
      manifest: subject.manifest ? {
        strategy: subject.manifest.strategy,
        status: subject.manifest.status,
        sha256: subject.manifest.sha256,
        reviewStatus: subject.manifest.reviewStatus,
      } : null,
      assignments: subject.assignments,
      failureStage: subject.failureStage,
      failureStatus: subject.failureStatus,
    })),
    scenarios: report.scenarios,
    assignments: report.assignments,
    runs: report.runs,
    judgments: report.judgments,
    claimEligibility: report.claimEligibility,
    summary: report.summary,
    metrics: report.metrics,
  })));
}

function gitCommit(rootDir) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitDirty(rootDir) {
  const result = spawnSync("git", ["status", "--short"], { cwd: rootDir, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim().length > 0 : null;
}

function buildReport(options) {
  const corpus = readJson(options.corpusPath);
  const scenarios = readJson(options.scenariosPath);
  const corpusDir = path.dirname(options.corpusPath);
  validateCorpus(corpus, options, corpusDir);
  validateScenarios(scenarios);

  const selectedSubjects = corpus.subjects.slice(0, options.maxSubjects || corpus.subjects.length);
  const selectedScenarios = scenarios.scenarios.slice(0, options.maxScenarios || scenarios.scenarios.length);
  const seed = studySeed(corpus, options);
  const runOptions = { ...options, studySeed: seed };
  const assignments = createAssignments(corpus.studyId, seed, selectedSubjects, selectedScenarios, corpusDir);
  const assignmentIds = new Set(assignments.map((assignment) => assignment.assignmentId));
  const runs = readJsonl(options.runsPath);
  const judgments = readJsonl(options.judgmentsPath);
  const runValidationFindings = validateRuns(runs, corpus.studyId, assignmentIds, { requireCoverage: Boolean(options.runsPath) });
  const judgmentValidationFindings = validateJudgments(judgments, corpus.studyId, assignmentIds, { requireCoverage: Boolean(options.judgmentsPath) });
  const validationFindings = [...runValidationFindings, ...judgmentValidationFindings];

  fs.mkdirSync(options.workDir, { recursive: true });
  const subjects = selectedSubjects.map((subject) => runSubject(subject, corpus, { ...scenarios, scenarios: selectedScenarios }, corpusDir, runOptions));
  const scenarioDeltas = aggregateScenarioDeltas(assignments, judgments);

  const exactCommitPinned = selectedSubjects.every((subject) => isExactCommit(subject.commit));
  const report = {
    schemaVersion: "cellfence.agent-effectiveness-study.v1",
    generatedAt: new Date().toISOString(),
    studyId: corpus.studyId,
    seed,
    dryRun: options.dryRun,
    cloneMode: options.cloneMode,
    conditions: [
      {
        arm: "cellfence",
        description: "Execution agents may inspect CellFence context and run CellFence checks while editing.",
        cellfenceAvailable: true,
      },
      {
        arm: "control",
        description: "Execution agents use ordinary repository reasoning and do not inspect CellFence guidance or checks.",
        cellfenceAvailable: false,
      },
    ],
    safety: {
      targetDependenciesInstalled: false,
      targetPackageScriptsExecuted: false,
      upstreamIssuesOrPullRequestsOpened: false,
      notes: [
        "The harness prepares local task packs only.",
        "Execution agents and judge agents must write separate JSONL records.",
        "Public OSS results must not be used to file automated upstream issues.",
      ],
    },
    corpusPath: options.corpusPath,
    scenariosPath: options.scenariosPath,
    workDir: options.workDir,
    environment: environmentMetadata(options),
    subjects,
    scenarios: selectedScenarios.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      riskTags: scenario.riskTags || [],
      expectedScale: scenario.expectedScale || {},
    })),
    assignments,
    runs: {
      path: options.runsPath || null,
      records: runs.length,
      validationFindings: runValidationFindings,
    },
    judgments: {
      path: options.judgmentsPath || null,
      records: judgments.length,
      validationFindings: judgmentValidationFindings,
    },
    claimEligibility: {
      eligible: exactCommitPinned && Boolean(options.runsPath) && Boolean(options.judgmentsPath) && validationFindings.length === 0,
      requirements: [
        "corpus subjects are pinned to exact commits",
        "assignment ids are bound to seed, subject metadata, and scenario content",
        "one resolved run record is present for every assignment",
        "one adjudicated judgment record is present for every assignment",
        "run and judgment validation findings are zero",
      ],
      exactCommitPinned,
      validationFindings: validationFindings.length,
    },
    summary: {
      subjects: selectedSubjects.length,
      scenarios: selectedScenarios.length,
      assignments: assignments.length,
      preparedSubjects: subjects.filter((subject) => subject.status === "prepared").length,
      plannedSubjects: subjects.filter((subject) => subject.status === "planned").length,
      failedSubjects: subjects.filter((subject) => ["failed", "timeout", "manifest_missing"].includes(subject.status)).length,
      runs: runs.length,
      judgments: judgments.length,
      validationFindings: validationFindings.length,
    },
    metrics: {
      byArm: aggregateByArm(assignments, runs, judgments),
      pairedScenarioDeltas: scenarioDeltas,
      pairedScenarioSummary: {
        pairs: scenarioDeltas.length,
        averageBoundaryViolationDelta: average(scenarioDeltas.map((row) => row.boundaryViolationDelta)),
        averageReviewabilityDelta: average(scenarioDeltas.map((row) => row.reviewabilityDelta)),
      },
    },
  };
  return {
    ...report,
    evidenceSetSha256: evidenceSetSha256(report),
  };
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
    const report = buildReport(options);
    writeJson(options.outPath, report);
    console.log(JSON.stringify({
      studyId: report.studyId,
      subjects: report.summary.subjects,
      scenarios: report.summary.scenarios,
      assignments: report.summary.assignments,
      validationFindings: report.summary.validationFindings,
      out: options.outPath,
    }, null, 2));
    return report.summary.validationFindings > 0 ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

process.exitCode = main();
