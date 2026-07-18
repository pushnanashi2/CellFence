import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const scriptPath = path.join(root, "scripts/corpus-evidence-bundle.mjs");

function runBundle(args, cwd = root) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function createFixture(tempDir) {
  const subjectDir = path.join(tempDir, "subjects", "demo");
  const manifestPath = path.join(subjectDir, "control", "cellfence.manifest.json");
  const auditLogPath = path.join(subjectDir, "logs", "check.audit.jsonl");
  const corpusPath = path.join(tempDir, "corpus.json");
  const reportPath = path.join(tempDir, "report.json");

  writeJson(manifestPath, {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
      requiredRules: [],
    },
    cells: [
      {
        id: "demo",
        ownedPaths: ["src/demo/**"],
        publicEntry: "src/demo/public.ts",
        publicSymbols: ["demo"],
        consumes: [],
        producesArtifacts: [],
      },
    ],
  });
  writeJsonl(auditLogPath, [
    {
      schemaVersion: "cellfence.audit-event.v1",
      runId: "run-1",
      timestamp: "2026-07-18T00:00:00.000Z",
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      event: "finding.detected",
      command: "check",
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      severity: "error",
      cellId: "demo",
      filePath: "src/demo/internal.ts",
      message: "private import",
      fingerprint: "fingerprint-a",
      outcome: "rejected",
    },
    {
      schemaVersion: "cellfence.audit-event.v1",
      runId: "run-1",
      timestamp: "2026-07-18T00:00:00.000Z",
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      event: "finding.detected",
      command: "check",
      ruleId: "CELLFENCE_UNDECLARED_CONSUMER",
      severity: "error",
      cellId: "demo",
      filePath: "src/demo/public.ts",
      message: "undeclared consumer",
      fingerprint: "fingerprint-b",
      outcome: "rejected",
    },
  ]);
  writeJson(corpusPath, {
    schemaVersion: "cellfence.corpus.v1",
    subjects: [
      {
        id: "demo",
        repository: "https://github.com/example/demo.git",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        manifest: {
          strategy: "existing",
          path: "cellfence.manifest.json",
        },
      },
    ],
  });
  writeJson(reportPath, {
    schemaVersion: "cellfence.corpus-study.v1",
    generatedAt: "2026-07-18T00:00:01.000Z",
    corpusPath,
    dryRun: false,
    allowFloatingRef: false,
    environment: {
      harnessCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      harnessDirty: false,
      cellfenceVersion: "0.1.13",
      corpusSha256: hashFile(corpusPath),
    },
    subjects: [
      {
        id: "demo",
        repository: "https://github.com/example/demo.git",
        requestedCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        requestedRef: null,
        status: "checked_findings",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        gitTree: "cccccccccccccccccccccccccccccccccccccccc",
        subjectDir,
        manifest: {
          strategy: "existing",
          path: "cellfence.manifest.json",
          effectivePath: manifestPath,
          sha256: hashFile(manifestPath),
          status: "completed",
        },
        check: {
          status: "checked_findings",
          exitCode: 1,
          ok: false,
          findings: 2,
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
      totalFindings: 2,
    },
  });
  return { corpusPath, reportPath };
}

test("corpus evidence bundle generates normalized findings, sample, and checksums", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-bundle-"));
  try {
    const { corpusPath, reportPath } = createFixture(tempDir);
    const bundleDir = path.join(tempDir, "bundle");

    const result = runBundle([
      "--study-id",
      "fixture-study",
      "--corpus",
      corpusPath,
      "--report",
      reportPath,
      "--out-dir",
      bundleDir,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(path.join(bundleDir, "study.json")), true);
    assert.equal(fs.existsSync(path.join(bundleDir, "SHA256SUMS")), true);
    const findings = fs.readFileSync(path.join(bundleDir, "findings.normalized.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(findings.length, 2);
    assert.match(findings[0].findingId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(findings.every((finding) => finding.precisionEligible), true);
    const sampling = JSON.parse(fs.readFileSync(path.join(bundleDir, "sampling.json"), "utf8"));
    assert.equal(sampling.sampledFindingIds.length, 2);

    const validate = runBundle(["--validate", "--bundle", bundleDir]);
    assert.equal(validate.status, 0, validate.stderr || validate.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus evidence bundle validator rejects labels for unknown findings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-bundle-labels-"));
  try {
    const { corpusPath, reportPath } = createFixture(tempDir);
    const bundleDir = path.join(tempDir, "bundle");
    const result = runBundle([
      "--study-id",
      "fixture-study",
      "--corpus",
      corpusPath,
      "--report",
      reportPath,
      "--out-dir",
      bundleDir,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    writeJsonl(path.join(bundleDir, "labels.jsonl"), [
      {
        schemaVersion: "cellfence.corpus-label.v1",
        studyId: "fixture-study",
        findingId: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        rater: "reviewer-a",
        label: "true_positive",
        rationale: "not present in normalized findings",
      },
    ]);
    const validate = runBundle(["--validate", "--bundle", bundleDir]);

    assert.equal(validate.status, 1);
    assert.match(validate.stderr, /unknown findingId/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
