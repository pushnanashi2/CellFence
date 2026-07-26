import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(".");
const scriptPath = path.join(repoRoot, "scripts", "precision-next-cycle.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function createFixture(rootDir, options = {}) {
  const ruleId = options.ruleId || "CELLFENCE_PRIVATE_IMPORT";
  const ruleSlug = ruleId.toLowerCase().replace(/^cellfence_/, "").replace(/_/g, "-");
  const subjectDir = path.join(rootDir, "subjects", "next-cycle-demo");
  const manifestPath = path.join(subjectDir, "control", "cellfence.manifest.json");
  const reviewedManifestSourcePath = path.join(rootDir, "manifests", "next-cycle-demo.cellfence.manifest.json");
  const auditLogPath = path.join(subjectDir, "logs", "check.audit.jsonl");
  const corpusPath = path.join(rootDir, "corpus.json");
  const reportPath = path.join(rootDir, "corpus-report.json");
  const manifest = {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
      requiredRules: [ruleId],
    },
    cells: [
      {
        id: "app",
        ownedPaths: ["src/app/**"],
        publicEntry: "src/app/public.ts",
        publicSymbols: ["app"],
        consumes: [],
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
  };
  writeJson(manifestPath, manifest);
  writeJson(reviewedManifestSourcePath, manifest);
  writeJsonl(auditLogPath, [
    {
      schemaVersion: "cellfence.audit-event.v1",
      runId: "precision-next-cycle-test",
      timestamp: "2026-07-25T00:00:00.000Z",
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      event: "finding.detected",
      command: "check",
      ruleId,
      severity: "error",
      cellId: "app",
      producerCellId: "core",
      filePath: ruleId === "CELLFENCE_PUBLIC_SYMBOL_MISMATCH" ? "src/app/public.ts" : "src/app/leak.ts",
      line: 1,
      message: ruleId === "CELLFENCE_PUBLIC_SYMBOL_MISMATCH" ? "public symbol mismatch" : "private import",
      fingerprint: `precision-next-cycle-${ruleSlug}`,
      outcome: "rejected",
    },
  ]);
  writeJson(corpusPath, {
    schemaVersion: "cellfence.corpus.v1",
    selectionPolicy: {
      frozenAt: "2026-07-25T00:00:00.000Z",
      method: "local precision-next-cycle test fixture",
    },
    subjects: [
      {
        id: "next-cycle-demo",
        repository: "https://github.com/example/next-cycle-demo.git",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        manifest: {
          strategy: "copy",
          source: "manifests/next-cycle-demo.cellfence.manifest.json",
          reviewStatus: "reviewed",
          review: {
            reviewers: ["fixture-reviewer"],
            boundaryEvidence: ["fixture manifest derived from declared test boundaries"],
          },
        },
      },
    ],
  });
  writeJson(reportPath, {
    schemaVersion: "cellfence.corpus-study.v1",
    generatedAt: "2026-07-25T00:00:01.000Z",
    corpusPath,
    dryRun: false,
    allowFloatingRef: false,
    environment: {
      harnessCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      harnessDirty: false,
      cellfenceVersion: "0.1.14",
      corpusSha256: hashFile(corpusPath),
    },
    subjects: [
      {
        id: "next-cycle-demo",
        repository: "https://github.com/example/next-cycle-demo.git",
        requestedCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        requestedRef: null,
        status: "checked_findings",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        gitTree: "cccccccccccccccccccccccccccccccccccccccc",
        subjectDir,
        manifest: {
          strategy: "copy",
          reviewStatus: "reviewed",
          path: "cellfence.manifest.json",
          effectivePath: manifestPath,
          sha256: hashFile(manifestPath),
          status: "completed",
        },
        check: {
          status: "checked_findings",
          exitCode: 1,
          ok: false,
          findings: 1,
          warnings: 0,
          auditLogPath,
          auditLogSha256: hashFile(auditLogPath),
        },
      },
    ],
    summary: {
      total: 1,
      completed: 1,
      failed: 0,
      totalFindings: 1,
    },
  });
  return { corpusPath, reportPath };
}

function createRepositoryCapFixture(rootDir) {
  const corpusPath = path.join(rootDir, "corpus-cap.json");
  const reportPath = path.join(rootDir, "corpus-cap-report.json");
  const subjects = [];
  const reportSubjects = [];
  const manifest = {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
      requiredRules: ["CELLFENCE_PRIVATE_IMPORT"],
    },
    cells: [
      {
        id: "app",
        ownedPaths: ["src/app/**"],
        publicEntry: "src/app/public.ts",
        publicSymbols: ["app"],
        consumes: [],
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
  };
  const entries = [
    { id: "cap-a", repository: "https://github.com/example/cap-a.git", findings: 20, commit: "a".repeat(40) },
    { id: "cap-b", repository: "https://github.com/example/cap-b.git", findings: 3, commit: "b".repeat(40) },
  ];
  for (const entry of entries) {
    const subjectDir = path.join(rootDir, "subjects", entry.id);
    const manifestPath = path.join(subjectDir, "control", "cellfence.manifest.json");
    const reviewedManifestSourcePath = path.join(rootDir, "manifests", `${entry.id}.cellfence.manifest.json`);
    const auditLogPath = path.join(subjectDir, "logs", "check.audit.jsonl");
    writeJson(manifestPath, manifest);
    writeJson(reviewedManifestSourcePath, manifest);
    writeJsonl(auditLogPath, Array.from({ length: entry.findings }, (_, index) => ({
      schemaVersion: "cellfence.audit-event.v1",
      runId: "precision-next-cycle-cap-test",
      timestamp: "2026-07-25T00:00:00.000Z",
      commit: entry.commit,
      event: "finding.detected",
      command: "check",
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      severity: "error",
      cellId: "app",
      producerCellId: "core",
      filePath: `src/app/leak-${index}.ts`,
      line: 1,
      message: "private import",
      fingerprint: `${entry.id}-private-import-${index}`,
      outcome: "rejected",
    })));
    subjects.push({
      id: entry.id,
      repository: entry.repository,
      commit: entry.commit,
      manifest: {
        strategy: "copy",
        source: `manifests/${entry.id}.cellfence.manifest.json`,
        reviewStatus: "reviewed",
        review: {
          reviewers: ["fixture-reviewer"],
          boundaryEvidence: ["fixture manifest derived from declared test boundaries"],
        },
      },
    });
    reportSubjects.push({
      id: entry.id,
      repository: entry.repository,
      requestedCommit: entry.commit,
      requestedRef: null,
      status: "checked_findings",
      commit: entry.commit,
      gitTree: "c".repeat(40),
      subjectDir,
      manifest: {
        strategy: "copy",
        reviewStatus: "reviewed",
        path: "cellfence.manifest.json",
        effectivePath: manifestPath,
        sha256: hashFile(manifestPath),
        status: "completed",
      },
      check: {
        status: "checked_findings",
        exitCode: 1,
        ok: false,
        findings: entry.findings,
        warnings: 0,
        auditLogPath,
        auditLogSha256: hashFile(auditLogPath),
      },
    });
  }
  writeJson(corpusPath, {
    schemaVersion: "cellfence.corpus.v1",
    selectionPolicy: {
      frozenAt: "2026-07-25T00:00:00.000Z",
      method: "local precision-next-cycle repository cap test fixture",
    },
    subjects,
  });
  writeJson(reportPath, {
    schemaVersion: "cellfence.corpus-study.v1",
    generatedAt: "2026-07-25T00:00:01.000Z",
    corpusPath,
    dryRun: false,
    allowFloatingRef: false,
    environment: {
      harnessCommit: "d".repeat(40),
      harnessDirty: false,
      cellfenceVersion: "0.1.14",
      corpusSha256: hashFile(corpusPath),
    },
    subjects: reportSubjects,
    summary: {
      total: 2,
      completed: 2,
      failed: 0,
      totalFindings: 23,
    },
  });
  return { corpusPath, reportPath };
}

function runNextCycle(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

test("precision next cycle freezes bundle, worklist, and unlabeled preflight", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-next-cycle-"));
  const outDir = path.join(repoRoot, "tmp", `precision-next-cycle-test-${crypto.randomBytes(6).toString("hex")}`);
  try {
    const { corpusPath, reportPath } = createFixture(rootDir);
    const result = runNextCycle([
      "--study-id",
      "precision-next-cycle-test",
      "--corpus",
      corpusPath,
      "--report",
      reportPath,
      "--out-dir",
      outDir,
      "--raters",
      "agent-a,agent-b",
      "--rater-types",
      "agent,agent",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = readJson(path.join(outDir, "summary.json"));
    assert.equal(summary.schemaVersion, "cellfence.precision-next-cycle.v1");
    assert.match(summary.digests.preLabelArtifactSetSha256, /^[a-f0-9]{64}$/);
    assert.match(summary.digests.unlabeledBundleArtifactSetSha256, /^[a-f0-9]{64}$/);
    assert.match(summary.digests.blindWorklistArtifactSetSha256, /^[a-f0-9]{64}$/);
    assert.equal(summary.worklist.selectedFindings, 1);
    assert.equal(summary.worklist.assignments, 2);
    assert.deepEqual(summary.worklist.selectedByRule, {
      CELLFENCE_PRIVATE_IMPORT: 1,
    });
    assert.equal(summary.sampling.repositoryBalance.enabled, false);
    assert.equal(summary.sampling.repositoryBalance.removedFindingIds, 0);
    assert.equal(fs.existsSync(path.join(outDir, "bundle-unlabeled", "SHA256SUMS")), true);
    assert.equal(fs.existsSync(path.join(outDir, "blind-worklist", "SHA256SUMS")), true);
    assert.equal(fs.existsSync(path.join(outDir, "claim-preflight.prelabel.json")), true);
    const worklist = readJson(path.join(outDir, "blind-worklist", "worklist.json"));
    assert.equal(worklist.summary.selectedFindings, 1);
    assert.equal(worklist.summary.assignments, 2);
    const preflight = readJson(path.join(outDir, "claim-preflight.prelabel.json"));
    assert.equal(preflight.valid, true);
    assert.equal(preflight.claimReady, false);
    assert.match(summary.blockers.join("\n"), /selected findings are not fully independently labeled/);
    assert.match(summary.blockers.join("\n"), /external human\/organization independent label/);
    const externalValidation = readJson(path.join(outDir, "reviewed-corpus-external-validation.json"));
    assert.equal(externalValidation.ok, false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("precision next cycle can freeze a rule-scoped public-symbol supplemental cycle", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-next-cycle-public-symbol-"));
  const outDir = path.join(repoRoot, "tmp", `precision-next-cycle-public-symbol-test-${crypto.randomBytes(6).toString("hex")}`);
  try {
    const { corpusPath, reportPath } = createFixture(rootDir, {
      ruleId: "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
    });
    const result = runNextCycle([
      "--study-id",
      "precision-next-cycle-public-symbol-test",
      "--corpus",
      corpusPath,
      "--report",
      reportPath,
      "--out-dir",
      outDir,
      "--raters",
      "agent-a,agent-b",
      "--rater-types",
      "agent,agent",
      "--include-rules",
      "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = readJson(path.join(outDir, "summary.json"));
    assert.deepEqual(summary.includedRules, ["CELLFENCE_PUBLIC_SYMBOL_MISMATCH"]);
    assert.equal(summary.samplingOptions.includeRulesProvided, true);
    assert.match(fs.readFileSync(path.join(outDir, "SUMMARY.md"), "utf8"), /included rules: `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`/);
    const protocol = readJson(path.join(outDir, "protocol.worklist.json"));
    assert.deepEqual(protocol.claim.includedRules, ["CELLFENCE_PUBLIC_SYMBOL_MISMATCH"]);
    const worklist = readJson(path.join(outDir, "blind-worklist", "worklist.json"));
    assert.deepEqual(worklist.filters.includedRules, ["CELLFENCE_PUBLIC_SYMBOL_MISMATCH"]);
    assert.equal(worklist.summary.selectedFindings, 1);
    const preflight = readJson(path.join(outDir, "claim-preflight.prelabel.json"));
    assert.equal(preflight.valid, true);
    assert.equal(preflight.claimReady, false);
    assert.match(preflight.gateFailures.join("\n"), /CELLFENCE_PUBLIC_SYMBOL_MISMATCH has 1 selected findings/);
    assert.doesNotMatch(preflight.gateFailures.join("\n"), /CELLFENCE_PRIVATE_IMPORT has 0 selected findings/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("precision next cycle can freeze a named boundary-core claim profile", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-next-cycle-boundary-core-"));
  const outDir = path.join(repoRoot, "tmp", `precision-next-cycle-boundary-core-test-${crypto.randomBytes(6).toString("hex")}`);
  try {
    const { corpusPath, reportPath } = createFixture(rootDir);
    const result = runNextCycle([
      "--study-id",
      "precision-next-cycle-boundary-core-test",
      "--corpus",
      corpusPath,
      "--report",
      reportPath,
      "--out-dir",
      outDir,
      "--raters",
      "external-human-reviewer-1,external-org-reviewer-1",
      "--rater-types",
      "human,organization",
      "--claim-profile",
      "ts-js-boundary-core-v1",
      "--external-claim",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const expectedRules = ["CELLFENCE_PRIVATE_IMPORT", "CELLFENCE_UNDECLARED_CONSUMER"];
    const summary = readJson(path.join(outDir, "summary.json"));
    assert.equal(summary.claimProfile, "ts-js-boundary-core-v1");
    assert.match(summary.claimProfileDescription, /boundary-core/);
    assert.deepEqual(summary.includedRules, expectedRules);
    assert.equal(summary.worklist.selectedFindings, 1);
    assert.deepEqual(summary.worklist.selectedByRule, {
      CELLFENCE_PRIVATE_IMPORT: 1,
    });
    assert.equal(summary.samplingOptions.claimProfileProvided, true);
    assert.equal(summary.samplingOptions.includeRulesProvided, false);
    const summaryMarkdown = fs.readFileSync(path.join(outDir, "SUMMARY.md"), "utf8");
    assert.match(summaryMarkdown, /claim profile: `ts-js-boundary-core-v1`/);
    assert.match(summaryMarkdown, /claim profile description: Reviewed TS\/JS boundary-core/);
    assert.match(summaryMarkdown, /worklist selected findings: 1/);
    const protocol = readJson(path.join(outDir, "protocol.worklist.json"));
    assert.equal(protocol.claim.scopeProfile, "ts-js-boundary-core-v1");
    assert.match(protocol.claim.targetPopulation, /boundary-core rules only/);
    assert.deepEqual(protocol.claim.includedRules, expectedRules);
    const worklist = readJson(path.join(outDir, "blind-worklist", "worklist.json"));
    assert.deepEqual(worklist.filters.includedRules, expectedRules);
    assert.equal(worklist.summary.selectedFindings, 1);
    const preflight = readJson(path.join(outDir, "claim-preflight.prelabel.json"));
    assert.equal(preflight.valid, true);
    assert.equal(preflight.claimReady, false);
    assert.match(preflight.gateFailures.join("\n"), /external human\/organization independent label/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("precision next cycle rejects a claim profile with mismatched include rules", () => {
  const result = runNextCycle([
    "--study-id",
    "precision-next-cycle-profile-mismatch-test",
    "--corpus",
    path.join(repoRoot, "tmp", "missing-corpus.json"),
    "--report",
    path.join(repoRoot, "tmp", "missing-report.json"),
    "--out-dir",
    path.join(repoRoot, "tmp", `precision-next-cycle-profile-mismatch-test-${crypto.randomBytes(6).toString("hex")}`),
    "--raters",
    "agent-a,agent-b",
    "--rater-types",
    "agent,agent",
    "--claim-profile",
    "ts-js-boundary-core-v1",
    "--include-rules",
    "CELLFENCE_PRIVATE_IMPORT",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--include-rules must match --claim-profile ts-js-boundary-core-v1/);
});

test("precision next cycle rejects unknown claim profiles", () => {
  const result = runNextCycle([
    "--study-id",
    "precision-next-cycle-unknown-profile-test",
    "--corpus",
    path.join(repoRoot, "tmp", "missing-corpus.json"),
    "--report",
    path.join(repoRoot, "tmp", "missing-report.json"),
    "--out-dir",
    path.join(repoRoot, "tmp", `precision-next-cycle-unknown-profile-test-${crypto.randomBytes(6).toString("hex")}`),
    "--raters",
    "agent-a,agent-b",
    "--rater-types",
    "agent,agent",
    "--claim-profile",
    "unknown-profile",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown --claim-profile value: unknown-profile/);
  assert.match(result.stderr, /ts-js-boundary-core-v1/);
});

test("precision next cycle rejects a claim profile with a conflicting target population", () => {
  const result = runNextCycle([
    "--study-id",
    "precision-next-cycle-profile-population-test",
    "--corpus",
    path.join(repoRoot, "tmp", "missing-corpus.json"),
    "--report",
    path.join(repoRoot, "tmp", "missing-report.json"),
    "--out-dir",
    path.join(repoRoot, "tmp", `precision-next-cycle-profile-population-test-${crypto.randomBytes(6).toString("hex")}`),
    "--raters",
    "agent-a,agent-b",
    "--rater-types",
    "agent,agent",
    "--claim-profile",
    "ts-js-boundary-core-v1",
    "--target-population",
    "all CellFence findings",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--target-population must match --claim-profile ts-js-boundary-core-v1/);
});

test("precision next cycle rejects reports bound to a different corpus hash", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-next-cycle-binding-"));
  const outDir = path.join(repoRoot, "tmp", `precision-next-cycle-binding-test-${crypto.randomBytes(6).toString("hex")}`);
  try {
    const { corpusPath, reportPath } = createFixture(rootDir);
    const corpus = readJson(corpusPath);
    corpus.description = "stale report hash mismatch";
    writeJson(corpusPath, corpus);
    const result = runNextCycle([
      "--study-id",
      "precision-next-cycle-binding-test",
      "--corpus",
      corpusPath,
      "--report",
      reportPath,
      "--out-dir",
      outDir,
      "--raters",
      "agent-a,agent-b",
      "--rater-types",
      "agent,agent",
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /report\.environment\.corpusSha256 does not match --corpus/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("precision next cycle surfaces repository-cap pruning in the summary", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-next-cycle-cap-"));
  const outDir = path.join(repoRoot, "tmp", `precision-next-cycle-cap-test-${crypto.randomBytes(6).toString("hex")}`);
  try {
    const { corpusPath, reportPath } = createRepositoryCapFixture(rootDir);
    const result = runNextCycle([
      "--study-id",
      "precision-next-cycle-cap-test",
      "--corpus",
      corpusPath,
      "--report",
      reportPath,
      "--out-dir",
      outDir,
      "--raters",
      "agent-a,agent-b",
      "--rater-types",
      "agent,agent",
      "--max-repository-contribution",
      "0.5",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = readJson(path.join(outDir, "summary.json"));
    assert.equal(summary.sampling.repositoryBalance.enabled, true);
    assert.equal(summary.sampling.repositoryBalance.feasible, true);
    assert.equal(summary.sampling.repositoryBalance.removedFindingIds, 17);
    assert.deepEqual(summary.sampling.repositoryBalance.removedByRule, {
      CELLFENCE_PRIVATE_IMPORT: 17,
    });
    assert.deepEqual(summary.sampling.repositoryBalance.removedByRepository, {
      "https://github.com/example/cap-a.git": 17,
    });
    assert.match(fs.readFileSync(path.join(outDir, "SUMMARY.md"), "utf8"), /cap-pruned sampled findings: 17/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("precision next cycle rejects unsafe output roots", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-next-cycle-unsafe-"));
  try {
    const { corpusPath, reportPath } = createFixture(rootDir);
    const result = runNextCycle([
      "--study-id",
      "precision-next-cycle-test",
      "--corpus",
      corpusPath,
      "--report",
      reportPath,
      "--out-dir",
      path.join(repoRoot, "reports", "corpus"),
      "--raters",
      "agent-a,agent-b",
      "--rater-types",
      "agent,agent",
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--out-dir must be inside reports\/corpus\/ or tmp\//);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("precision next cycle refuses to force-delete unmarked output directories", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-next-cycle-force-"));
  const unmarkedOutDir = path.join(repoRoot, "tmp", `precision-next-cycle-unmarked-${crypto.randomBytes(6).toString("hex")}`);
  try {
    const { corpusPath, reportPath } = createFixture(rootDir);
    fs.mkdirSync(unmarkedOutDir, { recursive: true });
    fs.writeFileSync(path.join(unmarkedOutDir, "sentinel.txt"), "keep");
    const result = runNextCycle([
      "--study-id",
      "precision-next-cycle-test",
      "--corpus",
      corpusPath,
      "--report",
      reportPath,
      "--out-dir",
      unmarkedOutDir,
      "--raters",
      "agent-a,agent-b",
      "--rater-types",
      "agent,agent",
      "--force",
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to delete unmarked output directory/);
    assert.equal(fs.readFileSync(path.join(unmarkedOutDir, "sentinel.txt"), "utf8"), "keep");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(unmarkedOutDir, { recursive: true, force: true });
  }
});
