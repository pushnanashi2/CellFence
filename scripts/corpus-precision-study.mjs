import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkDir = path.join(repoRoot, "tmp", "corpus-precision-study");
const defaultOutPath = path.join(repoRoot, "reports", "corpus-precision-study.json");
const cellfenceCli = path.join(repoRoot, "packages", "cli", "dist", "index.js");
const evidenceGraphVerifier = path.join(repoRoot, "scripts", "evidence-graph-verify.mjs");
const defaultManifestPath = "cellfence.manifest.json";
const commandTimeouts = {
  clone: 600_000,
  checkout: 120_000,
  revParse: 60_000,
  manifest: 180_000,
  check: 300_000,
  evidenceGraphVerify: 120_000,
};
const fixedCheckArguments = new Set([
  "--root",
  "--manifest",
  "--json",
  "--format",
  "--audit-log",
  "--summary-json",
  "--changed",
  "--evidence-graph",
  "--base",
  "--head",
]);

class SubjectFailure extends Error {
  constructor(stage, failureKind, message, details = {}) {
    super(message);
    this.name = "SubjectFailure";
    this.stage = stage;
    this.failureKind = failureKind;
    Object.assign(this, details);
  }
}

function usage() {
  console.error(`Usage: node scripts/corpus-precision-study.mjs --corpus corpus.json [--workdir tmp/corpus] [--out reports/corpus.json] [--max-subjects n] [--dry-run] [--allow-floating-ref] [--clone-mode full|shallow] [--discard-checkouts] [--infer-scope all|production] [--verify-evidence-graphs]

Runs a frozen-corpus CellFence precision/onboarding pass.
The script clones each subject at an exact commit, prepares a manifest, runs
cellfence check --json, and writes a failure-inclusive report. It never runs
package install scripts in the target repositories. With --verify-evidence-graphs
it also emits a per-subject evidence graph and verifies it with the standalone
graph verifier.`);
}

function parseArgs(argv) {
  const parsed = {
    corpusPath: "",
    workDir: defaultWorkDir,
    outPath: defaultOutPath,
    dryRun: false,
    allowFloatingRef: false,
    cloneMode: "full",
    discardCheckouts: false,
    inferScope: "all",
    verifyEvidenceGraphs: false,
    maxSubjects: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") {
      parsed.corpusPath = path.resolve(argv[index + 1] || "");
      index += 1;
    } else if (argument.startsWith("--corpus=")) {
      parsed.corpusPath = path.resolve(argument.slice("--corpus=".length));
    } else if (argument === "--workdir") {
      parsed.workDir = path.resolve(argv[index + 1] || "");
      index += 1;
    } else if (argument.startsWith("--workdir=")) {
      parsed.workDir = path.resolve(argument.slice("--workdir=".length));
    } else if (argument === "--out") {
      parsed.outPath = path.resolve(argv[index + 1] || "");
      index += 1;
    } else if (argument.startsWith("--out=")) {
      parsed.outPath = path.resolve(argument.slice("--out=".length));
    } else if (argument === "--max-subjects") {
      parsed.maxSubjects = Number(argv[index + 1] || 0);
      index += 1;
    } else if (argument.startsWith("--max-subjects=")) {
      parsed.maxSubjects = Number(argument.slice("--max-subjects=".length));
    } else if (argument === "--dry-run") {
      parsed.dryRun = true;
    } else if (argument === "--allow-floating-ref") {
      parsed.allowFloatingRef = true;
    } else if (argument === "--clone-mode") {
      parsed.cloneMode = argv[index + 1] || "";
      index += 1;
    } else if (argument.startsWith("--clone-mode=")) {
      parsed.cloneMode = argument.slice("--clone-mode=".length);
    } else if (argument === "--discard-checkouts") {
      parsed.discardCheckouts = true;
    } else if (argument === "--verify-evidence-graphs") {
      parsed.verifyEvidenceGraphs = true;
    } else if (argument === "--infer-scope") {
      parsed.inferScope = argv[index + 1] || "";
      index += 1;
    } else if (argument.startsWith("--infer-scope=")) {
      parsed.inferScope = argument.slice("--infer-scope=".length);
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.corpusPath) throw new Error("--corpus is required");
  if (parsed.maxSubjects !== undefined && (!Number.isInteger(parsed.maxSubjects) || parsed.maxSubjects < 1)) {
    throw new Error("--max-subjects must be a positive integer");
  }
  if (!["full", "shallow"].includes(parsed.cloneMode)) {
    throw new Error("--clone-mode must be full or shallow");
  }
  if (!["all", "production"].includes(parsed.inferScope)) {
    throw new Error("--infer-scope must be all or production");
  }
  return parsed;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function slugSubjectId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "subject";
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
  if (!isPathWithin(base, candidate, false)) {
    throw new Error(`${label} resolves outside its root: ${candidatePath}`);
  }
  return candidate;
}

