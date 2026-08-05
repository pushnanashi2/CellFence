import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareNormalizedFindings,
  normalizeCellFenceFindings,
  normalizeCompetitorFindings,
  parseCompetitorOracleArgs,
  runCompetitorOracleConformance,
  unsafeAnalyzerCommandReason,
  validateCompetitorAnalyzers,
  validateCompetitorCorpus,
} from "../scripts/competitor-oracle-conformance.mjs";

const commit = "0123456789abcdef0123456789abcdef01234567";

function corpus(subject = {}) {
  return {
    schemaVersion: "cellfence.corpus.v1",
    subjects: [{
      id: "subject-one",
      repository: "https://example.invalid/never-fetched.git",
      commit,
      manifest: { strategy: "existing", path: "cellfence.manifest.json" },
      ...subject,
    }],
  };
}

function analyzers(entries) {
  return {
    schemaVersion: "cellfence.competitor-oracle-analyzers.v1",
    analyzers: entries,
  };
}

function commandResult(overrides = {}) {
  return {
    status: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    timeoutMs: 1000,
    durationMs: 2,
    ...overrides,
  };
}

function cleanInspection() {
  return {
    available: true,
    clean: true,
    commitMatches: true,
    head: commit,
    porcelain: "",
  };
}

test("competitor harness uses injected execution and reports descriptive finding buckets", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-competitor-injected-"));
  try {
    const checkoutDir = path.join(rootDir, "checkout");
    const subjectDir = path.join(rootDir, "subject");
    fs.mkdirSync(checkoutDir, { recursive: true });
    fs.mkdirSync(subjectDir, { recursive: true });
    const invocations = [];
    let inspections = 0;
    const runCommand = async (command, args, options) => {
      invocations.push({ command, args, options });
      if (command === "cellfence-bin") {
        return commandResult({
          status: 1,
          stdout: JSON.stringify({
            findings: [
              {
                ruleId: "CELLFENCE_PRIVATE_IMPORT",
                filePath: "src/a.ts",
                details: { targetPath: "src/b.ts", line: 4 },
                message: "private import",
              },
              {
                ruleId: "CELLFENCE_UNDECLARED_CONSUMER",
                filePath: "src/c.ts",
                details: { targetPath: "src/d.ts", line: 8 },
                message: "undeclared consumer",
              },
            ],
          }),
        });
      }
      if (command === "normalized-analyzer") {
        return commandResult({
          stdout: JSON.stringify({
            findings: [
              {
                category: "dependency_rule",
                ruleId: "same-edge",
                sourcePath: "src/a.ts",
                targetPath: "src/b.ts",
              },
              {
                category: "dependency_rule",
                ruleId: "competitor-edge",
                sourcePath: "src/x.ts",
                targetPath: "src/y.ts",
              },
              {
                category: "dependency_rule",
                ruleId: "aggregate-only",
                message: "no source location",
              },
            ],
          }),
        });
      }
      if (command === "missing-analyzer") {
        return commandResult({
          status: 1,
          error: "spawn missing-analyzer ENOENT",
          errorCode: "ENOENT",
        });
      }
      throw new Error(`unexpected injected command: ${command}`);
    };
    const result = await runCompetitorOracleConformance({
      corpus: corpus(),
      analyzers: analyzers([
        {
          id: "normalized",
          tool: "other",
          command: "normalized-analyzer",
          output: { format: "normalized-json", source: "stdout" },
        },
        { id: "missing", command: "missing-analyzer", output: "normalized-json" },
        { id: "not-applicable", comparable: false, reason: "no matching policy domain" },
        { id: "target-install", command: "npm", args: ["install"], requiresTargetInstall: true },
        { id: "unsafe-npm", command: "npm", args: ["run", "analyze"] },
        { id: "declared-missing", available: false, reason: "not provisioned" },
      ]),
      corpusDir: rootDir,
      workDir: path.join(rootDir, "work"),
      timeoutMs: 1000,
      cloneMode: "full",
    }, {
      prepareSubject: async () => ({
        checkoutDir,
        subjectDir,
        manifestPath: path.join(checkoutDir, "cellfence.manifest.json"),
        initialWorktree: cleanInspection(),
      }),
      inspectWorktree: async () => {
        inspections += 1;
        return cleanInspection();
      },
      runCommand,
      cellfenceInvocation: { command: "cellfence-bin", args: [] },
      now: () => new Date("2026-08-05T00:00:00.000Z"),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.report.schemaVersion, "cellfence.competitor-oracle-conformance.v1");
    assert.equal(result.report.generatedAt, "2026-08-05T00:00:00.000Z");
    assert.equal(result.report.interpretation.precisionClaimed, false);
    assert.equal(result.report.interpretation.adjudication, "none");
    assert.equal(result.report.safety.targetInstallScripts, "not_invoked_by_harness");
    assert.equal(result.report.safety.analyzerDescriptors, "trusted_preprovisioned_code");
    const byId = new Map(result.report.subjects[0].competitors.map((entry) => [entry.id, entry]));
    assert.equal(byId.get("normalized").execution.classification, "findings");
    assert.deepEqual(byId.get("normalized").comparison.counts, {
      comparable: 1,
      competitorOnly: 1,
      cellfenceOnly: 1,
      notComparable: 1,
    });
    assert.equal(byId.get("normalized").comparison.comparableFindings[0].comparisonKey, "dependency_rule|edge|src/a.ts|src/b.ts");
    assert.equal(byId.get("missing").execution.classification, "unavailable");
    assert.equal(byId.get("missing").comparison.status, "unavailable");
    assert.equal(byId.get("not-applicable").comparison.status, "not_comparable");
    assert.equal(byId.get("target-install").execution.classification, "not_comparable");
    assert.equal(byId.get("unsafe-npm").execution.classification, "not_comparable");
    assert.equal(byId.get("declared-missing").execution.classification, "unavailable");
    assert.equal(result.report.summary.findingComparisons.comparable, 1);
    assert.equal(result.report.summary.findingComparisons.competitorOnly, 1);
    assert.equal(result.report.summary.findingComparisons.cellfenceOnly, 1);
    assert.ok(inspections >= 7, "worktree should be inspected around every executed tool and at subject end");
    assert.ok(invocations.every((entry) => entry.options.shell === false));
    assert.deepEqual(invocations.map((entry) => entry.command), ["cellfence-bin", "normalized-analyzer", "missing-analyzer"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("competitor harness marks a tool error when post-run worktree inspection is dirty", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-competitor-dirty-"));
  try {
    const checkoutDir = path.join(rootDir, "checkout");
    const subjectDir = path.join(rootDir, "subject");
    fs.mkdirSync(checkoutDir, { recursive: true });
    fs.mkdirSync(subjectDir, { recursive: true });
    let inspection = 0;
    const dirty = {
      available: true,
      clean: false,
      commitMatches: true,
      head: commit,
      porcelain: "?? analyzer-cache/",
      reason: "subject worktree is dirty",
    };
    const result = await runCompetitorOracleConformance({
      corpus: corpus(),
      analyzers: analyzers([{
        id: "mutating",
        command: "mutating-analyzer",
        output: "normalized-json",
      }]),
      corpusDir: rootDir,
      workDir: path.join(rootDir, "work"),
      timeoutMs: 1000,
    }, {
      prepareSubject: async () => ({
        checkoutDir,
        subjectDir,
        manifestPath: path.join(checkoutDir, "cellfence.manifest.json"),
        initialWorktree: cleanInspection(),
      }),
      inspectWorktree: async () => {
        inspection += 1;
        return inspection >= 4 ? dirty : cleanInspection();
      },
      runCommand: async (command) => {
        if (command === "cellfence-bin") return commandResult({ stdout: JSON.stringify({ findings: [] }) });
        if (command === "mutating-analyzer") return commandResult({ stdout: JSON.stringify({ findings: [] }) });
        throw new Error(`unexpected command: ${command}`);
      },
      cellfenceInvocation: { command: "cellfence-bin", args: [] },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.report.subjects[0].status, "unsafe_worktree");
    const competitor = result.report.subjects[0].competitors[0];
    assert.equal(competitor.execution.classification, "tool_error");
    assert.equal(competitor.execution.safety.cleanBefore, true);
    assert.equal(competitor.execution.safety.cleanAfter, false);
    assert.equal(competitor.comparison.status, "unavailable");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("built-in adapters normalize dependency-cruiser, Import Linter, and Madge evidence", () => {
  const rootDir = path.resolve("/tmp/oracle-subject");
  const dependencyCruiser = normalizeCompetitorFindings({
    id: "dependency-cruiser",
    tool: "dependency-cruiser",
    output: "dependency-cruiser-json",
  }, JSON.stringify({
    summary: {
      violations: [{
        from: "src/a.ts",
        to: "src/b.ts",
        rule: { name: "not-to-private", severity: "error" },
      }],
    },
  }), rootDir);
  assert.equal(dependencyCruiser[0].category, "dependency_rule");
  assert.equal(dependencyCruiser[0].sourcePath, "src/a.ts");
  assert.equal(dependencyCruiser[0].targetPath, "src/b.ts");

  const importLinter = normalizeCompetitorFindings({
    id: "import-linter",
    tool: "import-linter",
    output: "import-linter-text",
  }, "package.one -> package.two (l. 17)\n", rootDir);
  assert.equal(importLinter[0].category, "dependency_rule");
  assert.equal(importLinter[0].line, 17);

  const madge = normalizeCompetitorFindings({
    id: "madge",
    tool: "madge",
    output: "madge-json",
  }, JSON.stringify([["src/a.ts", "src/b.ts", "src/a.ts"]]), rootDir);
  assert.equal(madge[0].category, "cycle");
  assert.deepEqual(madge[0].cyclePaths, ["src/a.ts", "src/b.ts", "src/a.ts"]);
});

test("comparison is one-to-one and leaves locationless observations unadjudicated", () => {
  const analyzer = { id: "oracle", tool: "other" };
  const rootDir = "/repo";
  const cellfence = normalizeCellFenceFindings([
    {
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      filePath: "src/a.ts",
      details: { targetPath: "src/b.ts" },
    },
    {
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      filePath: "src/a.ts",
      details: { targetPath: "src/b.ts" },
    },
  ], analyzer, rootDir);
  const competitor = normalizeCompetitorFindings({
    ...analyzer,
    output: "normalized-json",
  }, JSON.stringify({ findings: [
    { category: "dependency_rule", ruleId: "edge", sourcePath: "src/a.ts", targetPath: "src/b.ts" },
    { category: "dependency_rule", ruleId: "aggregate" },
  ] }), rootDir);
  const comparison = compareNormalizedFindings(cellfence, competitor);
  assert.equal(comparison.counts.comparable, 1);
  assert.equal(comparison.counts.cellfenceOnly, 1);
  assert.equal(comparison.counts.notComparable, 1);
});

test("validation rejects floating commits and unsafe command families", () => {
  assert.throws(() => validateCompetitorCorpus(corpus({ commit: "main" })), /exact 40-hex commit/);
  assert.throws(() => validateCompetitorAnalyzers(analyzers([
    { id: "bad-format", command: "tool", output: "xml" },
  ])), /unsupported output format/);
  assert.match(unsafeAnalyzerCommandReason("npm", ["install"]), /install packages/);
  assert.match(unsafeAnalyzerCommandReason("python3", ["-m", "pip", "install", "x"]), /not allowed|forbidden/);
  assert.match(unsafeAnalyzerCommandReason("sh", ["-c", "tool"]), /shell command/);
  assert.match(unsafeAnalyzerCommandReason("node", ["--eval=process.exit(0)"]), /inline Node/);
  assert.match(unsafeAnalyzerCommandReason("python3", ["-cprint('x')"]), /inline Python/);
  assert.match(unsafeAnalyzerCommandReason("busybox", ["sh", "-c", "tool"]), /busybox shell/);
  assert.equal(unsafeAnalyzerCommandReason("/opt/tools/depcruise", ["--output-type", "json"]), null);
  assert.throws(() => parseCompetitorOracleArgs(["--corpus", "corpus.json"]), /--analyzers is required/);
});
