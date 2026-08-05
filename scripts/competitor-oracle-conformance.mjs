import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { installCommandReason } from "./evidence-harness-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.resolve(fileURLToPath(import.meta.url));
const cellfenceCli = path.join(repoRoot, "packages", "cli", "dist", "index.js");
const defaultWorkDir = path.join(repoRoot, "tmp", "competitor-oracle-conformance");
const defaultOutPath = path.join(repoRoot, "reports", "competitor-oracle-conformance.json");
const analyzerSchemas = new Set([
  "cellfence.competitor-oracle-analyzers.v1",
  "cellfence.evidence-analyzers.v1",
]);
const outputFormats = new Set([
  "normalized-json",
  "dependency-cruiser-json",
  "import-linter-text",
  "madge-json",
]);
const fixedCheckArguments = new Set([
  "--root", "--manifest", "--json", "--format", "--audit-log", "--summary-json",
  "--changed", "--evidence-graph", "--base", "--head", "--plugin",
]);
const shellCommands = new Set([
  "bash", "cmd", "cmd.exe", "dash", "fish", "ksh", "powershell", "pwsh", "sh", "zsh",
]);
const packageManagerCommands = new Set([
  "bun", "npm", "npx", "pip", "pip3", "pipx", "pnpm", "uv", "yarn",
]);
const pythonCommands = new Set(["python", "python3", "py"]);
const nodeCommands = new Set(["node", "nodejs"]);

function usage() {
  console.error(`Usage: node scripts/competitor-oracle-conformance.mjs --corpus corpus.json --analyzers analyzers.json [--workdir tmp/competitor-oracle-conformance] [--out reports/competitor-oracle-conformance.json] [--timeout-ms 300000] [--max-subjects n] [--clone-mode full|shallow] [--discard-checkouts]

Runs CellFence and pre-provisioned competitor analyzers against exact-commit
corpus checkouts. It never installs target dependencies or invokes a shell.
Finding overlap is descriptive conformance evidence, not precision evidence.`);
}

function requiredValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${optionName} requires a value`);
  return value;
}

export function parseCompetitorOracleArgs(argv) {
  const options = {
    corpusPath: "",
    analyzersPath: "",
    workDir: defaultWorkDir,
    outPath: defaultOutPath,
    timeoutMs: 300_000,
    maxSubjects: undefined,
    cloneMode: "full",
    discardCheckouts: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") {
      options.corpusPath = path.resolve(requiredValue(argv, index, argument));
      index += 1;
    } else if (argument.startsWith("--corpus=")) options.corpusPath = path.resolve(argument.slice(9));
    else if (argument === "--analyzers") {
      options.analyzersPath = path.resolve(requiredValue(argv, index, argument));
      index += 1;
    } else if (argument.startsWith("--analyzers=")) options.analyzersPath = path.resolve(argument.slice(12));
    else if (argument === "--workdir") {
      options.workDir = path.resolve(requiredValue(argv, index, argument));
      index += 1;
    } else if (argument.startsWith("--workdir=")) options.workDir = path.resolve(argument.slice(10));
    else if (argument === "--out") {
      options.outPath = path.resolve(requiredValue(argv, index, argument));
      index += 1;
    } else if (argument.startsWith("--out=")) options.outPath = path.resolve(argument.slice(6));
    else if (argument === "--timeout-ms") {
      options.timeoutMs = Number(requiredValue(argv, index, argument));
      index += 1;
    } else if (argument.startsWith("--timeout-ms=")) options.timeoutMs = Number(argument.slice(13));
    else if (argument === "--max-subjects") {
      options.maxSubjects = Number(requiredValue(argv, index, argument));
      index += 1;
    } else if (argument.startsWith("--max-subjects=")) options.maxSubjects = Number(argument.slice(15));
    else if (argument === "--clone-mode") {
      options.cloneMode = requiredValue(argv, index, argument);
      index += 1;
    } else if (argument.startsWith("--clone-mode=")) options.cloneMode = argument.slice(13);
    else if (argument === "--discard-checkouts") options.discardCheckouts = true;
    else if (argument === "--help" || argument === "-h") return { help: true };
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.corpusPath) throw new Error("--corpus is required");
  if (!options.analyzersPath) throw new Error("--analyzers is required");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000) {
    throw new Error("--timeout-ms must be an integer from 1 to 300000");
  }
  if (options.maxSubjects !== undefined && (!Number.isInteger(options.maxSubjects) || options.maxSubjects < 1)) {
    throw new Error("--max-subjects must be a positive integer");
  }
  if (!["full", "shallow"].includes(options.cloneMode)) throw new Error("--clone-mode must be full or shallow");
  return options;
}

function commandBasename(command) {
  return path.basename(String(command)).toLowerCase().replace(/\.(?:cmd|exe)$/i, "");
}

export function unsafeAnalyzerCommandReason(command, args = []) {
  const sharedReason = installCommandReason(command, args);
  if (sharedReason) return sharedReason;
  const basename = commandBasename(command);
  if (shellCommands.has(basename)) return `shell command ${basename} is forbidden`;
  if (packageManagerCommands.has(basename)) {
    return `${basename} may install packages or invoke target-repository scripts`;
  }
  if (basename === "env") return "env indirection is forbidden for analyzer commands";
  if (pythonCommands.has(basename)) {
    const moduleIndex = args.findIndex((argument) => argument === "-m");
    const moduleName = moduleIndex >= 0 ? String(args[moduleIndex + 1] || "").toLowerCase() : "";
    if (["pip", "pip3", "ensurepip"].includes(moduleName)) return `python -m ${moduleName} is forbidden`;
    if (args.includes("-c")) return "inline Python execution is forbidden for analyzer commands";
  }
  if (nodeCommands.has(basename) && args.some((argument) => ["-e", "--eval", "-p", "--print"].includes(argument))) {
    return "inline Node.js execution is forbidden for analyzer commands";
  }
  const loweredArgs = args.map((argument) => String(argument).toLowerCase());
  if (loweredArgs.some((argument) => /(?:^|[\\/])(?:npm|npx|pip|pip3)(?:-cli)?(?:\.[a-z0-9]+)?$/.test(argument))) {
    return "package-manager indirection is forbidden for analyzer commands";
  }
  return null;
}

function hardenedEnvironment(overrides = {}) {
  const environment = {
    ...process.env,
    CI: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INDEX: "1",
    TZ: "UTC",
  };
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete environment[key];
  }
  for (const key of [
    "BASH_ENV", "ENV", "GIT_DIR", "GIT_WORK_TREE", "NODE_OPTIONS", "PYTHONHOME", "PYTHONINSPECT", "PYTHONPATH",
  ]) delete environment[key];
  return { ...environment, ...overrides };
}

export function spawnCommand(command, args, options = {}) {
  if (typeof command !== "string" || command.length === 0) throw new Error("command must be a non-empty string");
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new Error("command arguments must be strings");
  }
  const timeoutMs = options.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("every command requires a positive timeoutMs");
  const maxBuffer = options.maxBuffer || 100 * 1024 * 1024;
  const started = performance.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let spawnError;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: hardenedEnvironment(options.env),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const append = (channel, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxBuffer) {
        overflowed = true;
        child.kill("SIGKILL");
        return channel;
      }
      return channel + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => { spawnError = error; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      const errorCode = timedOut
        ? "ETIMEDOUT"
        : overflowed
          ? "ENOBUFS"
          : spawnError && typeof spawnError === "object" && "code" in spawnError
            ? String(spawnError.code)
            : undefined;
      resolve({
        status: status ?? (timedOut ? 124 : 1),
        signal: signal || undefined,
        stdout,
        stderr,
        error: spawnError ? String(spawnError.message || spawnError) : overflowed ? "command output exceeded maxBuffer" : undefined,
        errorCode,
        timedOut,
        timeoutMs,
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
}

function isExactCommit(value) {
  return /^[a-f0-9]{40}$/i.test(String(value || ""));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPathWithin(baseDir, candidatePath, allowBase = false) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidatePath));
  if (relative === "") return allowBase;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveWithin(baseDir, relativePath, label, allowBase = false) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const resolved = path.resolve(baseDir, relativePath);
  if (!isPathWithin(baseDir, resolved, allowBase)) throw new Error(`${label} escapes its root: ${relativePath}`);
  return resolved;
}

function validateCheckArgs(subject) {
  const args = subject.check?.args;
  if (args === undefined) return;
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string" || argument.length === 0)) {
    throw new Error(`${subject.id} check.args must be an array of non-empty strings`);
  }
  for (const argument of args) {
    const option = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
    if (fixedCheckArguments.has(option)) throw new Error(`${subject.id} check.args cannot override ${option}`);
  }
}

export function validateCompetitorCorpus(corpus, corpusDir = process.cwd()) {
  if (!isRecord(corpus) || corpus.schemaVersion !== "cellfence.corpus.v1") {
    throw new Error("corpus schemaVersion must be cellfence.corpus.v1");
  }
  if (!Array.isArray(corpus.subjects) || corpus.subjects.length === 0) {
    throw new Error("corpus must contain at least one subject");
  }
  const ids = new Set();
  for (const subject of corpus.subjects) {
    if (!isRecord(subject)) throw new Error("each corpus subject must be an object");
    if (typeof subject.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(subject.id)) {
      throw new Error("each corpus subject requires a stable id");
    }
    if (ids.has(subject.id)) throw new Error(`duplicate subject id: ${subject.id}`);
    ids.add(subject.id);
    if (typeof subject.repository !== "string" || subject.repository.length === 0) {
      throw new Error(`${subject.id} requires repository`);
    }
    if (!isExactCommit(subject.commit)) throw new Error(`${subject.id} requires exact 40-hex commit`);
    const strategy = subject.manifest?.strategy || "existing";
    if (!["existing", "copy", "infer"].includes(strategy)) throw new Error(`${subject.id} has unsupported manifest strategy`);
    const manifestPath = subject.manifest?.path || "cellfence.manifest.json";
    resolveWithin(path.join(corpusDir, ".path-validation-root"), manifestPath, `${subject.id} manifest.path`);
    if (strategy === "copy") {
      const source = subject.manifest?.source;
      if (!source) throw new Error(`${subject.id} manifest.strategy=copy requires manifest.source`);
      resolveWithin(corpusDir, source, `${subject.id} manifest.source`);
    }
    if (subject.manifest?.scope !== undefined && !["all", "production"].includes(subject.manifest.scope)) {
      throw new Error(`${subject.id} manifest.scope must be all or production`);
    }
    for (const fromPath of subject.manifest?.from || []) {
      resolveWithin(path.join(corpusDir, ".path-validation-root"), fromPath, `${subject.id} manifest.from`);
    }
    if (subject.check?.timeoutMs !== undefined
      && (!Number.isInteger(subject.check.timeoutMs) || subject.check.timeoutMs < 1 || subject.check.timeoutMs > 300_000)) {
      throw new Error(`${subject.id} check.timeoutMs must be an integer from 1 to 300000`);
    }
    validateCheckArgs(subject);
  }
  return corpus;
}

function validateExitCodes(analyzer, key) {
  const values = analyzer.exitCodes?.[key];
  if (values !== undefined && (!Array.isArray(values) || values.some((value) => !Number.isInteger(value)))) {
    throw new Error(`${analyzer.id} exitCodes.${key} must be an array of integers`);
  }
}

function analyzerTool(analyzer) {
  const value = String(analyzer.tool || analyzer.id || "other").toLowerCase().replaceAll("_", "-");
  if (value.includes("dependency-cruiser") || value === "depcruise") return "dependency-cruiser";
  if (value.includes("import-linter") || value === "lint-imports") return "import-linter";
  if (value.includes("madge")) return "madge";
  return value;
}

function defaultOutputFormat(analyzer) {
  if (analyzerTool(analyzer) === "dependency-cruiser") return "dependency-cruiser-json";
  if (analyzerTool(analyzer) === "import-linter") return "import-linter-text";
  if (analyzerTool(analyzer) === "madge") return "madge-json";
  return "normalized-json";
}

function analyzerOutput(analyzer) {
  if (typeof analyzer.output === "string") return { format: analyzer.output, source: "stdout" };
  const output = isRecord(analyzer.output) ? analyzer.output : {};
  return {
    format: output.format || analyzer.outputFormat || defaultOutputFormat(analyzer),
    source: output.source || "stdout",
  };
}

function validateStringMap(value, label) {
  if (value === undefined) return;
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${label} must map strings to non-empty strings`);
  }
}