function subjectDirectory(workDir, id) {
  const slug = slugSubjectId(id);
  const digest = hashText(id).slice(0, 12);
  return resolveWithin(workDir, `${slug}-${digest}`, "subject id");
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
}

function summarizeFailure(result) {
  return result.error || result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join("\n") || result.stdout.trim().split(/\r?\n/).filter(Boolean).slice(-3).join("\n") || `exit ${result.status}`;
}

function commandFailure(stage, result) {
  if (result.timedOut) {
    throw new SubjectFailure(stage, "timeout", `${stage} timed out after ${result.timeoutMs}ms`, {
      timeoutMs: result.timeoutMs,
      exitCode: result.status,
      durationMs: result.durationMs,
    });
  }
  throw new SubjectFailure(stage, "command_failed", summarizeFailure(result), {
    exitCode: result.status,
    durationMs: result.durationMs,
  });
}

function validateCheckArgs(subjectId, args) {
  if (args === undefined) return;
  if (!Array.isArray(args)) throw new Error(`${subjectId} check.args must be an array`);
  for (const argument of args) {
    if (typeof argument !== "string" || argument.length === 0) {
      throw new Error(`${subjectId} check.args entries must be non-empty strings`);
    }
    const optionName = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
    if (fixedCheckArguments.has(optionName)) {
      throw new Error(`${subjectId} check.args cannot override fixed CellFence check argument ${optionName}`);
    }
  }
}

function validateCheckTimeout(subjectId, timeoutMs) {
  if (timeoutMs === undefined) return;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > commandTimeouts.check) {
    throw new Error(`${subjectId} check.timeoutMs must be an integer from 1 to ${commandTimeouts.check}`);
  }
}

function gitWorktreeStatus(checkoutDir, subjectDir, name) {
  const result = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: checkoutDir,
    timeoutMs: commandTimeouts.revParse,
  });
  writeCommandLogs(subjectDir, name, result);
  if (result.status !== 0) commandFailure("checkout", result);
  const porcelain = result.stdout.trim();
  return {
    clean: porcelain.length === 0,
    porcelain,
  };
}

