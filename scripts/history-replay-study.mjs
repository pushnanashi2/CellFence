import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkDir = path.join(repoRoot, "tmp", "history-replay-study");
const defaultOutPath = path.join(repoRoot, "reports", "history-replay-study.json");
const cellfenceCli = path.join(repoRoot, "packages", "cli", "dist", "index.js");
const defaultManifestPath = "cellfence.manifest.json";
const commandTimeouts = {
  clone: 600_000,
  fetch: 180_000,
  checkout: 120_000,
  revParse: 60_000,
  manifest: 180_000,
  check: 300_000,
  baseline: 300_000,
};
const fixedCheckArguments = new Set([
  "--root",
  "--manifest",
  "--json",
  "--format",
  "--audit-log",
  "--summary-json",
  "--changed",
  "--base",
  "--head",
]);

class ReplayFailure extends Error {
  constructor(stage, failureKind, message, details = {}) {
    super(message);
    this.name = "ReplayFailure";
    this.stage = stage;
    this.failureKind = failureKind;
    Object.assign(this, details);
  }
}

function usage() {
  console.error(`Usage: node scripts/history-replay-study.mjs --corpus corpus.json [--workdir tmp/history] [--out reports/history.json] [--max-subjects n] [--dry-run] [--allow-floating-ref] [--clone-mode full|shallow] [--discard-checkouts] [--infer-scope all|production]

Runs a frozen history-replay CellFence pass.
The script clones each subject at exact before/after commits, prepares manifests,
runs CellFence checks at both commits, compares introduced finding fingerprints,
and writes a failure-inclusive report. It never installs target dependencies or
runs target repository package scripts.`);
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

function phaseCommit(subject, phase) {
  return subject[phase]?.commit || subject[`${phase}Commit`];
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

function writeCommandLogs(logDir, name, result) {
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, `${name}.stdout.log`), result.stdout);
  fs.writeFileSync(path.join(logDir, `${name}.stderr.log`), result.stderr);
}

function summarizeFailure(result) {
  return result.error || result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join("\n") || result.stdout.trim().split(/\r?\n/).filter(Boolean).slice(-3).join("\n") || `exit ${result.status}`;
}

function commandFailure(stage, result) {
  if (result.timedOut) {
    throw new ReplayFailure(stage, "timeout", `${stage} timed out after ${result.timeoutMs}ms`, {
      timeoutMs: result.timeoutMs,
      exitCode: result.status,
      durationMs: result.durationMs,
    });
  }
  throw new ReplayFailure(stage, "command_failed", summarizeFailure(result), {
    exitCode: result.status,
    durationMs: result.durationMs,
  });
}

function validateCheckArgs(subjectId, args, label = "check.args") {
  if (args === undefined) return;
  if (!Array.isArray(args)) throw new Error(`${subjectId} ${label} must be an array`);
  for (const argument of args) {
    if (typeof argument !== "string" || argument.length === 0) {
      throw new Error(`${subjectId} ${label} entries must be non-empty strings`);
    }
    const optionName = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
    if (fixedCheckArguments.has(optionName)) {
      throw new Error(`${subjectId} ${label} cannot override fixed CellFence check argument ${optionName}`);
    }
  }
}

