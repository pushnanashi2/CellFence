import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.resolve(root, process.env.CELLFENCE_CI_COUNTS_DIR || "tmp/ci-counts");
fs.mkdirSync(outDir, { recursive: true });

function run(name, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    maxBuffer: 100 * 1024 * 1024,
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  fs.writeFileSync(path.join(outDir, `${name}.stdout.log`), stdout);
  fs.writeFileSync(path.join(outDir, `${name}.stderr.log`), stderr);
  return {
    name,
    status: result.status ?? 1,
    stdout,
    stderr,
    error: result.error ? String(result.error.message || result.error) : undefined,
  };
}

function countTypeScriptErrors(output) {
  return (output.match(/\berror TS\d+:/g) || []).length;
}

function countTapFailures(output) {
  const fail = /# fail (\d+)/.exec(output);
  const cancelled = /# cancelled (\d+)/.exec(output);
  return Number(fail?.[1] || 0) + Number(cancelled?.[1] || 0);
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function testFiles() {
  const testsDir = path.join(root, "tests");
  if (!fs.existsSync(testsDir)) return [];
  return fs.readdirSync(testsDir)
    .filter((entry) => entry.endsWith(".test.mjs"))
    .sort()
    .map((entry) => `tests/${entry}`);
}

function coverageDeficits(summaryPath) {
  const summary = readJsonIfPresent(summaryPath);
  const total = summary?.total;
  if (!total) return { lines: null, statements: null, branches: null, functions: null, total: null };
  const deficits = {
    lines: total.lines.total - total.lines.covered,
    statements: total.statements.total - total.statements.covered,
    branches: total.branches.total - total.branches.covered,
    functions: total.functions.total - total.functions.covered,
  };
  return { ...deficits, total: deficits.lines + deficits.statements + deficits.branches + deficits.functions };
}

function countLineFindings(output) {
  return output.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

const results = {};
const allTestFiles = testFiles();

const lint = run("lint", "npx", ["eslint", ".", "-f", "json"]);
const lintJson = readJsonIfPresent(path.join(outDir, "lint.stdout.log")) || [];
results.lint = {
  exitCode: lint.status,
  errors: Array.isArray(lintJson) ? lintJson.reduce((total, file) => total + Number(file.errorCount || 0), 0) : null,
  warnings: Array.isArray(lintJson) ? lintJson.reduce((total, file) => total + Number(file.warningCount || 0), 0) : null,
};

const typecheck = run("typecheck", "npm", ["run", "typecheck"]);
results.typecheck = {
  exitCode: typecheck.status,
  errors: countTypeScriptErrors(`${typecheck.stdout}\n${typecheck.stderr}`),
};

const build = run("build", "npm", ["run", "build"]);
results.build = {
  exitCode: build.status,
  errors: countTypeScriptErrors(`${build.stdout}\n${build.stderr}`),
};

const test = run("test", "node", ["--test", "--test-reporter=tap", ...allTestFiles]);
results.test = {
  exitCode: test.status,
  failures: countTapFailures(`${test.stdout}\n${test.stderr}`),
};

const coverageDir = path.join(outDir, "coverage");
const coverage = run("coverage100", "npx", [
  "c8",
  "--check-coverage",
  "--lines",
  "100",
  "--statements",
  "100",
  "--branches",
  "100",
  "--functions",
  "100",
  "--reporter=json-summary",
  "--reports-dir",
  coverageDir,
  "node",
  "--test",
  ...allTestFiles,
]);
results.coverage = {
  exitCode: coverage.status,
  uncovered: coverageDeficits(path.join(coverageDir, "coverage-summary.json")),
};

const selfCheckJson = path.join(outDir, "cellfence-summary.json");
const selfCheck = run("cellfence-self-check", "node", [
  "packages/cli/dist/index.js",
  "baseline",
  "check",
  "--manifest",
  "cellfence.manifest.json",
  "--baseline",
  "cellfence.baseline.json",
  "--json",
  "--summary-json",
  selfCheckJson,
]);
const selfCheckSummary = readJsonIfPresent(selfCheckJson);
const selfCheckResult = readJsonIfPresent(path.join(outDir, "cellfence-self-check.stdout.log"));
results.cellfence = {
  exitCode: selfCheck.status,
  findings: selfCheckSummary?.counts?.findings ?? selfCheckResult?.findings?.length ?? null,
  warnings: selfCheckSummary?.counts?.warnings ?? selfCheckResult?.warnings?.length ?? null,
  findingsByRule: selfCheckSummary?.findingsByRule || {},
  warningsByRule: selfCheckSummary?.warningsByRule || {},
};

const provenance = run("provenance", "node", ["scripts/forbidden-source-scan.mjs"]);
results.provenance = {
  exitCode: provenance.status,
  findings: provenance.status === 0 ? 0 : countLineFindings(provenance.stderr || provenance.stdout),
};

const release = run("release-verify", "node", ["scripts/release-verify.mjs"]);
results.release = {
  exitCode: release.status,
  findings: release.status === 0 ? 0 : countLineFindings(release.stderr || release.stdout),
};

const pack = run("pack-smoke", "node", ["scripts/pack-smoke.mjs"]);
results.packSmoke = {
  exitCode: pack.status,
  findings: pack.status === 0 ? 0 : 1,
};

const summary = {
  schemaVersion: "cellfence.ci-counts.v1",
  generatedAt: new Date().toISOString(),
  results,
};

fs.writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