function validateCorpus(corpus, options, corpusDir) {
  if (corpus.schemaVersion !== "cellfence.corpus.v1") {
    throw new Error("corpus schemaVersion must be cellfence.corpus.v1");
  }
  if (!Array.isArray(corpus.subjects) || corpus.subjects.length === 0) {
    throw new Error("corpus must contain at least one subject");
  }
  const ids = new Set();
  const subjectDirs = new Set();
  for (const subject of corpus.subjects) {
    if (!subject || typeof subject !== "object") throw new Error("each subject must be an object");
    if (typeof subject.id !== "string" || subject.id.length === 0) throw new Error("each subject requires id");
    if (subject.id === "." || subject.id === "..") throw new Error(`subject id is not allowed: ${subject.id}`);
    if (ids.has(subject.id)) throw new Error(`duplicate subject id: ${subject.id}`);
    ids.add(subject.id);
    const subjectDir = subjectDirectory(options.workDir, subject.id);
    if (subjectDirs.has(subjectDir)) throw new Error(`duplicate subject directory for id: ${subject.id}`);
    subjectDirs.add(subjectDir);
    if (!subject.repository) throw new Error(`${subject.id} requires repository`);
    if (!options.allowFloatingRef && !isExactCommit(subject.commit)) {
      throw new Error(`${subject.id} requires exact 40-hex commit; use --allow-floating-ref only for exploratory runs`);
    }
    const strategy = subject.manifest?.strategy || "existing";
    const manifestPath = subject.manifest?.path || defaultManifestPath;
    if (strategy === "infer" && manifestPath !== defaultManifestPath) {
      throw new Error(`${subject.id} manifest.strategy=infer only supports ${defaultManifestPath}`);
    }
    validateContainedRelativePath(manifestPath, `${subject.id} manifest.path`);
    if (subject.manifest?.strategy === "copy" && !subject.manifest.source) {
      throw new Error(`${subject.id} manifest.strategy=copy requires manifest.source`);
    }
    if (subject.manifest?.scope !== undefined) {
      if (strategy !== "infer") throw new Error(`${subject.id} manifest.scope is only supported with manifest.strategy=infer`);
      if (!["all", "production"].includes(subject.manifest.scope)) {
        throw new Error(`${subject.id} manifest.scope must be all or production`);
      }
    }
    if (strategy === "copy") {
      const sourcePath = resolveWithin(corpusDir, subject.manifest.source, `${subject.id} manifest.source`);
      if (!fs.existsSync(sourcePath)) throw new Error(`${subject.id} manifest.source not found: ${subject.manifest.source}`);
      assertRealPathWithin(corpusDir, sourcePath, `${subject.id} manifest.source`);
    }
    for (const fromPath of subject.manifest?.from || []) {
      validateContainedRelativePath(fromPath, `${subject.id} manifest.from`);
    }
    validateCheckArgs(subject.id, subject.check?.args);
    validateCheckTimeout(subject.id, subject.check?.timeoutMs);
  }
}

function findingsByRule(findings) {
  const counts = {};
  for (const finding of findings || []) {
    counts[finding.ruleId] = (counts[finding.ruleId] || 0) + 1;
  }
  return counts;
}

function expectationResult(expected, checkResult) {
  if (!expected) return { status: "unlabeled", failures: [] };
  const failures = [];
  if (expected.exitCode !== undefined && checkResult.exitCode !== expected.exitCode) {
    failures.push(`expected exitCode ${expected.exitCode}, got ${checkResult.exitCode}`);
  }
  const ruleCounts = checkResult.findingsByRule || {};
  for (const ruleId of expected.requiredRuleIds || []) {
    if (!ruleCounts[ruleId]) failures.push(`expected rule ${ruleId} to be present`);
  }
  for (const ruleId of expected.forbiddenRuleIds || []) {
    if (ruleCounts[ruleId]) failures.push(`expected rule ${ruleId} to be absent`);
  }
  return { status: failures.length === 0 ? "passed" : "failed", failures };
}

