import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkDir = path.join(repoRoot, "tmp", "corpus-precision-study");
const defaultOutPath = path.join(repoRoot, "reports", "corpus-precision-study.json");
const cellfenceCli = path.join(repoRoot, "packages", "cli", "dist", "index.js");

function usage() {
  console.error(`Usage: node scripts/corpus-precision-study.mjs --corpus corpus.json [--workdir tmp/corpus] [--out reports/corpus.json] [--max-subjects n] [--dry-run] [--allow-floating-ref]

Runs a frozen-corpus CellFence precision/onboarding pass.
The script clones each subject at an exact commit, prepares a manifest, runs
cellfence check --json, and writes a failure-inclusive report. It never runs
package install scripts in the target repositories.`);
}

function parseArgs(argv) {
  const parsed = {
    corpusPath: "",
    workDir: defaultWorkDir,
    outPath: defaultOutPath,
    dryRun: false,
    allowFloatingRef: false,
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
  return parsed;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "subject";
}

function isExactCommit(value) {
  return /^[a-f0-9]{40}$/i.test(String(value || ""));
}

function run(command, args, options) {
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    maxBuffer: 100 * 1024 * 1024,
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? String(result.error.message || result.error) : undefined,
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

function validateCorpus(corpus, options) {
  if (corpus.schemaVersion !== "cellfence.corpus.v1") {
    throw new Error("corpus schemaVersion must be cellfence.corpus.v1");
  }
  if (!Array.isArray(corpus.subjects) || corpus.subjects.length === 0) {
    throw new Error("corpus must contain at least one subject");
  }
  const ids = new Set();
  for (const subject of corpus.subjects) {
    if (!subject || typeof subject !== "object") throw new Error("each subject must be an object");
    if (!subject.id) throw new Error("each subject requires id");
    if (ids.has(subject.id)) throw new Error(`duplicate subject id: ${subject.id}`);
    ids.add(subject.id);
    if (!subject.repository) throw new Error(`${subject.id} requires repository`);
    if (!options.allowFloatingRef && !isExactCommit(subject.commit)) {
      throw new Error(`${subject.id} requires exact 40-hex commit; use --allow-floating-ref only for exploratory runs`);
    }
    if (subject.manifest?.strategy === "copy" && !subject.manifest.source) {
      throw new Error(`${subject.id} manifest.strategy=copy requires manifest.source`);
    }
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

function resolveManifestSource(corpusDir, sourcePath) {
  return path.isAbsolute(sourcePath) ? sourcePath : path.resolve(corpusDir, sourcePath);
}

function prepareManifest(subject, checkoutDir, corpusDir, subjectDir) {
  const strategy = subject.manifest?.strategy || "existing";
  const manifestPath = subject.manifest?.path || "cellfence.manifest.json";
  const startedAt = performance.now();
  if (strategy === "existing") {
    const fullPath = path.resolve(checkoutDir, manifestPath);
    if (!fs.existsSync(fullPath)) throw new Error(`manifest not found: ${manifestPath}`);
  } else if (strategy === "copy") {
    const sourcePath = resolveManifestSource(corpusDir, subject.manifest.source);
    const targetPath = path.resolve(checkoutDir, manifestPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  } else if (strategy === "infer") {
    const args = ["init", "--root", checkoutDir];
    if (subject.manifest?.preset) args.push("--preset", subject.manifest.preset);
    for (const fromPath of subject.manifest?.from || []) args.push("--from", fromPath);
    const result = run(process.execPath, [cellfenceCli, ...args], { cwd: checkoutDir });
    writeCommandLogs(subjectDir, "manifest", result);
    if (result.status !== 0) throw new Error(summarizeFailure(result));
  } else {
    throw new Error(`unsupported manifest strategy: ${strategy}`);
  }
  return {
    strategy,
    path: manifestPath,
    status: "completed",
    durationMs: Math.round(performance.now() - startedAt),
  };
}

function cloneSubject(subject, subjectDir, options) {
  const checkoutDir = path.join(subjectDir, "checkout");
  fs.rmSync(checkoutDir, { recursive: true, force: true });
  const clone = run("git", ["clone", "--quiet", "--no-tags", subject.repository, checkoutDir], { cwd: options.workDir });
  writeCommandLogs(subjectDir, "clone", clone);
  if (clone.status !== 0) throw new Error(summarizeFailure(clone));

  const checkoutTarget = subject.commit || subject.ref || "HEAD";
  const checkout = run("git", ["checkout", "--quiet", "--detach", checkoutTarget], { cwd: checkoutDir });
  writeCommandLogs(subjectDir, "checkout", checkout);
  if (checkout.status !== 0) throw new Error(summarizeFailure(checkout));

  const revParse = run("git", ["rev-parse", "HEAD"], { cwd: checkoutDir });
  writeCommandLogs(subjectDir, "rev-parse", revParse);
  if (revParse.status !== 0) throw new Error(summarizeFailure(revParse));
  const actualCommit = revParse.stdout.trim();
  if (subject.commit && actualCommit !== subject.commit) {
    throw new Error(`checked out ${actualCommit}, expected ${subject.commit}`);
  }
  return { checkoutDir, actualCommit };
}

function runCheck(subject, checkoutDir, subjectDir, manifestPath) {
  const args = [
    cellfenceCli,
    "check",
    "--root",
    checkoutDir,
    "--manifest",
    manifestPath,
    "--json",
    ...(subject.check?.args || []),
  ];
  const result = run(process.execPath, args, { cwd: checkoutDir });
  writeCommandLogs(subjectDir, "check", result);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return {
      status: "unparseable",
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
  return {
    status: "completed",
    exitCode: result.status,
    ok: parsed.ok === true,
    findings: findings.length,
    warnings: warnings.length,
    findingsByRule: findingsByRule(findings),
    durationMs: result.durationMs,
  };
}

function summarize(subjects) {
  const summary = {
    total: subjects.length,
    completed: 0,
    planned: 0,
    failed: 0,
    checksRun: 0,
    checkPassed: 0,
    checkFailed: 0,
    configurationErrors: 0,
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
    if (subject.status === "completed") summary.completed += 1;
    else if (subject.status === "planned") summary.planned += 1;
    else summary.failed += 1;
    if (subject.check) {
      summary.checksRun += 1;
      if (subject.check.exitCode === 0) summary.checkPassed += 1;
      else if (subject.check.exitCode === 1) summary.checkFailed += 1;
      else summary.configurationErrors += 1;
      summary.totalFindings += Number(subject.check.findings || 0);
      for (const [ruleId, count] of Object.entries(subject.check.findingsByRule || {})) {
        summary.findingsByRule[ruleId] = (summary.findingsByRule[ruleId] || 0) + count;
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

function runSubject(subject, corpusDir, options) {
  const subjectDir = path.join(options.workDir, safeName(subject.id));
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
    return {
      ...base,
      status: "planned",
      manifest: {
        strategy: subject.manifest?.strategy || "existing",
        path: subject.manifest?.path || "cellfence.manifest.json",
      },
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAtMs),
    };
  }
  try {
    const clone = cloneSubject(subject, subjectDir, options);
    const manifest = prepareManifest(subject, clone.checkoutDir, corpusDir, subjectDir);
    const check = runCheck(subject, clone.checkoutDir, subjectDir, manifest.path);
    const expectation = expectationResult(subject.expected, check);
    return {
      ...base,
      status: check.status === "completed" ? "completed" : "failed",
      commit: clone.actualCommit,
      manifest,
      check,
      expectation,
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAtMs),
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAtMs),
    };
  }
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
  try {
    corpus = readJson(options.corpusPath);
    validateCorpus(corpus, options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const corpusDir = path.dirname(options.corpusPath);
  fs.mkdirSync(options.workDir, { recursive: true });
  const subjects = corpus.subjects.slice(0, options.maxSubjects || corpus.subjects.length)
    .map((subject) => runSubject(subject, corpusDir, options));

  const report = {
    schemaVersion: "cellfence.corpus-study.v1",
    generatedAt: new Date().toISOString(),
    corpusPath: options.corpusPath,
    dryRun: options.dryRun,
    allowFloatingRef: options.allowFloatingRef,
    subjects,
    summary: summarize(subjects),
  };
  writeJson(options.outPath, report);
  console.log(JSON.stringify(report.summary, null, 2));

  if (report.summary.failed > 0 || report.summary.expectations.failed > 0) return 1;
  return 0;
}

process.exitCode = main();