function validateRelativeStringList(subjectId, values, label) {
  if (values === undefined) return;
  if (!Array.isArray(values)) throw new Error(`${subjectId} ${label} must be an array`);
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${subjectId} ${label} entries must be non-empty strings`);
    validateContainedRelativePath(value, `${subjectId} ${label}`);
  }
}

function validateTimeout(subjectId, timeoutMs, maximum, label) {
  if (timeoutMs === undefined) return;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximum) {
    throw new Error(`${subjectId} ${label} must be an integer from 1 to ${maximum}`);
  }
}

function validateManifestDefinition(subjectId, manifest, corpusDir, phaseLabel) {
  const strategy = manifest?.strategy || "existing";
  const manifestPath = manifest?.path || defaultManifestPath;
  if (!["existing", "copy", "infer"].includes(strategy)) throw new Error(`${subjectId} ${phaseLabel} manifest.strategy is unsupported: ${strategy}`);
  if (strategy === "infer" && manifestPath !== defaultManifestPath) {
    throw new Error(`${subjectId} ${phaseLabel} manifest.strategy=infer only supports ${defaultManifestPath}`);
  }
  validateContainedRelativePath(manifestPath, `${subjectId} ${phaseLabel} manifest.path`);
  if (manifest?.scope !== undefined) {
    if (strategy !== "infer") throw new Error(`${subjectId} ${phaseLabel} manifest.scope is only supported with manifest.strategy=infer`);
    if (!["all", "production"].includes(manifest.scope)) {
      throw new Error(`${subjectId} ${phaseLabel} manifest.scope must be all or production`);
    }
  }
  if (strategy === "copy") {
    if (!manifest.source) throw new Error(`${subjectId} ${phaseLabel} manifest.strategy=copy requires manifest.source`);
    const sourcePath = resolveWithin(corpusDir, manifest.source, `${subjectId} ${phaseLabel} manifest.source`);
    if (!fs.existsSync(sourcePath)) throw new Error(`${subjectId} ${phaseLabel} manifest.source not found: ${manifest.source}`);
    assertRealPathWithin(corpusDir, sourcePath, `${subjectId} ${phaseLabel} manifest.source`);
  }
  for (const fromPath of manifest?.from || []) {
    validateContainedRelativePath(fromPath, `${subjectId} ${phaseLabel} manifest.from`);
  }
}

function manifestForPhase(subject, phase) {
  return subject[phase]?.manifest || subject.manifest || { strategy: "existing" };
}

function validateCorpus(corpus, options, corpusDir) {
  if (corpus.schemaVersion !== "cellfence.history-replay.v1") {
    throw new Error("corpus schemaVersion must be cellfence.history-replay.v1");
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
    const beforeCommit = phaseCommit(subject, "before");
    const afterCommit = phaseCommit(subject, "after");
    if (!options.allowFloatingRef && !isExactCommit(beforeCommit)) {
      throw new Error(`${subject.id} requires exact 40-hex before commit; use --allow-floating-ref only for exploratory runs`);
    }
    if (!options.allowFloatingRef && !isExactCommit(afterCommit)) {
      throw new Error(`${subject.id} requires exact 40-hex after commit; use --allow-floating-ref only for exploratory runs`);
    }
    if (beforeCommit && afterCommit && beforeCommit === afterCommit) {
      throw new Error(`${subject.id} before and after commits must differ`);
    }
    validateManifestDefinition(subject.id, manifestForPhase(subject, "before"), corpusDir, "before");
    validateManifestDefinition(subject.id, manifestForPhase(subject, "after"), corpusDir, "after");
    validateCheckArgs(subject.id, subject.check?.args);
    validateTimeout(subject.id, subject.check?.timeoutMs, commandTimeouts.check, "check.timeoutMs");
    validateTimeout(subject.id, subject.baseline?.timeoutMs, commandTimeouts.baseline, "baseline.timeoutMs");
    validateRelativeStringList(subject.id, subject.baseline?.evidenceBefore, "baseline.evidenceBefore");
    validateRelativeStringList(subject.id, subject.baseline?.evidenceAfter, "baseline.evidenceAfter");
  }
}

function gitWorktreeStatus(checkoutDir, logDir, name) {
  const result = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: checkoutDir,
    timeoutMs: commandTimeouts.revParse,
  });
  writeCommandLogs(logDir, name, result);
  if (result.status !== 0) commandFailure("checkout", result);
  const porcelain = result.stdout.trim();
  return {
    clean: porcelain.length === 0,
    porcelain,
  };
}

function clonePhase(subject, phase, subjectDir, options) {
  const phaseDir = path.join(subjectDir, phase);
  const checkoutDir = path.join(phaseDir, "checkout");
  const logDir = path.join(phaseDir, "logs");
  fs.rmSync(checkoutDir, { recursive: true, force: true });
  fs.mkdirSync(phaseDir, { recursive: true });
  const cloneArgs = ["clone", "--quiet", "--no-tags"];
  if (options.cloneMode === "shallow") cloneArgs.push("--depth", "1", "--filter=blob:none");
  cloneArgs.push(subject.repository, checkoutDir);
  const clone = run("git", cloneArgs, { cwd: options.workDir, timeoutMs: commandTimeouts.clone });
  writeCommandLogs(logDir, "clone", clone);
  if (clone.status !== 0) commandFailure(`${phase}-clone`, clone);

  const requestedCommit = phaseCommit(subject, phase) || subject[phase]?.ref || "HEAD";
  let checkout = run("git", ["checkout", "--quiet", "--detach", requestedCommit], {
    cwd: checkoutDir,
    timeoutMs: commandTimeouts.checkout,
  });
  if (checkout.status !== 0 && options.cloneMode === "shallow" && isExactCommit(requestedCommit)) {
    const fetch = run("git", ["fetch", "--quiet", "--depth", "1", "origin", requestedCommit], {
      cwd: checkoutDir,
      timeoutMs: commandTimeouts.fetch,
    });
    writeCommandLogs(logDir, "fetch-requested-commit", fetch);
    if (fetch.status !== 0) commandFailure(`${phase}-fetch`, fetch);
    checkout = run("git", ["checkout", "--quiet", "--detach", requestedCommit], {
      cwd: checkoutDir,
      timeoutMs: commandTimeouts.checkout,
    });
  }
  writeCommandLogs(logDir, "checkout", checkout);
  if (checkout.status !== 0) commandFailure(`${phase}-checkout`, checkout);

  const revParse = run("git", ["rev-parse", "HEAD"], { cwd: checkoutDir, timeoutMs: commandTimeouts.revParse });
  writeCommandLogs(logDir, "rev-parse", revParse);
  if (revParse.status !== 0) commandFailure(`${phase}-rev-parse`, revParse);
  const actualCommit = revParse.stdout.trim();
  const expectedCommit = phaseCommit(subject, phase);
  if (expectedCommit && actualCommit !== expectedCommit) {
    throw new ReplayFailure(`${phase}-checkout`, "commit_mismatch", `checked out ${actualCommit}, expected ${expectedCommit}`);
  }
  const tree = run("git", ["rev-parse", "HEAD^{tree}"], { cwd: checkoutDir, timeoutMs: commandTimeouts.revParse });
  writeCommandLogs(logDir, "tree", tree);
  if (tree.status !== 0) commandFailure(`${phase}-rev-parse`, tree);
  return { phaseDir, checkoutDir, logDir, commit: actualCommit, gitTree: tree.stdout.trim() };
}

function ensureCommitAvailable(checkoutDir, commit, logDir, name) {
  const catFile = run("git", ["cat-file", "-e", `${commit}^{commit}`], {
    cwd: checkoutDir,
    timeoutMs: commandTimeouts.revParse,
  });
  writeCommandLogs(logDir, `${name}-cat-file`, catFile);
  if (catFile.status === 0) return true;
  const fetch = run("git", ["fetch", "--quiet", "--depth", "1", "origin", commit], {
    cwd: checkoutDir,
    timeoutMs: commandTimeouts.fetch,
  });
  writeCommandLogs(logDir, `${name}-fetch`, fetch);
  if (fetch.status !== 0) return false;
  const afterFetch = run("git", ["cat-file", "-e", `${commit}^{commit}`], {
    cwd: checkoutDir,
    timeoutMs: commandTimeouts.revParse,
  });
  writeCommandLogs(logDir, `${name}-cat-file-after-fetch`, afterFetch);
  return afterFetch.status === 0;
}

function isShallowRepository(checkoutDir, logDir) {
  const result = run("git", ["rev-parse", "--is-shallow-repository"], {
    cwd: checkoutDir,
    timeoutMs: commandTimeouts.revParse,
  });
  writeCommandLogs(logDir, "is-shallow-repository", result);
  return result.status === 0 && result.stdout.trim() === "true";
}

function phaseManifestPath(subject, phase) {
  return manifestForPhase(subject, phase)?.path || defaultManifestPath;
}

function prepareManifest(subject, phase, checkoutDir, corpusDir, phaseDir, options) {
  const manifest = manifestForPhase(subject, phase);
  const strategy = manifest?.strategy || "existing";
  const manifestPath = phaseManifestPath(subject, phase);
  const inferScope = manifest?.scope || options.inferScope;
  const startedAt = performance.now();
  let effectivePath;
  if (strategy === "existing") {
    const fullPath = resolveWithin(checkoutDir, manifestPath, `${phase} manifest.path`);
    if (!fs.existsSync(fullPath)) throw new Error(`manifest not found: ${manifestPath}`);
    assertRealPathWithin(checkoutDir, fullPath, `${phase} manifest.path`);
    effectivePath = manifestPath;
  } else if (strategy === "copy") {
    const sourcePath = resolveWithin(corpusDir, manifest.source, `${phase} manifest.source`);
    assertRealPathWithin(corpusDir, sourcePath, `${phase} manifest.source`);
    const controlDir = path.join(phaseDir, "control");
    const targetPath = resolveWithin(controlDir, manifestPath, `${phase} manifest.path`);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    effectivePath = targetPath;
  } else if (strategy === "infer") {
    if (manifestPath !== defaultManifestPath) {
      throw new Error(`manifest.strategy=infer only supports ${defaultManifestPath}`);
    }
    const controlDir = path.join(phaseDir, "control");
    const targetPath = resolveWithin(controlDir, manifestPath, `${phase} manifest.path`);
    const args = ["init", "--root", checkoutDir, "--output", targetPath, "--no-scaffold"];
    if (inferScope === "production") args.push("--production-scope");
    if (manifest?.preset) args.push("--preset", manifest.preset);
    for (const fromPath of manifest?.from || []) args.push("--from", fromPath);
    const result = run(process.execPath, [cellfenceCli, ...args], { cwd: checkoutDir, timeoutMs: commandTimeouts.manifest });
    writeCommandLogs(path.join(phaseDir, "logs"), "manifest", result);
    if (result.status !== 0) commandFailure(`${phase}-manifest`, result);
    effectivePath = targetPath;
  }
  const manifestFilePath = path.isAbsolute(effectivePath) ? effectivePath : path.resolve(checkoutDir, effectivePath);
  return {
    strategy,
    reviewed: manifest?.reviewed === true,
    ...(strategy === "infer" ? { scope: inferScope } : {}),
    path: manifestPath,
    effectivePath,
    sha256: hashFile(manifestFilePath),
    status: "completed",
    durationMs: Math.round(performance.now() - startedAt),
  };
}

function findingsByRule(findings) {
  const counts = {};
  for (const finding of findings || []) {
    counts[finding.ruleId] = (counts[finding.ruleId] || 0) + 1;
  }
  return counts;
}

function fallbackFindingFingerprint(finding) {
  return `sha256:${hashText(JSON.stringify({
    ruleId: finding.ruleId,
    severity: finding.severity,
    filePath: finding.filePath || null,
    details: finding.details || null,
    message: finding.message || null,
  }))}`;
}

function normalizedFindings(subjectId, phase, commit, manifestSha256, findings, changedFiles = new Set()) {
  const occurrences = new Map();
  return findings.map((finding) => {
    const fingerprint = finding.fingerprint || fallbackFindingFingerprint(finding);
    const nextOccurrence = (occurrences.get(fingerprint) || 0) + 1;
    occurrences.set(fingerprint, nextOccurrence);
    const comparisonKey = `${fingerprint}#${nextOccurrence}`;
    const filePath = finding.filePath || finding.path || null;
    return {
      findingId: `sha256:${hashText(`${subjectId}:${phase}:${commit}:${manifestSha256}:${comparisonKey}`)}`,
      phase,
      ruleId: finding.ruleId,
      severity: finding.severity,
      fingerprint,
      occurrence: nextOccurrence,
      comparisonKey,
      filePath,
      changedFile: filePath ? changedFiles.has(filePath) : false,
      message: finding.message,
      details: finding.details || {},
    };
  });
}