function prepareManifest(subject, checkoutDir, corpusDir, subjectDir, options) {
  const strategy = subject.manifest?.strategy || "existing";
  const manifestPath = subject.manifest?.path || defaultManifestPath;
  const inferScope = subject.manifest?.scope || options.inferScope;
  const startedAt = performance.now();
  let effectivePath;
  if (strategy === "existing") {
    const fullPath = resolveWithin(checkoutDir, manifestPath, "manifest.path");
    if (!fs.existsSync(fullPath)) throw new Error(`manifest not found: ${manifestPath}`);
    assertRealPathWithin(checkoutDir, fullPath, "manifest.path");
    effectivePath = manifestPath;
  } else if (strategy === "copy") {
    const sourcePath = resolveWithin(corpusDir, subject.manifest.source, "manifest.source");
    assertRealPathWithin(corpusDir, sourcePath, "manifest.source");
    const controlDir = path.join(subjectDir, "control");
    const targetPath = resolveWithin(controlDir, manifestPath, "manifest.path");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    effectivePath = targetPath;
  } else if (strategy === "infer") {
    if (manifestPath !== defaultManifestPath) {
      throw new Error(`manifest.strategy=infer only supports ${defaultManifestPath}`);
    }
    const controlDir = path.join(subjectDir, "control");
    const targetPath = resolveWithin(controlDir, manifestPath, "manifest.path");
    const args = ["init", "--root", checkoutDir, "--output", targetPath, "--no-scaffold"];
    if (inferScope === "production") args.push("--production-scope");
    if (subject.manifest?.preset) args.push("--preset", subject.manifest.preset);
    for (const fromPath of subject.manifest?.from || []) args.push("--from", fromPath);
    const result = run(process.execPath, [cellfenceCli, ...args], { cwd: checkoutDir, timeoutMs: commandTimeouts.manifest });
    writeCommandLogs(subjectDir, "manifest", result);
    if (result.status !== 0) commandFailure("manifest", result);
    effectivePath = targetPath;
  } else {
    throw new Error(`unsupported manifest strategy: ${strategy}`);
  }
  const manifestFilePath = path.isAbsolute(effectivePath) ? effectivePath : path.resolve(checkoutDir, effectivePath);
  return {
    strategy,
    ...(strategy === "infer" ? { scope: inferScope } : {}),
    path: manifestPath,
    effectivePath,
    sha256: hashFile(manifestFilePath),
    status: "completed",
    durationMs: Math.round(performance.now() - startedAt),
  };
}

function cloneSubject(subject, subjectDir, options) {
  const checkoutDir = path.join(subjectDir, "checkout");
  fs.rmSync(checkoutDir, { recursive: true, force: true });
  const cloneArgs = ["clone", "--quiet", "--no-tags"];
  if (options.cloneMode === "shallow") cloneArgs.push("--depth", "1", "--filter=blob:none");
  cloneArgs.push(subject.repository, checkoutDir);
  const clone = run("git", cloneArgs, {
    cwd: options.workDir,
    timeoutMs: commandTimeouts.clone,
  });
  writeCommandLogs(subjectDir, "clone", clone);
  if (clone.status !== 0) commandFailure("clone", clone);

  const checkoutTarget = subject.commit || subject.ref || "HEAD";
  const checkout = run("git", ["checkout", "--quiet", "--detach", checkoutTarget], {
    cwd: checkoutDir,
    timeoutMs: commandTimeouts.checkout,
  });
  writeCommandLogs(subjectDir, "checkout", checkout);
  if (checkout.status !== 0) commandFailure("checkout", checkout);

  const revParse = run("git", ["rev-parse", "HEAD"], { cwd: checkoutDir, timeoutMs: commandTimeouts.revParse });
  writeCommandLogs(subjectDir, "rev-parse", revParse);
  if (revParse.status !== 0) commandFailure("rev-parse", revParse);
  const actualCommit = revParse.stdout.trim();
  if (subject.commit && actualCommit !== subject.commit) {
    throw new SubjectFailure("checkout", "commit_mismatch", `checked out ${actualCommit}, expected ${subject.commit}`);
  }
  const tree = run("git", ["rev-parse", "HEAD^{tree}"], { cwd: checkoutDir, timeoutMs: commandTimeouts.revParse });
  writeCommandLogs(subjectDir, "tree", tree);
  if (tree.status !== 0) commandFailure("rev-parse", tree);
  return { checkoutDir, actualCommit, gitTree: tree.stdout.trim() };
}

function discardCheckoutIfRequested(subjectResult, subjectDir, options) {
  if (!options.discardCheckouts || options.dryRun) return subjectResult;
  fs.rmSync(path.join(subjectDir, "checkout"), { recursive: true, force: true });
  return {
    ...subjectResult,
    checkoutDiscarded: true,
  };
}

