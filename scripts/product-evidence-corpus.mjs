import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  environmentMetadata,
  run,
  runSubject,
  summarize,
  validateCorpus,
} from "./corpus-precision-study.mjs";
import {
  classifyExit,
  installCommandReason,
  latencySummary,
  summarizeCommandFailure,
} from "./evidence-harness-lib.mjs";
import {
  matchesPattern,
  normalizePath,
  SOURCE_EXTENSIONS,
} from "../packages/engine/dist/file-index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.resolve(fileURLToPath(import.meta.url));
const cellfenceCli = path.join(repoRoot, "packages", "cli", "dist", "index.js");
const defaultWorkDir = path.join(repoRoot, "tmp", "product-evidence-corpus");
const defaultOutPath = path.join(repoRoot, "reports", "product-evidence-corpus.json");
const sourceExtensions = new Set(SOURCE_EXTENSIONS);

function usage() {
  console.error(`Usage: node scripts/product-evidence-corpus.mjs --corpus corpus.json [--analyzers analyzers.json] [--workdir tmp/product-evidence-corpus] [--out reports/product-evidence-corpus.json] [--timeout-ms 300000] [--max-subjects n] [--clone-mode full|shallow] [--infer-scope all|production] [--discard-checkouts] [--dry-run]

Runs CellFence against exact-commit corpus subjects without installing anything
in target repositories. Optional analyzers must already be provisioned. Entries
that require a target install are recorded as not_comparable and never run.`);
}