function runCheck(subject, phase, checkoutDir, phaseDir, manifestPath) {
  validateCheckArgs(subject.id, subject.check?.args);
  validateTimeout(subject.id, subject.check?.timeoutMs, commandTimeouts.check, "check.timeoutMs");
  const auditLogPath = path.join(phaseDir, "logs", "check.audit.jsonl");
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
  const result = run(process.execPath, args, { cwd: checkoutDir, timeoutMs: subject.check?.timeoutMs || commandTimeouts.check });
  writeCommandLogs(path.join(phaseDir, "logs"), "check", result);
  if (result.timedOut) {
    return {
      status: "timeout",
      exitCode: result.status,
      ok: false,
      findings: [],
      warnings: [],
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
      findings: [],
      warnings: [],
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
  return {
    status,
    exitCode: result.status,
    ok: parsed.ok === true,
    findingCount: findings.length,
    warningCount: warnings.length,
    findings,
    warnings,
    findingsByRule: findingsByRule(findings),
    auditLogPath,
    auditLogSha256: fs.existsSync(auditLogPath) ? hashFile(auditLogPath) : null,
    durationMs: result.durationMs,
  };
}

function parseCheckJson(result, auditLogPath) {
  if (result.timedOut) {
    return {
      status: "timeout",
      exitCode: result.status,
      ok: false,
      findings: [],
      warnings: [],
      findingsByRule: {},
      durationMs: result.durationMs,
      timeoutMs: result.timeoutMs,
      error: `CellFence baseline check timed out after ${result.timeoutMs}ms`,
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
      findings: [],
      warnings: [],
      findingsByRule: {},
      durationMs: result.durationMs,
      error: `failed to parse CellFence baseline JSON output: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  let status = "tool_error";
  if (result.status === 0) status = "checked_clean";
  else if (result.status === 1) status = "checked_findings";
  else if (result.status === 2) status = "configuration_error";
  return {
    status,
    exitCode: result.status,
    ok: parsed.ok === true,
    findingCount: findings.length,
    warningCount: warnings.length,
    findings,
    warnings,
    findingsByRule: findingsByRule(findings),
    auditLogPath,
    auditLogSha256: fs.existsSync(auditLogPath) ? hashFile(auditLogPath) : null,
    durationMs: result.durationMs,
  };
}

function runBaselineReplay(subject, beforePhase, afterPhase, subjectDir) {
  if (subject.baseline?.enabled !== true) return undefined;
  const baselineDir = path.join(subjectDir, "baseline");
  const baselinePath = path.join(baselineDir, "before.baseline.json");
  const logDir = path.join(baselineDir, "logs");
  const beforeEvidence = subject.baseline?.evidenceBefore || [];
  const afterEvidence = subject.baseline?.evidenceAfter || [];
  for (const evidencePath of beforeEvidence) {
    if (!fs.existsSync(resolveWithin(beforePhase.checkoutDir, evidencePath, "baseline.evidenceBefore"))) {
      return {
        enabled: true,
        status: "configuration_error",
        baselinePath,
        error: `baseline.evidenceBefore not found: ${evidencePath}`,
      };
    }
  }
  for (const evidencePath of afterEvidence) {
    if (!fs.existsSync(resolveWithin(afterPhase.checkoutDir, evidencePath, "baseline.evidenceAfter"))) {
      return {
        enabled: true,
        status: "configuration_error",
        baselinePath,
        error: `baseline.evidenceAfter not found: ${evidencePath}`,
      };
    }
  }
  const beforeEvidenceArgs = beforeEvidence.flatMap((evidencePath) => ["--evidence", evidencePath]);
  const afterEvidenceArgs = afterEvidence.flatMap((evidencePath) => ["--evidence", evidencePath]);
  fs.mkdirSync(logDir, { recursive: true });
  const createArgs = [
    cellfenceCli,
    "baseline",
    "create",
    "--root",
    beforePhase.checkoutDir,
    "--manifest",
    beforePhase.manifest.effectivePath,
    "--baseline",
    baselinePath,
    ...beforeEvidenceArgs,
  ];
  const create = run(process.execPath, createArgs, {
    cwd: beforePhase.checkoutDir,
    timeoutMs: subject.baseline?.timeoutMs || commandTimeouts.baseline,
  });
  writeCommandLogs(logDir, "baseline-create", create);
  if (create.status !== 0) {
    return {
      enabled: true,
      status: create.timedOut ? "timeout" : "create_failed",
      baselinePath,
      create: {
        exitCode: create.status,
        durationMs: create.durationMs,
        timeoutMs: create.timeoutMs,
        error: summarizeFailure(create),
      },
    };
  }
  const auditLogPath = path.join(logDir, "baseline-check.audit.jsonl");
  const checkArgs = [
    cellfenceCli,
    "baseline",
    "check",
    "--root",
    afterPhase.checkoutDir,
    "--manifest",
    afterPhase.manifest.effectivePath,
    "--baseline",
    baselinePath,
    "--json",
    "--audit-log",
    auditLogPath,
    ...afterEvidenceArgs,
  ];
  const checkResult = run(process.execPath, checkArgs, {
    cwd: afterPhase.checkoutDir,
    timeoutMs: subject.baseline?.timeoutMs || commandTimeouts.baseline,
  });
  writeCommandLogs(logDir, "baseline-check", checkResult);
  const check = parseCheckJson(checkResult, auditLogPath);
  return {
    enabled: true,
    status: check.status,
    baselinePath,
    baselineSha256: fs.existsSync(baselinePath) ? hashFile(baselinePath) : null,
    evidenceBefore: subject.baseline?.evidenceBefore || [],
    evidenceAfter: subject.baseline?.evidenceAfter || [],
    create: {
      exitCode: create.status,
      durationMs: create.durationMs,
    },
    check,
  };
}

function diffMetadata(afterCheckoutDir, beforeCommit, afterCommit, logDir) {
  if (!ensureCommitAvailable(afterCheckoutDir, beforeCommit, logDir, "diff-before-commit")) {
    return {
      status: "unavailable",
      changedFiles: [],
      changedFileCount: 0,
      nameStatus: [],
      shortStat: null,
      error: "before commit is unavailable in the after checkout",
    };
  }
  const nameOnly = run("git", ["diff", "--name-only", beforeCommit, afterCommit], {
    cwd: afterCheckoutDir,
    timeoutMs: commandTimeouts.revParse,
  });
  writeCommandLogs(logDir, "diff-name-only", nameOnly);
  const nameStatus = run("git", ["diff", "--name-status", beforeCommit, afterCommit], {
    cwd: afterCheckoutDir,
    timeoutMs: commandTimeouts.revParse,
  });
  writeCommandLogs(logDir, "diff-name-status", nameStatus);
  const stat = run("git", ["diff", "--shortstat", beforeCommit, afterCommit], {
    cwd: afterCheckoutDir,
    timeoutMs: commandTimeouts.revParse,
  });
  writeCommandLogs(logDir, "diff-shortstat", stat);
  const changedFiles = nameOnly.status === 0
    ? nameOnly.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  return {
    status: nameOnly.status === 0 && nameStatus.status === 0 && stat.status === 0 ? "completed" : "unavailable",
    changedFiles,
    changedFileCount: changedFiles.length,
    nameStatus: nameStatus.status === 0
      ? nameStatus.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      : [],
    shortStat: stat.status === 0 ? stat.stdout.trim() : null,
  };
}

function ancestryMetadata(afterCheckoutDir, beforeCommit, afterCommit, logDir) {
  if (!ensureCommitAvailable(afterCheckoutDir, beforeCommit, logDir, "ancestry-before-commit")) {
    return {
      status: "unavailable",
      beforeIsAncestorOfAfter: null,
      commitDistance: null,
      replayKind: "unknown_ancestry",
      error: "before commit is unavailable in the after checkout",
    };
  }
  const ancestor = run("git", ["merge-base", "--is-ancestor", beforeCommit, afterCommit], {
    cwd: afterCheckoutDir,
    timeoutMs: commandTimeouts.revParse,
  });
  writeCommandLogs(logDir, "ancestry", ancestor);
  if (ancestor.status === 0) {
    const distance = run("git", ["rev-list", "--count", `${beforeCommit}..${afterCommit}`], {
      cwd: afterCheckoutDir,
      timeoutMs: commandTimeouts.revParse,
    });
    writeCommandLogs(logDir, "ancestry-distance", distance);
    const count = distance.status === 0 ? Number(distance.stdout.trim()) : null;
    if (!Number.isInteger(count)) {
      return {
        status: "unavailable",
        beforeIsAncestorOfAfter: true,
        commitDistance: null,
        replayKind: "unknown_ancestry",
        error: "commit distance is unavailable",
      };
    }
    return {
      status: "completed",
      beforeIsAncestorOfAfter: true,
      commitDistance: count,
      replayKind: count === 1 ? "single_commit_intro" : "window_replay",
    };
  }
  if (ancestor.status === 1) {
    if (isShallowRepository(afterCheckoutDir, logDir)) {
      return {
        status: "unavailable",
        beforeIsAncestorOfAfter: null,
        commitDistance: null,
        replayKind: "unknown_ancestry",
        error: "ancestry is ambiguous across a shallow clone boundary; rerun with --clone-mode full for proof rows",
      };
    }
    return {
      status: "completed",
      beforeIsAncestorOfAfter: false,
      commitDistance: null,
      replayKind: "unrelated_commits",
    };
  }
  return {
    status: "unavailable",
    beforeIsAncestorOfAfter: null,
    commitDistance: null,
    replayKind: "unknown_ancestry",
    error: summarizeFailure(ancestor),
  };
}

function introducedFindings(subjectId, beforePhase, afterPhase, changedFiles) {
  const changedFileSet = new Set(changedFiles);
  const beforeFindings = normalizedFindings(
    subjectId,
    "before",
    beforePhase.commit,
    beforePhase.manifest.sha256,
    beforePhase.check.findings,
  );
  const afterFindings = normalizedFindings(
    subjectId,
    "after",
    afterPhase.commit,
    afterPhase.manifest.sha256,
    afterPhase.check.findings,
    changedFileSet,
  );
  const beforeKeys = new Set(beforeFindings.map((finding) => finding.comparisonKey));
  const introduced = afterFindings.filter((finding) => !beforeKeys.has(finding.comparisonKey));
  return {
    beforeFindings,
    afterFindings,
    introduced,
    introducedByRule: findingsByRule(introduced),
    introducedChangedFileCount: introduced.filter((finding) => finding.changedFile).length,
  };
}

function phaseStatusFailure(check) {
  if (check.status === "configuration_error") return "configuration_error";
  if (check.status === "tool_error") return "tool_error";
  if (check.status === "unparseable_output") return "unparseable_output";
  if (check.status === "timeout") return "timeout";
  return undefined;
}

function baselineFailureKind(baselineReplay) {
  if (!baselineReplay?.enabled) return undefined;
  if (baselineReplay.status === "create_failed") return "tool_error";
  if (baselineReplay.status === "timeout") return "timeout";
  if (baselineReplay.status === "configuration_error") return "configuration_error";
  if (baselineReplay.status === "tool_error") return "tool_error";
  if (baselineReplay.status === "unparseable_output") return "unparseable_output";
  return undefined;
}

function expectationResult(expected, replay) {
  if (!expected) return { status: "unlabeled", failures: [] };
  const failures = [];
  if (expected.beforeExitCode !== undefined && replay.before.check.exitCode !== expected.beforeExitCode) {
    failures.push(`expected beforeExitCode ${expected.beforeExitCode}, got ${replay.before.check.exitCode}`);
  }
  if (expected.afterExitCode !== undefined && replay.after.check.exitCode !== expected.afterExitCode) {
    failures.push(`expected afterExitCode ${expected.afterExitCode}, got ${replay.after.check.exitCode}`);
  }
  const introducedRuleCounts = replay.introducedFindingsByRule || {};
  for (const ruleId of expected.introducedRuleIds || []) {
    if (!introducedRuleCounts[ruleId]) failures.push(`expected introduced rule ${ruleId} to be present`);
  }
  for (const ruleId of expected.forbiddenIntroducedRuleIds || []) {
    if (introducedRuleCounts[ruleId]) failures.push(`expected introduced rule ${ruleId} to be absent`);
  }
  const baselineRuleCounts = replay.baselineReplay?.check?.findingsByRule || {};
  for (const ruleId of expected.baselineRuleIds || []) {
    if (!baselineRuleCounts[ruleId]) failures.push(`expected baseline rule ${ruleId} to be present`);
  }
  return { status: failures.length === 0 ? "passed" : "failed", failures };
}

function proofEligibility(subject, ancestry, manifestStrategy) {
  if (ancestry.beforeIsAncestorOfAfter === null) return "not_eligible_unknown_ancestry";
  if (!ancestry.beforeIsAncestorOfAfter) return "not_eligible_unrelated_commits";
  if (ancestry.replayKind !== "single_commit_intro") return "window_replay_requires_event_labels";
  if (manifestStrategy === "infer") return "onboarding_replay_only_inferred_manifest";
  const reviewed = subject.manifest?.reviewed === true || subject.before?.manifest?.reviewed === true || subject.after?.manifest?.reviewed === true;
  if (manifestStrategy === "copy" && !reviewed) return "copy_manifest_requires_review_record";
  return "counterfactual_candidate_requires_manual_label";
}

function discardCheckoutsIfRequested(subjectResult, subjectDir, options) {
  if (!options.discardCheckouts || options.dryRun) return subjectResult;
  fs.rmSync(path.join(subjectDir, "before", "checkout"), { recursive: true, force: true });
  fs.rmSync(path.join(subjectDir, "after", "checkout"), { recursive: true, force: true });
  return {
    ...subjectResult,
    checkoutsDiscarded: true,
  };
}

function runSubject(subject, corpusDir, options) {
  const subjectDir = subjectDirectory(options.workDir, subject.id);
  fs.rmSync(subjectDir, { recursive: true, force: true });
  fs.mkdirSync(subjectDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  const beforeCommit = phaseCommit(subject, "before");
  const afterCommit = phaseCommit(subject, "after");
  const base = {
    id: subject.id,
    repository: subject.repository,
    requestedBeforeCommit: beforeCommit || null,
    requestedAfterCommit: afterCommit || null,
    startedAt,
    subjectDir,
  };
  if (options.dryRun) {
    return {
      ...base,
      status: "planned",
      before: {
        requestedCommit: beforeCommit || null,
        manifest: {
          strategy: manifestForPhase(subject, "before")?.strategy || "existing",
          path: phaseManifestPath(subject, "before"),
        },
      },
      after: {
        requestedCommit: afterCommit || null,
        manifest: {
          strategy: manifestForPhase(subject, "after")?.strategy || "existing",
          path: phaseManifestPath(subject, "after"),
        },
      },
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAtMs),
    };
  }
  try {
    const before = clonePhase(subject, "before", subjectDir, options);
    const after = clonePhase(subject, "after", subjectDir, options);
    const ancestry = ancestryMetadata(after.checkoutDir, before.commit, after.commit, path.join(subjectDir, "logs"));
    const diff = diffMetadata(after.checkoutDir, before.commit, after.commit, path.join(subjectDir, "logs"));

    before.subjectWorktreeCleanBeforeManifest = gitWorktreeStatus(before.checkoutDir, before.logDir, "status-before-manifest").clean;
    after.subjectWorktreeCleanBeforeManifest = gitWorktreeStatus(after.checkoutDir, after.logDir, "status-before-manifest").clean;
    before.manifest = prepareManifest(subject, "before", before.checkoutDir, corpusDir, before.phaseDir, options);
    after.manifest = prepareManifest(subject, "after", after.checkoutDir, corpusDir, after.phaseDir, options);
    const beforeWorktreeBeforeCheck = gitWorktreeStatus(before.checkoutDir, before.logDir, "status-before-check");
    const afterWorktreeBeforeCheck = gitWorktreeStatus(after.checkoutDir, after.logDir, "status-before-check");
    if (!beforeWorktreeBeforeCheck.clean) {
      throw new ReplayFailure("before-manifest", "dirty_worktree", "before manifest preparation modified the subject checkout", {
        worktreeStatus: beforeWorktreeBeforeCheck.porcelain,
      });
    }
    if (!afterWorktreeBeforeCheck.clean) {
      throw new ReplayFailure("after-manifest", "dirty_worktree", "after manifest preparation modified the subject checkout", {
        worktreeStatus: afterWorktreeBeforeCheck.porcelain,
      });
    }
    before.subjectWorktreeCleanBeforeCheck = true;
    after.subjectWorktreeCleanBeforeCheck = true;
    before.check = runCheck(subject, "before", before.checkoutDir, before.phaseDir, before.manifest.effectivePath);
    after.check = runCheck(subject, "after", after.checkoutDir, after.phaseDir, after.manifest.effectivePath);
    const failedPhase = phaseStatusFailure(before.check) || phaseStatusFailure(after.check);
    const comparison = introducedFindings(subject.id, before, after, diff.changedFiles);
    const baselineReplay = runBaselineReplay(subject, before, after, subjectDir);
    const failedBaseline = baselineFailureKind(baselineReplay);
    const beforeWorktreeAfterReplay = gitWorktreeStatus(before.checkoutDir, before.logDir, "status-after-replay");
    const afterWorktreeAfterReplay = gitWorktreeStatus(after.checkoutDir, after.logDir, "status-after-replay");
    if (!beforeWorktreeAfterReplay.clean) {
      throw new ReplayFailure("before-check", "dirty_worktree", "CellFence replay modified the before checkout", {
        worktreeStatus: beforeWorktreeAfterReplay.porcelain,
      });
    }
    if (!afterWorktreeAfterReplay.clean) {
      throw new ReplayFailure("after-check", "dirty_worktree", "CellFence replay modified the after checkout", {
        worktreeStatus: afterWorktreeAfterReplay.porcelain,
      });
    }
    before.subjectWorktreeCleanAfterReplay = true;
    after.subjectWorktreeCleanAfterReplay = true;
    const manifestStrategies = [...new Set([before.manifest.strategy, after.manifest.strategy])].sort();
    const result = {
      ...base,
      status: failedPhase
        ? `${failedPhase}_failed`
        : failedBaseline ? `baseline_${failedBaseline}_failed`
        : comparison.introduced.length > 0 ? "replayed_introduced_findings" : "replayed_no_introduced_findings",
      replayKind: ancestry.replayKind,
      proofEligibility: proofEligibility(subject, ancestry, manifestStrategies.includes("infer") ? "infer" : manifestStrategies[0]),
      cloneMode: options.cloneMode,
      ancestry,
      diff,
      before: {
        commit: before.commit,
        gitTree: before.gitTree,
        checkoutDir: before.checkoutDir,
        subjectWorktreeCleanBeforeManifest: before.subjectWorktreeCleanBeforeManifest,
        subjectWorktreeCleanBeforeCheck: before.subjectWorktreeCleanBeforeCheck,
        subjectWorktreeCleanAfterReplay: before.subjectWorktreeCleanAfterReplay,
        manifest: before.manifest,
        check: before.check,
      },
      after: {
        commit: after.commit,
        gitTree: after.gitTree,
        checkoutDir: after.checkoutDir,
        subjectWorktreeCleanBeforeManifest: after.subjectWorktreeCleanBeforeManifest,
        subjectWorktreeCleanBeforeCheck: after.subjectWorktreeCleanBeforeCheck,
        subjectWorktreeCleanAfterReplay: after.subjectWorktreeCleanAfterReplay,
        manifest: after.manifest,
        check: after.check,
      },
      introducedFindings: comparison.introduced,
      introducedFindingCount: comparison.introduced.length,
      introducedFindingsByRule: comparison.introducedByRule,
      introducedChangedFileCount: comparison.introducedChangedFileCount,
      baselineReplay,
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAtMs),
    };
    result.expectation = expectationResult(subject.expected, result);
    return discardCheckoutsIfRequested(result, subjectDir, options);
  } catch (error) {
    const result = {
      ...base,
      status: error instanceof ReplayFailure ? `${error.stage}_failed` : "failed",
      stage: error instanceof ReplayFailure ? error.stage : undefined,
      failureKind: error instanceof ReplayFailure ? error.failureKind : "error",
      timeoutMs: error instanceof ReplayFailure ? error.timeoutMs : undefined,
      exitCode: error instanceof ReplayFailure ? error.exitCode : undefined,
      worktreeStatus: error instanceof ReplayFailure ? error.worktreeStatus : undefined,
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAtMs),
    };
    return discardCheckoutsIfRequested(result, subjectDir, options);
  }
}

function phaseFailed(subject, phase) {
  const check = subject[phase]?.check;
  if (!check) return false;
  return ["configuration_error", "tool_error", "unparseable_output", "timeout"].includes(check.status);
}

function summarize(subjects) {
  const summary = {
    total: subjects.length,
    planned: 0,
    replayed: 0,
    failed: 0,
    singleCommitIntroductions: 0,
    windowReplays: 0,
    unrelatedReplays: 0,
    subjectsWithIntroducedFindings: 0,
    totalBeforeFindings: 0,
    totalAfterFindings: 0,
    totalIntroducedFindings: 0,
    introducedFindingsByRule: {},
    baselineReplays: 0,
    baselineFailures: 0,
    baselineChecksWithFindings: 0,
    baselineFindingsByRule: {},
    configurationErrors: 0,
    toolErrors: 0,
    unparseableOutputs: 0,
    timeouts: 0,
    expectations: {
      labeled: 0,
      passed: 0,
      failed: 0,
      unlabeled: 0,
    },
  };
  for (const subject of subjects) {
    if (subject.status === "planned") summary.planned += 1;
    else if (subject.status === "replayed_introduced_findings" || subject.status === "replayed_no_introduced_findings") summary.replayed += 1;
    else summary.failed += 1;
    if (subject.replayKind === "single_commit_intro") summary.singleCommitIntroductions += 1;
    if (subject.replayKind === "window_replay") summary.windowReplays += 1;
    if (subject.replayKind === "unrelated_commits") summary.unrelatedReplays += 1;
    if (subject.failureKind === "timeout" || phaseFailed(subject, "before") && subject.before.check.status === "timeout" || phaseFailed(subject, "after") && subject.after.check.status === "timeout") summary.timeouts += 1;
    if (phaseFailed(subject, "before") || phaseFailed(subject, "after")) {
      for (const phase of ["before", "after"]) {
        const status = subject[phase]?.check?.status;
        if (status === "configuration_error") summary.configurationErrors += 1;
        if (status === "tool_error") summary.toolErrors += 1;
        if (status === "unparseable_output") summary.unparseableOutputs += 1;
      }
    }
    summary.totalBeforeFindings += Number(subject.before?.check?.findingCount || 0);
    summary.totalAfterFindings += Number(subject.after?.check?.findingCount || 0);
    summary.totalIntroducedFindings += Number(subject.introducedFindingCount || 0);
    if (subject.introducedFindingCount > 0) summary.subjectsWithIntroducedFindings += 1;
    for (const [ruleId, count] of Object.entries(subject.introducedFindingsByRule || {})) {
      summary.introducedFindingsByRule[ruleId] = (summary.introducedFindingsByRule[ruleId] || 0) + count;
    }
    if (subject.baselineReplay?.enabled) {
      summary.baselineReplays += 1;
      const baselineFailure = baselineFailureKind(subject.baselineReplay);
      if (baselineFailure) {
        summary.baselineFailures += 1;
        if (baselineFailure === "configuration_error") summary.configurationErrors += 1;
        if (baselineFailure === "tool_error") summary.toolErrors += 1;
        if (baselineFailure === "unparseable_output") summary.unparseableOutputs += 1;
        if (baselineFailure === "timeout") summary.timeouts += 1;
      }
      const baselineFindingCount = subject.baselineReplay.check?.findingCount || 0;
      if (baselineFindingCount > 0) summary.baselineChecksWithFindings += 1;
      for (const [ruleId, count] of Object.entries(subject.baselineReplay.check?.findingsByRule || {})) {
        summary.baselineFindingsByRule[ruleId] = (summary.baselineFindingsByRule[ruleId] || 0) + count;
      }
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

function readTextIfOk(command, args) {
  const result = run(command, args, { cwd: repoRoot, timeoutMs: 30_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function evidenceSetForHash(report) {
  return {
    schemaVersion: report.schemaVersion,
    corpusPath: report.corpusPath,
    dryRun: report.dryRun,
    allowFloatingRef: report.allowFloatingRef,
    cloneMode: report.cloneMode,
    discardCheckouts: report.discardCheckouts,
    inferScope: report.inferScope,
    environment: {
      cellfenceVersion: report.environment.cellfenceVersion,
      cellfenceSourceCommit: report.environment.cellfenceSourceCommit,
      cellfenceCliSha256: report.environment.cellfenceCliSha256,
      corpusSha256: report.environment.corpusSha256,
      nodeVersion: report.environment.nodeVersion,
      gitVersion: report.environment.gitVersion,
      platform: report.environment.platform,
      arch: report.environment.arch,
    },
    subjects: report.subjects.map((subject) => ({
      id: subject.id,
      repository: subject.repository,
      status: subject.status,
      replayKind: subject.replayKind,
      proofEligibility: subject.proofEligibility,
      before: {
        commit: subject.before?.commit,
        gitTree: subject.before?.gitTree,
        manifestSha256: subject.before?.manifest?.sha256,
        manifestStrategy: subject.before?.manifest?.strategy,
        manifestReviewed: subject.before?.manifest?.reviewed,
        checkStatus: subject.before?.check?.status,
        checkExitCode: subject.before?.check?.exitCode,
        auditLogSha256: subject.before?.check?.auditLogSha256,
      },
      after: {
        commit: subject.after?.commit,
        gitTree: subject.after?.gitTree,
        manifestSha256: subject.after?.manifest?.sha256,
        manifestStrategy: subject.after?.manifest?.strategy,
        manifestReviewed: subject.after?.manifest?.reviewed,
        checkStatus: subject.after?.check?.status,
        checkExitCode: subject.after?.check?.exitCode,
        auditLogSha256: subject.after?.check?.auditLogSha256,
      },
      ancestry: subject.ancestry,
      diff: {
        changedFiles: subject.diff?.changedFiles,
        nameStatus: subject.diff?.nameStatus,
        shortStat: subject.diff?.shortStat,
      },
      introducedFindings: (subject.introducedFindings || []).map((finding) => ({
        findingId: finding.findingId,
        ruleId: finding.ruleId,
        fingerprint: finding.fingerprint,
        occurrence: finding.occurrence,
        filePath: finding.filePath,
        changedFile: finding.changedFile,
      })),
      baselineReplay: subject.baselineReplay ? {
        status: subject.baselineReplay.status,
        baselineSha256: subject.baselineReplay.baselineSha256,
        createExitCode: subject.baselineReplay.create?.exitCode,
        checkStatus: subject.baselineReplay.check?.status,
        checkExitCode: subject.baselineReplay.check?.exitCode,
        auditLogSha256: subject.baselineReplay.check?.auditLogSha256,
      } : undefined,
    })),
    summary: report.summary,
  };
}

function evidenceSetSha256(report) {
  return hashText(JSON.stringify(canonicalize(evidenceSetForHash(report))));
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
    console.error("CellFence CLI dist is missing; run npm run build before the history replay study");
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
    schemaVersion: "cellfence.history-replay-study.v1",
    generatedAt: new Date().toISOString(),
    corpusPath: options.corpusPath,
    dryRun: options.dryRun,
    allowFloatingRef: options.allowFloatingRef,
    cloneMode: options.cloneMode,
    discardCheckouts: options.discardCheckouts,
    inferScope: options.inferScope,
    environment: environmentMetadata(options.corpusPath),
    subjects,
    summary: summarize(subjects),
  };
  report.evidenceSetSha256 = evidenceSetSha256(report);
  writeJson(options.outPath, report);
  console.log(JSON.stringify(report.summary, null, 2));

  if (
    report.summary.failed > 0 ||
    report.summary.configurationErrors > 0 ||
    report.summary.toolErrors > 0 ||
    report.summary.unparseableOutputs > 0 ||
    report.summary.timeouts > 0 ||
    report.summary.baselineFailures > 0 ||
    report.summary.expectations.failed > 0
  ) return 1;
  return 0;
}

process.exitCode = main();