function evidenceGraphVerification(subjectDir, evidenceGraphPath) {
  const reportPath = path.join(subjectDir, "logs", "evidence-graph-verifier.json");
  if (!fs.existsSync(evidenceGraphPath)) {
    return {
      ok: false,
      status: "missing_graph",
      graphPath: evidenceGraphPath,
      reportPath,
      error: "CellFence did not write the requested evidence graph",
    };
  }
  const result = run(process.execPath, [
    evidenceGraphVerifier,
    "--graph",
    evidenceGraphPath,
    "--out",
    reportPath,
  ], { cwd: repoRoot, timeoutMs: commandTimeouts.evidenceGraphVerify });
  writeCommandLogs(subjectDir, "evidence-graph-verify", result);
  let report = null;
  try {
    if (fs.existsSync(reportPath)) report = readJson(reportPath);
  } catch (error) {
    report = { parseError: error instanceof Error ? error.message : String(error) };
  }
  return {
    ok: result.status === 0,
    status: result.status === 0 ? "verified" : "verification_failed",
    graphPath: evidenceGraphPath,
    graphSha256: hashFile(evidenceGraphPath),
    reportPath,
    reportSha256: fs.existsSync(reportPath) ? hashFile(reportPath) : null,
    exitCode: result.status,
    durationMs: result.durationMs,
    summary: report?.summary || null,
    error: result.status === 0 ? undefined : summarizeFailure(result),
  };
}