export function validateCompetitorAnalyzers(value) {
  if (!isRecord(value) || !analyzerSchemas.has(value.schemaVersion)) {
    throw new Error(`analyzers schemaVersion must be one of: ${[...analyzerSchemas].join(", ")}`);
  }
  if (!Array.isArray(value.analyzers)) throw new Error("analyzers must be an array");
  const ids = new Set(["cellfence"]);
  for (const analyzer of value.analyzers) {
    if (!isRecord(analyzer)) throw new Error("each analyzer must be an object");
    if (typeof analyzer.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(analyzer.id)) {
      throw new Error("each analyzer requires a stable id");
    }
    if (ids.has(analyzer.id)) throw new Error(`duplicate analyzer id: ${analyzer.id}`);
    ids.add(analyzer.id);
    const declaredOnly = analyzer.available === false || analyzer.comparable === false || analyzer.requiresTargetInstall === true;
    if (!declaredOnly && (typeof analyzer.command !== "string" || analyzer.command.length === 0)) {
      throw new Error(`${analyzer.id} requires command or an unavailable/not-comparable declaration`);
    }
    if (analyzer.args !== undefined && (!Array.isArray(analyzer.args) || analyzer.args.some((entry) => typeof entry !== "string"))) {
      throw new Error(`${analyzer.id} args must be an array of strings`);
    }
    if (analyzer.timeoutMs !== undefined && (!Number.isInteger(analyzer.timeoutMs) || analyzer.timeoutMs < 1 || analyzer.timeoutMs > 300_000)) {
      throw new Error(`${analyzer.id} timeoutMs must be an integer from 1 to 300000`);
    }
    for (const key of ["clean", "findings", "configurationError"]) validateExitCodes(analyzer, key);
    const output = analyzerOutput(analyzer);
    if (!outputFormats.has(output.format)) throw new Error(`${analyzer.id} has unsupported output format ${output.format}`);
    if (!["stdout", "stderr", "file"].includes(output.source)) throw new Error(`${analyzer.id} output.source is unsupported`);
    validateStringMap(analyzer.ruleCategories, `${analyzer.id} ruleCategories`);
    validateStringMap(analyzer.cellfenceRuleCategories, `${analyzer.id} cellfenceRuleCategories`);
  }
  return value.analyzers;
}

