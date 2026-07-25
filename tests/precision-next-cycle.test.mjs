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

function createFixture(rootDir) {
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
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      severity: "error",
      cellId: "app",
      producerCellId: "core",
      filePath: "src/app/leak.ts",
      line: 1,
      message: "private import",
      fingerprint: "precision-next-cycle-private-import",
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