export function parseProductEvidenceArgs(argv) {
  const options = {
    corpusPath: "",
    analyzersPath: "",
    workDir: defaultWorkDir,
    outPath: defaultOutPath,
    timeoutMs: 300_000,
    maxSubjects: undefined,
    cloneMode: "full",
    inferScope: "all",
    discardCheckouts: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const readValue = (optionName) => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${optionName} requires a value`);
      index += 1;
      return value;
    };
    if (argument === "--corpus") options.corpusPath = path.resolve(readValue("--corpus"));
    else if (argument.startsWith("--corpus=")) options.corpusPath = path.resolve(argument.slice(9));
    else if (argument === "--analyzers") options.analyzersPath = path.resolve(readValue("--analyzers"));
    else if (argument.startsWith("--analyzers=")) options.analyzersPath = path.resolve(argument.slice(12));
    else if (argument === "--workdir") options.workDir = path.resolve(readValue("--workdir"));
    else if (argument.startsWith("--workdir=")) options.workDir = path.resolve(argument.slice(10));
    else if (argument === "--out") options.outPath = path.resolve(readValue("--out"));
    else if (argument.startsWith("--out=")) options.outPath = path.resolve(argument.slice(6));
    else if (argument === "--timeout-ms") options.timeoutMs = Number(readValue("--timeout-ms"));
    else if (argument.startsWith("--timeout-ms=")) options.timeoutMs = Number(argument.slice(13));
    else if (argument === "--max-subjects") options.maxSubjects = Number(readValue("--max-subjects"));
    else if (argument.startsWith("--max-subjects=")) options.maxSubjects = Number(argument.slice(15));
    else if (argument === "--clone-mode") options.cloneMode = readValue("--clone-mode");
    else if (argument.startsWith("--clone-mode=")) options.cloneMode = argument.slice(13);
    else if (argument === "--infer-scope") options.inferScope = readValue("--infer-scope");
    else if (argument.startsWith("--infer-scope=")) options.inferScope = argument.slice(14);
    else if (argument === "--discard-checkouts") options.discardCheckouts = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--help" || argument === "-h") return { help: true };
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.corpusPath) throw new Error("--corpus is required");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000) {
    throw new Error("--timeout-ms must be an integer from 1 to 300000");
  }
  if (options.maxSubjects !== undefined && (!Number.isInteger(options.maxSubjects) || options.maxSubjects < 1)) {
    throw new Error("--max-subjects must be a positive integer");
  }
  if (!["full", "shallow"].includes(options.cloneMode)) throw new Error("--clone-mode must be full or shallow");
  if (!["all", "production"].includes(options.inferScope)) throw new Error("--infer-scope must be all or production");
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function validateExitCodes(analyzer, key) {
  const values = analyzer.exitCodes?.[key];
  if (values === undefined) return;
  if (!Array.isArray(values) || values.some((value) => !Number.isInteger(value))) {
    throw new Error(`${analyzer.id} exitCodes.${key} must be an array of integers`);
  }
}

export function validateAnalyzersFile(value) {
  if (!value) return [];
  if (value.schemaVersion !== "cellfence.evidence-analyzers.v1") {
    throw new Error("analyzers schemaVersion must be cellfence.evidence-analyzers.v1");
  }
  if (!Array.isArray(value.analyzers)) throw new Error("analyzers must be an array");
  const ids = new Set(["cellfence"]);
  for (const analyzer of value.analyzers) {
    if (!analyzer || typeof analyzer !== "object") throw new Error("each analyzer must be an object");
    if (typeof analyzer.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(analyzer.id)) {
      throw new Error("each analyzer requires a stable id");
    }
    if (ids.has(analyzer.id)) throw new Error(`duplicate analyzer id: ${analyzer.id}`);
    ids.add(analyzer.id);
    if (analyzer.requiresTargetInstall !== true && analyzer.comparable !== false && analyzer.available !== false) {
      if (typeof analyzer.command !== "string" || analyzer.command.length === 0) {
        throw new Error(`${analyzer.id} requires command or an unavailable/not-comparable declaration`);
      }
      if (analyzer.args !== undefined && (!Array.isArray(analyzer.args) || analyzer.args.some((entry) => typeof entry !== "string"))) {
        throw new Error(`${analyzer.id} args must be an array of strings`);
      }
    }
    if (analyzer.timeoutMs !== undefined && (!Number.isInteger(analyzer.timeoutMs) || analyzer.timeoutMs < 1 || analyzer.timeoutMs > 300_000)) {
      throw new Error(`${analyzer.id} timeoutMs must be an integer from 1 to 300000`);
    }
    for (const key of ["clean", "findings", "configurationError"]) validateExitCodes(analyzer, key);
  }
  return value.analyzers;
}

function countLines(contents) {
  if (contents.length === 0) return 0;
  const newlines = contents.match(/\n/g)?.length || 0;
  return newlines + (contents.endsWith("\n") ? 0 : 1);
}

export function measureTrackedSource(checkoutDir, manifestPath) {
  const listed = run("git", ["ls-files", "-z"], { cwd: checkoutDir, timeoutMs: 60_000 });
  if (listed.status !== 0) {
    return { status: "unavailable", error: summarizeCommandFailure(listed), sourceFiles: null, sourceLines: null, kloc: null };
  }
  let sourceFiles = 0;
  let sourceLines = 0;
  let trackedSourceFiles = 0;
  let trackedSourceLines = 0;
  const manifest = readJson(manifestPath);
  const excluded = manifest.governance?.exclude || [];
  const governed = manifest.governance?.requireOwnership ? manifest.governance.include || [] : [];
  const owned = (manifest.cells || []).flatMap((cell) => cell.ownedPaths || []);
  for (const relativePath of listed.stdout.split("\0").filter(Boolean)) {
    if (!sourceExtensions.has(path.extname(relativePath).toLowerCase())) continue;
    const filePath = path.resolve(checkoutDir, relativePath);
    const relative = path.relative(checkoutDir, filePath);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    let stat;
    try {
      stat = fs.lstatSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const lineCount = countLines(fs.readFileSync(filePath, "utf8"));
    trackedSourceFiles += 1;
    trackedSourceLines += lineCount;
    const normalizedPath = normalizePath(relativePath);
    if (excluded.some((pattern) => matchesPattern(normalizedPath, pattern))) continue;
    if (![...owned, ...governed].some((pattern) => matchesPattern(normalizedPath, pattern))) continue;
    sourceFiles += 1;
    sourceLines += lineCount;
  }
  return {
    status: "measured",
    method: "git-ls-files/cellfence-source-extension/manifest-scope/physical-lines",
    sourceFiles,
    sourceLines,
    kloc: Number((sourceLines / 1000).toFixed(6)),
    trackedSourceFiles,
    trackedSourceLines,
  };
}

function withPerformance(evidence, durationMs) {
  const kloc = evidence.kloc;
  return {
    latencyMs: durationMs,
    kloc,
    msPerKloc: Number.isFinite(kloc) && kloc > 0
      ? Number((durationMs / kloc).toFixed(3))
      : null,
  };
}

function cellfenceAnalyzerResult(subjectResult, evidence) {
  if (!subjectResult.check) {
    return {
      id: "cellfence",
      classification: subjectResult.failureKind === "timeout" ? "timeout" : "unavailable",
      stage: subjectResult.stage,
      error: subjectResult.error,
    };
  }
  let classification = classifyExit({
    status: subjectResult.check.exitCode,
    timedOut: subjectResult.check.status === "timeout",
  }, { clean: [0], findings: [1], configurationError: [2] });
  if (["unparseable_output", "missing_graph", "verification_failed"].includes(subjectResult.check.status)) {
    classification = "tool_error";
  }
  return {
    id: "cellfence",
    classification,
    exitCode: subjectResult.check.exitCode,
    findings: subjectResult.check.findings,
    warnings: subjectResult.check.warnings,
    timeoutMs: subjectResult.check.timeoutMs,
    ...withPerformance(evidence, subjectResult.check.durationMs),
  };
}

function expandAnalyzerArguments(analyzer, subjectResult) {
  const replacements = new Map([
    ["{root}", path.join(subjectResult.subjectDir, "checkout")],
    ["{manifest}", subjectResult.manifest?.effectivePath || ""],
    ["{subjectId}", subjectResult.id],
    ["{commit}", subjectResult.commit || ""],
  ]);
  return (analyzer.args || []).map((argument) => replacements.has(argument) ? replacements.get(argument) : argument);
}

function worktreeStatus(checkoutDir) {
  return run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: checkoutDir,
    timeoutMs: 60_000,
  });
}

function declaredAnalyzerResult(analyzer) {
  if (analyzer.requiresTargetInstall === true) {
    return {
      id: analyzer.id,
      classification: "not_comparable",
      reason: analyzer.reason || "analyzer requires a target-repository install, which this harness forbids",
    };
  }
  if (analyzer.comparable === false) {
    return {
      id: analyzer.id,
      classification: "not_comparable",
      reason: analyzer.reason || "analyzer does not expose comparable evidence for this corpus",
    };
  }
  if (analyzer.available === false) {
    return {
      id: analyzer.id,
      classification: "unavailable",
      reason: analyzer.reason || "analyzer was declared unavailable",
    };
  }
  return null;
}

function runAnalyzer(analyzer, subjectResult, evidence, defaultTimeoutMs) {
  const declared = declaredAnalyzerResult(analyzer);
  if (declared) return declared;
  const checkoutDir = path.join(subjectResult.subjectDir, "checkout");
  if (!subjectResult.commit || !fs.existsSync(checkoutDir)) {
    return { id: analyzer.id, classification: "unavailable", reason: "subject checkout is unavailable" };
  }
  const args = expandAnalyzerArguments(analyzer, subjectResult);
  const installReason = installCommandReason(analyzer.command, args);
  if (installReason) {
    return { id: analyzer.id, classification: "not_comparable", reason: installReason };
  }
  const before = worktreeStatus(checkoutDir);
  if (before.status !== 0 || before.stdout.trim()) {
    return { id: analyzer.id, classification: "unavailable", reason: "subject checkout is not clean before analyzer execution" };
  }
  const result = run(analyzer.command, args, {
    cwd: checkoutDir,
    timeoutMs: Math.min(analyzer.timeoutMs || defaultTimeoutMs, defaultTimeoutMs),
  });
  const logDir = path.join(subjectResult.subjectDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, `${analyzer.id}.stdout.log`), result.stdout);
  fs.writeFileSync(path.join(logDir, `${analyzer.id}.stderr.log`), result.stderr);
  let classification = classifyExit(result, analyzer.exitCodes);
  let error = ["clean", "findings", "configuration_error"].includes(classification)
    ? undefined
    : summarizeCommandFailure(result);
  const after = worktreeStatus(checkoutDir);
  if (after.status !== 0 || after.stdout.trim()) {
    classification = "tool_error";
    error = "analyzer modified the target checkout";
  }
  return {
    id: analyzer.id,
    classification,
    exitCode: result.status,
    timedOut: result.timedOut,
    timeoutMs: result.timeoutMs,
    error,
    ...withPerformance(evidence, result.durationMs),
  };
}

function evidenceSummary(subjects) {
  const classifications = {};
  const analyzerLatencies = {};
  let sourceLines = 0;
  for (const subject of subjects) {
    if (Number.isFinite(subject.scale?.sourceLines)) sourceLines += subject.scale.sourceLines;
    for (const analyzer of subject.analyzers || []) {
      classifications[analyzer.classification] = (classifications[analyzer.classification] || 0) + 1;
      if (Number.isFinite(analyzer.latencyMs)) {
        if (!analyzerLatencies[analyzer.id]) analyzerLatencies[analyzer.id] = [];
        analyzerLatencies[analyzer.id].push(analyzer.latencyMs);
      }
    }
  }
  return {
    sourceLines,
    kloc: Number((sourceLines / 1000).toFixed(6)),
    analyzerClassifications: Object.fromEntries(Object.entries(classifications).sort()),
    latencyByAnalyzer: Object.fromEntries(
      Object.entries(analyzerLatencies).sort(([left], [right]) => left.localeCompare(right))
        .map(([id, values]) => [id, latencySummary(values)]),
    ),
  };
}

function shouldFail(report) {
  const base = report.summary.corpusStudy;
  if (base.failed > 0 || base.configurationErrors > 0 || base.toolErrors > 0 || base.unparseableOutputs > 0 || base.timeouts > 0) return true;
  return report.subjects.some((subject) => (subject.analyzers || []).some((analyzer) => (
    ["configuration_error", "timeout", "tool_error"].includes(analyzer.classification)
  )));
}

export function runProductEvidence(options) {
  if (!options.dryRun && !fs.existsSync(cellfenceCli)) {
    throw new Error("CellFence CLI dist is missing; run npm run build before collecting product evidence");
  }
  const originalCorpus = readJson(options.corpusPath);
  const corpus = {
    ...originalCorpus,
    subjects: (originalCorpus.subjects || []).map((subject) => ({
      ...subject,
      check: {
        ...(subject.check || {}),
        timeoutMs: Math.min(subject.check?.timeoutMs || options.timeoutMs, options.timeoutMs),
      },
    })),
  };
  const corpusDir = path.dirname(options.corpusPath);
  const studyOptions = {
    workDir: options.workDir,
    allowFloatingRef: false,
    cloneMode: options.cloneMode,
    discardCheckouts: false,
    inferScope: options.inferScope,
    verifyEvidenceGraphs: false,
    dryRun: options.dryRun,
  };
  validateCorpus(corpus, studyOptions, corpusDir);
  const analyzers = validateAnalyzersFile(options.analyzersPath ? readJson(options.analyzersPath) : null);
  fs.mkdirSync(options.workDir, { recursive: true });
  const selected = corpus.subjects.slice(0, options.maxSubjects || corpus.subjects.length);
  const subjects = selected.map((subject) => {
    const result = runSubject(subject, corpusDir, studyOptions);
    if (options.dryRun) return { ...result, scale: null, analyzers: [] };
    const checkoutDir = path.join(result.subjectDir, "checkout");
    const manifestPath = result.manifest?.effectivePath
      ? (path.isAbsolute(result.manifest.effectivePath)
        ? result.manifest.effectivePath
        : path.resolve(checkoutDir, result.manifest.effectivePath))
      : undefined;
    const scale = fs.existsSync(checkoutDir) && manifestPath && fs.existsSync(manifestPath)
      ? measureTrackedSource(checkoutDir, manifestPath) : {
      status: "unavailable", sourceFiles: null, sourceLines: null, kloc: null,
    };
    const analyzerResults = [cellfenceAnalyzerResult(result, scale)];
    for (const analyzer of analyzers) analyzerResults.push(runAnalyzer(analyzer, result, scale, options.timeoutMs));
    if (options.discardCheckouts) fs.rmSync(checkoutDir, { recursive: true, force: true });
    return {
      ...result,
      ...(options.discardCheckouts ? { checkoutDiscarded: true } : {}),
      scale,
      analyzers: analyzerResults,
    };
  });
  const report = {
    schemaVersion: "cellfence.product-evidence-corpus.v1",
    generatedAt: new Date().toISOString(),
    corpusPath: options.corpusPath,
    analyzersPath: options.analyzersPath || null,
    safety: {
      exactCommitsRequired: true,
      targetRepositoryInstalls: "not_performed_by_harness",
      shellExecution: "spawn-shell-disabled",
      analyzerDescriptors: "trusted_preprovisioned_code",
      timeoutMs: options.timeoutMs,
    },
    environment: environmentMetadata(options.corpusPath),
    subjects,
    summary: {
      corpusStudy: summarize(subjects),
      evidence: evidenceSummary(subjects),
    },
  };
  return { report, exitCode: shouldFail(report) ? 1 : 0 };
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseProductEvidenceArgs(argv);
    if (options.help) {
      usage();
      return 0;
    }
    const result = runProductEvidence(options);
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
  process.exitCode = main();
}