function normalizedPath(rootDir, value) {
  if (value === undefined || value === null || value === "") return null;
  let candidate = String(value).replaceAll("\\", "/").replace(/^file:\/\//, "");
  if (path.isAbsolute(candidate)) {
    const relative = path.relative(rootDir, candidate);
    candidate = isPathWithin(rootDir, candidate, true) ? relative : candidate;
  }
  return candidate.replace(/^\.\//, "").replace(/\/{2,}/g, "/") || ".";
}

function normalizedCategory(value) {
  return String(value || "unknown").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function inferredCategory(tool, ruleId, explicitCategory) {
  if (explicitCategory) return normalizedCategory(explicitCategory);
  const rule = String(ruleId || "").toLowerCase();
  if (/circular|cycle/.test(rule) || tool === "madge") return "cycle";
  if (/unresolv|not.found|missing/.test(rule)) return "unresolved_dependency";
  if (["dependency-cruiser", "import-linter"].includes(tool)) return "dependency_rule";
  return normalizedCategory(`${tool}_${ruleId || "finding"}`);
}

function normalizeFinding(rootDir, toolId, category, finding, index) {
  const lineValue = finding.line ?? finding.location?.line ?? finding.details?.line;
  const line = Number.isInteger(Number(lineValue)) && Number(lineValue) > 0 ? Number(lineValue) : null;
  const cycle = finding.cyclePaths || finding.cycle;
  return {
    toolId,
    category: normalizedCategory(category),
    ruleId: String(finding.ruleId || finding.rule || finding.name || "unknown"),
    severity: finding.severity ? String(finding.severity) : null,
    sourcePath: normalizedPath(rootDir, finding.sourcePath ?? finding.from ?? finding.filePath ?? finding.importer),
    targetPath: normalizedPath(rootDir, finding.targetPath ?? finding.to ?? finding.dependency ?? finding.details?.targetPath),
    line,
    message: finding.message ? String(finding.message) : null,
    ...(Array.isArray(cycle) ? { cyclePaths: cycle.map((entry) => normalizedPath(rootDir, entry)).filter(Boolean) } : {}),
    sourceIndex: index,
  };
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function dependencyCruiserRows(document) {
  if (Array.isArray(document?.summary?.violations)) {
    return document.summary.violations.map((violation) => ({
      ...violation,
      ruleId: violation.rule?.name || violation.rule?.id || violation.ruleId || violation.type,
      severity: violation.rule?.severity || violation.severity,
      cyclePaths: violation.cycle,
    }));
  }
  const rows = [];
  for (const module of document?.modules || []) {
    for (const rule of module.rules || []) {
      if (rule.severity !== "ignore") rows.push({ ...rule, sourcePath: module.source, ruleId: rule.name || rule.id });
    }
    for (const dependency of module.dependencies || []) {
      const rules = Array.isArray(dependency.rules) ? dependency.rules : dependency.rule ? [dependency.rule] : [];
      for (const rule of rules) {
        if (rule.severity === "ignore") continue;
        rows.push({
          ...rule,
          sourcePath: module.source,
          targetPath: dependency.resolved || dependency.module || dependency.moduleName,
          ruleId: rule.name || rule.id,
          cyclePaths: dependency.cycle,
        });
      }
      if (dependency.valid === false && rules.length === 0) {
        rows.push({ sourcePath: module.source, targetPath: dependency.resolved || dependency.module, ruleId: "invalid-dependency" });
      }
    }
  }
  return rows;
}

function importLinterRows(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const arrowParts = line.split(/\s+->\s+/).map((entry) => entry.trim()).filter(Boolean);
    if (arrowParts.length >= 2) {
      const lineMatch = arrowParts.at(-1).match(/\s+\(l\.\s*(\d+)\)\s*$/i);
      rows.push({
        sourcePath: arrowParts[0],
        targetPath: arrowParts[1].replace(/\s+\(l\.\s*\d+\)\s*$/i, ""),
        line: lineMatch ? Number(lineMatch[1]) : null,
        ruleId: "broken-contract",
        message: line.trim(),
      });
      continue;
    }
    const sentence = line.match(/^\s*(\S+)\s+is not allowed to import\s+(\S+)\s*$/i);
    if (sentence) rows.push({ sourcePath: sentence[1], targetPath: sentence[2], ruleId: "broken-contract", message: line.trim() });
  }
  return rows;
}

export function normalizeCompetitorFindings(analyzer, text, rootDir) {
  const tool = analyzerTool(analyzer);
  const output = analyzerOutput(analyzer);
  let rows;
  if (output.format === "dependency-cruiser-json") rows = dependencyCruiserRows(parseJson(text, analyzer.id));
  else if (output.format === "import-linter-text") rows = importLinterRows(text);
  else if (output.format === "madge-json") {
    const document = parseJson(text, analyzer.id);
    const cycles = Array.isArray(document) ? document : document?.circular;
    if (!Array.isArray(cycles) || cycles.some((cycle) => !Array.isArray(cycle))) {
      throw new Error(`${analyzer.id} madge output must be an array of circular dependency paths`);
    }
    rows = cycles.map((cycle) => ({
      ruleId: "circular-dependency",
      sourcePath: cycle[0],
      targetPath: cycle[1] || cycle[0],
      cyclePaths: cycle,
    }));
  } else {
    const document = parseJson(text, analyzer.id);
    rows = Array.isArray(document) ? document : document?.findings;
    if (!Array.isArray(rows)) throw new Error(`${analyzer.id} normalized JSON must be an array or contain findings[]`);
  }
  return rows.map((finding, index) => {
    if (!isRecord(finding)) throw new Error(`${analyzer.id} finding ${index} must be an object`);
    const ruleId = finding.ruleId || finding.rule || finding.name;
    const category = analyzer.ruleCategories?.[ruleId]
      || inferredCategory(tool, ruleId, finding.category || finding.classification || finding.kind);
    return normalizeFinding(rootDir, analyzer.id, category, finding, index);
  });
}

function cellfenceCategory(analyzer, finding) {
  const explicit = analyzer.cellfenceRuleCategories?.[finding.ruleId];
  if (explicit) return normalizedCategory(explicit);
  if (/PRIVATE_IMPORT|UNDECLARED_CONSUMER|IMPORT_TARGET|DEPENDENCY/.test(finding.ruleId)) return "dependency_rule";
  if (/UNRESOLVED/.test(finding.ruleId)) return "unresolved_dependency";
  if (/CIRCULAR|CYCLE/.test(finding.ruleId)) return "cycle";
  return normalizedCategory(`cellfence_${finding.ruleId}`);
}

export function normalizeCellFenceFindings(findings, analyzer, rootDir) {
  return (findings || []).map((finding, index) => normalizeFinding(
    rootDir,
    "cellfence",
    cellfenceCategory(analyzer, finding),
    {
      ...finding,
      sourcePath: finding.filePath || finding.details?.sourcePath,
      targetPath: finding.details?.targetPath,
      line: finding.details?.line,
    },
    index,
  ));
}

function canonicalCycle(paths) {
  if (!paths.length) return null;
  const values = paths.at(-1) === paths[0] ? paths.slice(0, -1) : [...paths];
  const rotations = [];
  for (const direction of [values, [...values].reverse()]) {
    for (let index = 0; index < direction.length; index += 1) {
      rotations.push([...direction.slice(index), ...direction.slice(0, index)].join("->"));
    }
  }
  return rotations.sort()[0];
}

export function findingComparisonKey(finding) {
  if (finding.cyclePaths?.length) return `${finding.category}|cycle|${canonicalCycle(finding.cyclePaths)}`;
  if (finding.sourcePath && finding.targetPath) return `${finding.category}|edge|${finding.sourcePath}|${finding.targetPath}`;
  if (finding.sourcePath && finding.line) return `${finding.category}|location|${finding.sourcePath}|${finding.line}`;
  if (finding.sourcePath) return `${finding.category}|file|${finding.sourcePath}`;
  return null;
}

export function compareNormalizedFindings(cellfenceFindings, competitorFindings) {
  const competitorByKey = new Map();
  const competitorWithoutKey = [];
  for (const finding of competitorFindings) {
    const key = findingComparisonKey(finding);
    if (!key) competitorWithoutKey.push(finding);
    else if (competitorByKey.has(key)) competitorByKey.get(key).push(finding);
    else competitorByKey.set(key, [finding]);
  }
  const comparableFindings = [];
  const cellfenceOnlyFindings = [];
  const cellfenceWithoutKey = [];
  for (const finding of cellfenceFindings) {
    const key = findingComparisonKey(finding);
    if (!key) {
      cellfenceWithoutKey.push(finding);
      continue;
    }
    const matches = competitorByKey.get(key);
    if (matches?.length) {
      comparableFindings.push({ comparisonKey: key, cellfence: finding, competitor: matches.shift() });
      if (matches.length === 0) competitorByKey.delete(key);
    } else cellfenceOnlyFindings.push(finding);
  }
  const competitorOnlyFindings = [...competitorByKey.values()].flat();
  return {
    status: "compared",
    comparableFindings,
    competitorOnlyFindings,
    cellfenceOnlyFindings,
    notComparableFindings: {
      competitor: competitorWithoutKey,
      cellfence: cellfenceWithoutKey,
    },
    counts: {
      comparable: comparableFindings.length,
      competitorOnly: competitorOnlyFindings.length,
      cellfenceOnly: cellfenceOnlyFindings.length,
      notComparable: competitorWithoutKey.length + cellfenceWithoutKey.length,
    },
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function subjectDirectory(workDir, id) {
  const slug = id.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64) || "subject";
  const digest = crypto.createHash("sha256").update(id).digest("hex").slice(0, 12);
  return resolveWithin(workDir, `${slug}-${digest}`, "subject id");
}

function failureText(result) {
  return result.error
    || result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join("\n")
    || result.stdout.trim().split(/\r?\n/).filter(Boolean).slice(-3).join("\n")
    || `exit ${result.status}`;
}

async function requiredCommand(runCommand, command, args, options, label) {
  const result = await runCommand(command, args, options);
  if (result.timedOut) throw new Error(`${label} timed out after ${options.timeoutMs}ms`);
  if (result.status !== 0) throw new Error(`${label} failed: ${failureText(result)}`);
  return result;
}

export async function inspectSubjectWorktree({ checkoutDir, expectedCommit, runCommand = spawnCommand, timeoutMs = 60_000 }) {
  const gitOptions = { cwd: checkoutDir, timeoutMs: Math.min(timeoutMs, 60_000) };
  const headResult = await runCommand("git", ["rev-parse", "HEAD"], gitOptions);
  if (headResult.status !== 0) return { available: false, clean: false, reason: `cannot read HEAD: ${failureText(headResult)}` };
  const statusResult = await runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], gitOptions);
  if (statusResult.status !== 0) return { available: false, clean: false, reason: `cannot inspect worktree: ${failureText(statusResult)}` };
  const head = headResult.stdout.trim().toLowerCase();
  const porcelain = statusResult.stdout.trim();
  const commitMatches = head === String(expectedCommit).toLowerCase();
  return {
    available: true,
    clean: porcelain.length === 0 && commitMatches,
    commitMatches,
    head,
    porcelain,
    reason: !commitMatches ? `HEAD ${head} does not match exact corpus commit ${expectedCommit}`
      : porcelain ? "subject worktree is dirty" : undefined,
  };
}

function assertRealFileWithin(baseDir, filePath, label) {
  const base = fs.realpathSync(baseDir);
  const candidate = fs.realpathSync(filePath);
  if (!isPathWithin(base, candidate)) throw new Error(`${label} resolves outside its root`);
}

async function prepareSubjectCheckout({ subject, corpusDir, options, runCommand, inspectWorktree }) {
  const subjectDir = subjectDirectory(options.workDir, subject.id);
  const checkoutDir = path.join(subjectDir, "checkout");
  fs.rmSync(subjectDir, { recursive: true, force: true });
  fs.mkdirSync(subjectDir, { recursive: true });
  const cloneArgs = ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--no-checkout", "--no-tags"];
  if (options.cloneMode === "shallow") cloneArgs.push("--depth", "1", "--filter=blob:none");
  cloneArgs.push("--", subject.repository, checkoutDir);
  await requiredCommand(runCommand, "git", cloneArgs, {
    cwd: options.workDir,
    timeoutMs: options.timeoutMs,
  }, "clone");
  const checkoutArgs = ["-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", subject.commit];
  let checkout = await runCommand("git", checkoutArgs, { cwd: checkoutDir, timeoutMs: options.timeoutMs });
  if (checkout.status !== 0 && options.cloneMode === "shallow") {
    await requiredCommand(runCommand, "git", ["fetch", "--quiet", "--depth", "1", "origin", subject.commit], {
      cwd: checkoutDir,
      timeoutMs: options.timeoutMs,
    }, "fetch exact commit");
    checkout = await runCommand("git", checkoutArgs, { cwd: checkoutDir, timeoutMs: options.timeoutMs });
  }
  if (checkout.status !== 0) throw new Error(`checkout failed: ${failureText(checkout)}`);
  const initial = await inspectWorktree({ checkoutDir, expectedCommit: subject.commit, runCommand, timeoutMs: options.timeoutMs });
  if (!initial.clean) throw new Error(initial.reason || "subject checkout is not clean at the exact corpus commit");

  const strategy = subject.manifest?.strategy || "existing";
  const manifestRelative = subject.manifest?.path || "cellfence.manifest.json";
  let manifestPath;
  if (strategy === "existing") {
    manifestPath = resolveWithin(checkoutDir, manifestRelative, "manifest.path");
    if (!fs.existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestRelative}`);
    assertRealFileWithin(checkoutDir, manifestPath, "manifest.path");
  } else if (strategy === "copy") {
    const sourcePath = resolveWithin(corpusDir, subject.manifest.source, "manifest.source");
    if (!fs.existsSync(sourcePath)) throw new Error(`manifest source not found: ${subject.manifest.source}`);
    assertRealFileWithin(corpusDir, sourcePath, "manifest.source");
    manifestPath = resolveWithin(path.join(subjectDir, "control"), manifestRelative, "manifest.path");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.copyFileSync(sourcePath, manifestPath);
  } else {
    manifestPath = resolveWithin(path.join(subjectDir, "control"), manifestRelative, "manifest.path");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const inferArgs = [cellfenceCli, "init", "--root", checkoutDir, "--output", manifestPath, "--no-scaffold"];
    if (subject.manifest?.scope === "production") inferArgs.push("--production-scope");
    if (subject.manifest?.preset) inferArgs.push("--preset", subject.manifest.preset);
    for (const fromPath of subject.manifest?.from || []) inferArgs.push("--from", fromPath);
    await requiredCommand(runCommand, process.execPath, inferArgs, {
      cwd: checkoutDir,
      timeoutMs: options.timeoutMs,
    }, "CellFence manifest inference");
  }
  const afterPreparation = await inspectWorktree({ checkoutDir, expectedCommit: subject.commit, runCommand, timeoutMs: options.timeoutMs });
  if (!afterPreparation.clean) throw new Error(afterPreparation.reason || "manifest preparation modified the subject checkout");
  return { subjectDir, checkoutDir, manifestPath, initialWorktree: initial };
}

function classifyExecution(result, exitCodes = {}) {
  if (result.timedOut) return "timeout";
  if (result.errorCode === "ENOENT") return "unavailable";
  if ((exitCodes.clean || [0]).includes(result.status)) return "clean";
  if ((exitCodes.findings || [1]).includes(result.status)) return "findings";
  if ((exitCodes.configurationError || [2]).includes(result.status)) return "configuration_error";
  return "tool_error";
}

function logsFor(subjectDir, id, result) {
  const logDir = path.join(subjectDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, `${id}.stdout.log`), result.stdout || "");
  fs.writeFileSync(path.join(logDir, `${id}.stderr.log`), result.stderr || "");
}

async function guardedCommand({
  id, command, args, checkoutDir, expectedCommit, subjectDir, timeoutMs, env, runCommand, inspectWorktree,
}) {
  const before = await inspectWorktree({ checkoutDir, expectedCommit, runCommand, timeoutMs });
  if (!before.clean) {
    return {
      classification: "tool_error",
      error: before.reason || "subject worktree is not clean before execution",
      safety: { cleanBefore: false, cleanAfter: null, exactCommitBefore: before.commitMatches === true, exactCommitAfter: null },
    };
  }
  let result;
  try {
    result = await runCommand(command, args, { cwd: checkoutDir, env, timeoutMs, shell: false });
  } catch (error) {
    result = {
      status: 1,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : String(error),
      timedOut: false,
      timeoutMs,
      durationMs: 0,
    };
  }
  logsFor(subjectDir, id, result);
  const after = await inspectWorktree({ checkoutDir, expectedCommit, runCommand, timeoutMs });
  const safety = {
    cleanBefore: true,
    cleanAfter: after.clean,
    exactCommitBefore: before.commitMatches === true,
    exactCommitAfter: after.commitMatches === true,
  };
  if (!after.clean) {
    return {
      classification: "tool_error",
      result,
      error: after.reason || `${id} modified the subject checkout`,
      safety,
    };
  }
  return { result, safety };
}

function expandedAnalyzerArguments(analyzer, context) {
  const replacements = {
    "{root}": context.checkoutDir,
    "{manifest}": context.manifestPath,
    "{output}": context.outputPath,
    "{subjectId}": context.subject.id,
    "{commit}": context.subject.commit,
  };
  return (analyzer.args || []).map((argument) => {
    let expanded = argument;
    for (const [placeholder, value] of Object.entries(replacements)) expanded = expanded.replaceAll(placeholder, value);
    return expanded;
  });
}

function declaredAnalyzerState(analyzer) {
  if (analyzer.requiresTargetInstall === true) {
    return { classification: "not_comparable", reason: analyzer.reason || "analyzer requires a target install, which is forbidden" };
  }
  if (analyzer.comparable === false) {
    return { classification: "not_comparable", reason: analyzer.reason || "analyzer was declared not comparable" };
  }
  if (analyzer.available === false) {
    return { classification: "unavailable", reason: analyzer.reason || "analyzer was declared unavailable" };
  }
  return null;
}

async function runCellFence({ subject, prepared, options, runCommand, inspectWorktree, cellfenceInvocation }) {
  const invocation = cellfenceInvocation || { command: process.execPath, args: [cellfenceCli] };
  const args = [
    ...(invocation.args || []),
    "check", "--root", prepared.checkoutDir, "--manifest", prepared.manifestPath, "--json",
    ...(subject.check?.args || []),
  ];
  const guarded = await guardedCommand({
    id: "cellfence",
    command: invocation.command,
    args,
    checkoutDir: prepared.checkoutDir,
    expectedCommit: subject.commit,
    subjectDir: prepared.subjectDir,
    timeoutMs: Math.min(subject.check?.timeoutMs || options.timeoutMs, options.timeoutMs),
    runCommand,
    inspectWorktree,
  });
  if (guarded.classification) return { id: "cellfence", ...guarded };
  let classification = classifyExecution(guarded.result, { clean: [0], findings: [1], configurationError: [2] });
  let findings = [];
  let error;
  if (["clean", "findings"].includes(classification)) {
    try {
      const document = parseJson(guarded.result.stdout, "CellFence");
      if (!Array.isArray(document.findings)
        || (document.warnings !== undefined && !Array.isArray(document.warnings))) {
        throw new Error("CellFence JSON must contain findings[] and optional warnings[]");
      }
      findings = [...document.findings, ...(document.warnings || [])];
      classification = findings.length > 0 ? "findings" : "clean";
    } catch (parseError) {
      classification = "tool_error";
      error = parseError instanceof Error ? parseError.message : String(parseError);
    }
  } else if (!["unavailable"].includes(classification)) error = failureText(guarded.result);
  return {
    id: "cellfence",
    classification,
    exitCode: guarded.result.status,
    timedOut: guarded.result.timedOut,
    timeoutMs: guarded.result.timeoutMs,
    durationMs: guarded.result.durationMs,
    findings,
    error,
    safety: guarded.safety,
  };
}

async function runCompetitor({ analyzer, subject, prepared, cellfence, options, runCommand, inspectWorktree }) {
  const declared = declaredAnalyzerState(analyzer);
  if (declared) {
    return {
      id: analyzer.id,
      tool: analyzerTool(analyzer),
      execution: declared,
      comparison: { status: declared.classification, reason: declared.reason },
    };
  }
  const outputDir = path.join(prepared.subjectDir, "outputs");
  const homeDir = path.join(prepared.subjectDir, "homes", analyzer.id);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, "tmp"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, "cache"), { recursive: true });
  const outputPath = path.join(outputDir, `${analyzer.id}.out`);
  fs.rmSync(outputPath, { force: true });
  const args = expandedAnalyzerArguments(analyzer, { subject, ...prepared, outputPath });
  const unsafeReason = unsafeAnalyzerCommandReason(analyzer.command, args);
  if (unsafeReason) {
    return {
      id: analyzer.id,
      tool: analyzerTool(analyzer),
      execution: { classification: "not_comparable", reason: unsafeReason },
      comparison: { status: "not_comparable", reason: unsafeReason },
    };
  }
  const timeoutMs = Math.min(analyzer.timeoutMs || options.timeoutMs, options.timeoutMs);
  const guarded = await guardedCommand({
    id: analyzer.id,
    command: analyzer.command,
    args,
    checkoutDir: prepared.checkoutDir,
    expectedCommit: subject.commit,
    subjectDir: prepared.subjectDir,
    timeoutMs,
    env: {
      HOME: homeDir,
      TMPDIR: path.join(homeDir, "tmp"),
      XDG_CACHE_HOME: path.join(homeDir, "cache"),
    },
    runCommand,
    inspectWorktree,
  });
  if (guarded.classification) {
    return {
      id: analyzer.id,
      tool: analyzerTool(analyzer),
      execution: {
        classification: guarded.classification,
        error: guarded.error,
        ...(guarded.result ? {
          exitCode: guarded.result.status,
          timedOut: guarded.result.timedOut,
          durationMs: guarded.result.durationMs,
        } : {}),
        safety: guarded.safety,
      },
      comparison: { status: "unavailable", reason: guarded.error },
    };
  }
  let classification = classifyExecution(guarded.result, analyzer.exitCodes);
  let findings = [];
  let error;
  if (["clean", "findings"].includes(classification)) {
    try {
      const output = analyzerOutput(analyzer);
      let text = output.source === "stderr" ? guarded.result.stderr : guarded.result.stdout;
      if (output.source === "file") {
        if (!fs.existsSync(outputPath)) throw new Error(`${analyzer.id} did not write declared {output} file`);
        text = fs.readFileSync(outputPath, "utf8");
      }
      findings = normalizeCompetitorFindings(analyzer, text, prepared.checkoutDir);
      classification = findings.length > 0 ? "findings" : classification;
    } catch (parseError) {
      classification = "tool_error";
      error = parseError instanceof Error ? parseError.message : String(parseError);
    }
  } else if (!["unavailable"].includes(classification)) error = failureText(guarded.result);
  const execution = {
    classification,
    exitCode: guarded.result.status,
    timedOut: guarded.result.timedOut,
    timeoutMs: guarded.result.timeoutMs,
    durationMs: guarded.result.durationMs,
    findings: findings.length,
    error,
    safety: guarded.safety,
  };
  if (!["clean", "findings"].includes(classification)) {
    return {
      id: analyzer.id,
      tool: analyzerTool(analyzer),
      execution,
      comparison: {
        status: classification === "unavailable" || classification === "timeout" ? "unavailable" : "not_comparable",
        reason: error || `analyzer execution classified as ${classification}`,
      },
    };
  }
  if (classification === "findings" && findings.length === 0) {
    return {
      id: analyzer.id,
      tool: analyzerTool(analyzer),
      execution,
      comparison: { status: "not_comparable", reason: "analyzer reported findings without structured finding evidence" },
    };
  }
  if (!["clean", "findings"].includes(cellfence.classification)) {
    return {
      id: analyzer.id,
      tool: analyzerTool(analyzer),
      execution,
      findings,
      comparison: { status: "unavailable", reason: `CellFence execution classified as ${cellfence.classification}` },
    };
  }
  const normalizedCellFence = normalizeCellFenceFindings(cellfence.findings, analyzer, prepared.checkoutDir);
  return {
    id: analyzer.id,
    tool: analyzerTool(analyzer),
    execution,
    findings,
    comparison: compareNormalizedFindings(normalizedCellFence, findings),
  };
}

function unavailableCompetitors(analyzers, reason) {
  return analyzers.map((analyzer) => ({
    id: analyzer.id,
    tool: analyzerTool(analyzer),
    execution: { classification: "unavailable", reason },
    comparison: { status: "unavailable", reason },
  }));
}

async function runSubjectConformance(subject, context) {
  const { corpusDir, analyzers, options, runCommand, prepareSubject, inspectWorktree, cellfenceInvocation } = context;
  let prepared;
  try {
    prepared = await prepareSubject({ subject, corpusDir, options, runCommand, inspectWorktree });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: subject.id,
      repository: subject.repository,
      commit: subject.commit,
      status: "unavailable",
      error: message,
      cellfence: { id: "cellfence", classification: "unavailable", error: message },
      competitors: unavailableCompetitors(analyzers, message),
    };
  }
  const cellfence = await runCellFence({
    subject, prepared, options, runCommand, inspectWorktree, cellfenceInvocation,
  });
  const competitors = [];
  for (const analyzer of analyzers) {
    competitors.push(await runCompetitor({
      analyzer, subject, prepared, cellfence, options, runCommand, inspectWorktree,
    }));
  }
  const finalWorktree = await inspectWorktree({
    checkoutDir: prepared.checkoutDir,
    expectedCommit: subject.commit,
    runCommand,
    timeoutMs: options.timeoutMs,
  });
  let checkoutDiscarded = false;
  if (options.discardCheckouts && finalWorktree.clean) {
    fs.rmSync(prepared.checkoutDir, { recursive: true, force: true });
    checkoutDiscarded = true;
  }
  return {
    id: subject.id,
    repository: subject.repository,
    commit: subject.commit,
    status: finalWorktree.clean ? "completed" : "unsafe_worktree",
    subjectDir: prepared.subjectDir,
    manifestPath: prepared.manifestPath,
    safety: {
      exactCommit: finalWorktree.commitMatches === true,
      cleanBefore: prepared.initialWorktree?.clean !== false,
      cleanAfter: finalWorktree.clean,
      finalPorcelain: finalWorktree.porcelain || "",
    },
    cellfence,
    competitors,
    ...(checkoutDiscarded ? { checkoutDiscarded: true } : {}),
  };
}

function summarizeReport(subjects) {
  const executionClassifications = {};
  const comparisonStatuses = {};
  const findingComparisons = { comparable: 0, competitorOnly: 0, cellfenceOnly: 0, notComparable: 0 };
  for (const subject of subjects) {
    const cellfenceClass = subject.cellfence?.classification || "unavailable";
    executionClassifications[cellfenceClass] = (executionClassifications[cellfenceClass] || 0) + 1;
    for (const competitor of subject.competitors || []) {
      const classification = competitor.execution.classification;
      executionClassifications[classification] = (executionClassifications[classification] || 0) + 1;
      const status = competitor.comparison.status;
      comparisonStatuses[status] = (comparisonStatuses[status] || 0) + 1;
      for (const key of Object.keys(findingComparisons)) {
        findingComparisons[key] += competitor.comparison.counts?.[key] || 0;
      }
    }
  }
  return {
    subjects: subjects.length,
    executionClassifications: Object.fromEntries(Object.entries(executionClassifications).sort()),
    comparisonStatuses: Object.fromEntries(Object.entries(comparisonStatuses).sort()),
    findingComparisons,
  };
}

function reportShouldFail(report) {
  if (report.subjects.some((subject) => subject.status !== "completed")) return true;
  const failing = new Set(["configuration_error", "timeout", "tool_error"]);
  return report.subjects.some((subject) => (
    failing.has(subject.cellfence?.classification)
    || subject.competitors.some((competitor) => failing.has(competitor.execution.classification))
  ));
}

export async function runCompetitorOracleConformance(options, dependencies = {}) {
  const corpus = options.corpus || readJson(options.corpusPath);
  const analyzersDocument = options.analyzers || readJson(options.analyzersPath);
  const corpusDir = options.corpusDir || (options.corpusPath ? path.dirname(options.corpusPath) : process.cwd());
  validateCompetitorCorpus(corpus, corpusDir);
  const analyzers = validateCompetitorAnalyzers(analyzersDocument);
  const normalizedOptions = {
    workDir: options.workDir || defaultWorkDir,
    timeoutMs: options.timeoutMs || 300_000,
    maxSubjects: options.maxSubjects,
    cloneMode: options.cloneMode || "full",
    discardCheckouts: options.discardCheckouts === true,
  };
  if (!Number.isInteger(normalizedOptions.timeoutMs) || normalizedOptions.timeoutMs < 1 || normalizedOptions.timeoutMs > 300_000) {
    throw new Error("timeoutMs must be an integer from 1 to 300000");
  }
  if (!dependencies.runCommand && !fs.existsSync(cellfenceCli)) {
    throw new Error("CellFence CLI dist is missing; run npm run build before collecting oracle evidence");
  }
  fs.mkdirSync(normalizedOptions.workDir, { recursive: true });
  const runCommand = dependencies.runCommand || spawnCommand;
  const inspectWorktree = dependencies.inspectWorktree || inspectSubjectWorktree;
  const prepareSubject = dependencies.prepareSubject || prepareSubjectCheckout;
  const selected = corpus.subjects.slice(0, normalizedOptions.maxSubjects || corpus.subjects.length);
  const subjects = [];
  for (const subject of selected) {
    subjects.push(await runSubjectConformance(subject, {
      corpusDir,
      analyzers,
      options: normalizedOptions,
      runCommand,
      inspectWorktree,
      prepareSubject,
      cellfenceInvocation: dependencies.cellfenceInvocation,
    }));
  }
  const report = {
    schemaVersion: "cellfence.competitor-oracle-conformance.v1",
    generatedAt: (dependencies.now || (() => new Date()))().toISOString(),
    corpusSchemaVersion: corpus.schemaVersion,
    analyzerSchemaVersion: analyzersDocument.schemaVersion,
    safety: {
      exactCommitsRequired: true,
      targetRepositoryInstalls: "not_performed_by_harness",
      targetInstallScripts: "not_invoked_by_harness",
      shellExecution: "spawn-shell-disabled",
      analyzerDescriptors: "trusted_preprovisioned_code",
      timeoutMs: normalizedOptions.timeoutMs,
      worktreeRequiredCleanBeforeAndAfter: true,
    },
    interpretation: {
      kind: "descriptive_competitor_conformance",
      adjudication: "none",
      precisionClaimed: false,
      note: "Comparable, competitor-only, and CellFence-only findings are normalized tool observations; none is adjudicated as correct or incorrect.",
    },
    subjects,
    summary: summarizeReport(subjects),
  };
  return { report, exitCode: reportShouldFail(report) ? 1 : 0 };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseCompetitorOracleArgs(argv);
    if (options.help) {
      usage();
      return 0;
    }
    const result = await runCompetitorOracleConformance(options);
    writeJson(options.outPath, result.report);
    console.log(JSON.stringify(result.report.summary, null, 2));
    return result.exitCode;
  } catch (error) {
    usage();
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = await main();
}