function runCheck(subject, checkoutDir, subjectDir, manifestPath, options) {
  validateCheckArgs(subject.id, subject.check?.args);
  validateCheckTimeout(subject.id, subject.check?.timeoutMs);
  const auditLogPath = path.join(subjectDir, "logs", "check.audit.jsonl");
  const evidenceGraphPath = path.join(subjectDir, "logs", "evidence-graph.json");
  fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
  const args = [
    cellfenceCli,
    "check",
    "--root",
    checkoutDir,
    "--manifest",
    manifestPath,
    "--json",
    "--audit-log",
    auditLogPath,
    ...(subject.check?.args || []),
  ];
  if (options.verifyEvidenceGraphs) args.push("--evidence-graph", evidenceGraphPath);
  const result = run(process.execPath, args, { cwd: checkoutDir, timeoutMs: subject.check?.timeoutMs || commandTimeouts.check });
  writeCommandLogs(subjectDir, "check", result);
  if (result.timedOut) {
    return {
      status: "timeout",
      exitCode: result.status,
      ok: false,
      findings: null,
      warnings: null,
      findingsByRule: {},
      durationMs: result.durationMs,
      timeoutMs: result.timeoutMs,
      error: `CellFence check timed out after ${result.timeoutMs}ms`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return {
      status: "unparseable_output",
      exitCode: result.status,
      ok: false,
      findings: null,
      warnings: null,
      findingsByRule: {},
      durationMs: result.durationMs,
      error: `failed to parse CellFence JSON output: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  let status = "tool_error";
  if (result.status === 0) status = "checked_clean";
  else if (result.status === 1) status = "checked_findings";
  else if (result.status === 2) status = "configuration_error";
  const checkResult = {
    status,
    exitCode: result.status,
    ok: parsed.ok === true,
    findings: findings.length,
    warnings: warnings.length,
    findingsByRule: findingsByRule(findings),
    auditLogPath,
    auditLogSha256: fs.existsSync(auditLogPath) ? hashFile(auditLogPath) : null,
    durationMs: result.durationMs,
  };
  if (!options.verifyEvidenceGraphs || (result.status !== 0 && result.status !== 1)) return checkResult;
  const verification = evidenceGraphVerification(subjectDir, evidenceGraphPath);
  return {
    ...checkResult,
    ...(verification.ok ? {} : { status: verification.status, ok: false }),
    evidenceGraph: verification,
  };
}

function summarize(subjects) {
  const summary = {
    total: subjects.length,
    completed: 0,
    planned: 0,
    failed: 0,
    checksRun: 0,
    checksClean: 0,
    checksWithFindings: 0,
    configurationErrors: 0,
    toolErrors: 0,
    unparseableOutputs: 0,
    timeouts: 0,
    evidenceGraphsVerified: 0,
    evidenceGraphFailures: 0,
    totalFindings: 0,
    findingsByRule: {},
    expectations: {
      labeled: 0,
      passed: 0,
      failed: 0,
      unlabeled: 0,
    },
  };
  for (const subject of subjects) {
    if (subject.status === "checked_clean" || subject.status === "checked_findings") summary.completed += 1;
    else if (subject.status === "planned") summary.planned += 1;
    else summary.failed += 1;
    if (subject.failureKind === "timeout") summary.timeouts += 1;
    if (subject.check) {
      summary.checksRun += 1;
      if (subject.check.status === "unparseable_output") {
        summary.unparseableOutputs += 1;
      } else if (subject.check.status === "timeout") {
        summary.timeouts += 1;
      } else if (subject.check.status === "missing_graph" || subject.check.status === "verification_failed") {
        summary.toolErrors += 1;
      } else if (subject.check.exitCode === 0) {
        summary.checksClean += 1;
      } else if (subject.check.exitCode === 1) {
        summary.checksWithFindings += 1;
      } else if (subject.check.exitCode === 2) {
        summary.configurationErrors += 1;
      } else {
        summary.toolErrors += 1;
      }
      summary.totalFindings += Number(subject.check.findings || 0);
      for (const [ruleId, count] of Object.entries(subject.check.findingsByRule || {})) {
        summary.findingsByRule[ruleId] = (summary.findingsByRule[ruleId] || 0) + count;
      }
      if (subject.check.evidenceGraph?.ok) summary.evidenceGraphsVerified += 1;
      if (subject.check.evidenceGraph && !subject.check.evidenceGraph.ok) summary.evidenceGraphFailures += 1;
    }
    const expectation = subject.expectation?.status || "unlabeled";
    if (expectation === "unlabeled") summary.expectations.unlabeled += 1;
    else {
      summary.expectations.labeled += 1;
      if (expectation === "passed") summary.expectations.passed += 1;
      if (expectation === "failed") summary.expectations.failed += 1;
    }
  }
  return summary;
}

function runSubject(subject, corpusDir, options) {
  const subjectDir = subjectDirectory(options.workDir, subject.id);
  fs.rmSync(subjectDir, { recursive: true, force: true });
  fs.mkdirSync(subjectDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  const base = {
    id: subject.id,
    repository: subject.repository,
    requestedCommit: subject.commit || null,
    requestedRef: subject.ref || null,
    startedAt,
  };
  if (options.dryRun) {
    const strategy = subject.manifest?.strategy || "existing";
    return {
      ...base,
      status: "planned",
      manifest: {
        strategy,
        path: subject.manifest?.path || defaultManifestPath,
        ...(strategy === "infer"
          ? { scope: subject.manifest?.scope || options.inferScope }
          : {}),
      },
      subjectDir,
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAtMs),
    };
  }
  try {
    const clone = cloneSubject(subject, subjectDir, options);
    const worktreeBeforeManifest = gitWorktreeStatus(clone.checkoutDir, subjectDir, "status-before-manifest");
    let manifest;
    try {
      manifest = prepareManifest(subject, clone.checkoutDir, corpusDir, subjectDir, options);
    } catch (error) {
      if (error instanceof SubjectFailure) throw error;
      throw new SubjectFailure("manifest", "manifest_error", error instanceof Error ? error.message : String(error));
    }
    const worktreeBeforeCheck = gitWorktreeStatus(clone.checkoutDir, subjectDir, "status-before-check");
    if (!worktreeBeforeCheck.clean) {
      throw new SubjectFailure("manifest", "dirty_worktree", "manifest preparation modified the subject checkout", {
        worktreeStatus: worktreeBeforeCheck.porcelain,
      });
    }
    const check = runCheck(subject, clone.checkoutDir, subjectDir, manifest.effectivePath, options);
    const expectation = expectationResult(subject.expected, check);
    const result = {
      ...base,
      status: check.status,
      commit: clone.actualCommit,
      gitTree: clone.gitTree,
      subjectDir,
      cloneMode: options.cloneMode,
      subjectWorktreeCleanBeforeManifest: worktreeBeforeManifest.clean,
      subjectWorktreeCleanBeforeCheck: worktreeBeforeCheck.clean,
      manifest,
      check,
      expectation,
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAtMs),
    };
    return discardCheckoutIfRequested(result, subjectDir, options);
  } catch (error) {
    const result = {
      ...base,
      status: error instanceof SubjectFailure ? `${error.stage}_failed` : "failed",
      stage: error instanceof SubjectFailure ? error.stage : undefined,
      failureKind: error instanceof SubjectFailure ? error.failureKind : "error",
      timeoutMs: error instanceof SubjectFailure ? error.timeoutMs : undefined,
      exitCode: error instanceof SubjectFailure ? error.exitCode : undefined,
      worktreeStatus: error instanceof SubjectFailure ? error.worktreeStatus : undefined,
      subjectDir,
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAtMs),
    };
    return discardCheckoutIfRequested(result, subjectDir, options);
  }
}

function readTextIfOk(command, args) {
  const result = run(command, args, { cwd: repoRoot, timeoutMs: 30_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function environmentMetadata(corpusPath) {
  const packageJson = readJson(path.join(repoRoot, "package.json"));
  const harnessCommit = readTextIfOk("git", ["rev-parse", "HEAD"]);
  const gitVersion = readTextIfOk("git", ["--version"]);
  const gitStatus = readTextIfOk("git", ["status", "--short"]);
  return {
    harnessCommit,
    harnessDirty: gitStatus === null ? null : gitStatus.length > 0,
    cellfenceVersion: packageJson.version,
    cellfenceSourceCommit: harnessCommit,
    cellfenceCliSha256: fs.existsSync(cellfenceCli) ? hashFile(cellfenceCli) : null,
    corpusSha256: hashFile(corpusPath),
    nodeVersion: process.version,
    gitVersion,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
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

  if (!options.dryRun && !fs.existsSync(cellfenceCli)) {
    console.error("CellFence CLI dist is missing; run npm run build before the corpus study");
    return 2;
  }

  let corpus;
  let corpusDir;
  try {
    corpus = readJson(options.corpusPath);
    corpusDir = path.dirname(options.corpusPath);
    validateCorpus(corpus, options, corpusDir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  fs.mkdirSync(options.workDir, { recursive: true });
  const subjects = corpus.subjects.slice(0, options.maxSubjects || corpus.subjects.length)
    .map((subject) => runSubject(subject, corpusDir, options));

  const report = {
    schemaVersion: "cellfence.corpus-study.v1",
    generatedAt: new Date().toISOString(),
    corpusPath: options.corpusPath,
    dryRun: options.dryRun,
    allowFloatingRef: options.allowFloatingRef,
    cloneMode: options.cloneMode,
    discardCheckouts: options.discardCheckouts,
    inferScope: options.inferScope,
    verifyEvidenceGraphs: options.verifyEvidenceGraphs,
    environment: environmentMetadata(options.corpusPath),
    subjects,
    summary: summarize(subjects),
  };
  writeJson(options.outPath, report);
  console.log(JSON.stringify(report.summary, null, 2));

  if (
    report.summary.failed > 0 ||
    report.summary.configurationErrors > 0 ||
    report.summary.toolErrors > 0 ||
    report.summary.unparseableOutputs > 0 ||
    report.summary.timeouts > 0 ||
    report.summary.evidenceGraphFailures > 0 ||
    report.summary.expectations.failed > 0
  ) return 1;
  return 0;
}

process.exitCode = main();
