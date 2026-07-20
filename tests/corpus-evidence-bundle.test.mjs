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

function listFiles(baseDir) {
  const files = [];
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function writeSha256Sums(bundleDir) {
  const lines = listFiles(bundleDir)
    .filter((filePath) => path.basename(filePath) !== "SHA256SUMS")
    .map((filePath) => path.relative(bundleDir, filePath).replace(/\\/g, "/"))
    .sort()
    .map((relativePath) => `${hashFile(path.join(bundleDir, relativePath))}  ${relativePath}`);
  fs.writeFileSync(path.join(bundleDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

function label(findingId, patch = {}) {
  return {
    schemaVersion: "cellfence.corpus-label.v1",
    studyId: "fixture-study",
    findingId,
    rater: "reviewer-a",
    raterType: "human",
    role: "independent",
    round: "blind_first",
    assignmentId: `blind-first-${findingId.slice("sha256:".length, "sha256:".length + 8)}`,
    evidencePackageId: `evidence-${findingId.slice("sha256:".length, "sha256:".length + 8)}`,
    sawPeerLabels: false,
    sourceBundleContainsLabels: false,
    claimUse: "blind_labeling",
    label: "true_positive",
    rationale: "fixture label",
    ...patch,
  };
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
          reviewStatus: "reviewed",
          review: {
            reviewers: ["reviewer-a"],
            boundaryEvidence: ["fixture existing manifest"],
          },
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
      cellfenceVersion: "0.1.14",
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
          reviewStatus: "reviewed",
          effectivePath: manifestPath,
          sha256: hashFile(manifestPath),
          status: "completed",
        },
        check: {
          status: "checked_findings",
          exitCode: 1,
          ok: false,
          findings: 3,
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
      totalFindings: 3,
    },
  });
  return { auditLogPath, corpusPath, reportPath };
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
    assert.equal(findings.length, 3);
    assert.match(findings[0].findingId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(new Set(findings.map((finding) => finding.findingId)).size, 3);
    assert.deepEqual(
      findings
        .filter((finding) => finding.ruleId === "CELLFENCE_PRIVATE_IMPORT")
        .map((finding) => finding.occurrenceIndex)
        .sort(),
      [0, 1],
    );
    assert.equal(findings.every((finding) => finding.precisionEligible), true);
    const sampling = JSON.parse(fs.readFileSync(path.join(bundleDir, "sampling.json"), "utf8"));
    assert.equal(sampling.sampledFindingIds.length, 3);
    assert.equal(sampling.perRuleCap, 299);
    assert.deepEqual(sampling.powerAnalysis, {
      metric: "one-sided exact binomial lower bound",
      zeroFalsePositiveMinimumPrecision: 0.99,
      confidence: 0.95,
      zeroFalsePositiveSampleSize: 299,
    });

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
      label("sha256:0000000000000000000000000000000000000000000000000000000000000000", {
        rationale: "not present in normalized findings",
      }),
    ]);
    const validate = runBundle(["--validate", "--bundle", bundleDir]);

    assert.equal(validate.status, 1);
    assert.match(validate.stderr, /unknown findingId/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus evidence bundle validator rejects labels with bad schema or study id", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-bundle-label-schema-"));
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
    const findingId = fs.readFileSync(path.join(bundleDir, "findings.normalized.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))[0].findingId;

    writeJsonl(path.join(bundleDir, "labels.jsonl"), [
      label(findingId, {
        schemaVersion: "wrong",
        studyId: "other-study",
        peerLabels: ["true_positive"],
      }),
    ]);
    const validate = runBundle(["--validate", "--bundle", bundleDir]);

    assert.equal(validate.status, 1);
    assert.match(validate.stderr, /unexpected schemaVersion/);
    assert.match(validate.stderr, /unexpected studyId/);
    assert.match(validate.stderr, /unexpected field peerLabels/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus evidence bundle validator binds raw findings to the report audit hash", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-bundle-audit-binding-"));
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

    const rawFindingsPath = path.join(bundleDir, "findings.raw.jsonl");
    const rawFindings = fs.readFileSync(rawFindingsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    rawFindings[0].event.message = "forged private import";
    writeJsonl(rawFindingsPath, rawFindings);

    const forgedAuditPath = path.join(bundleDir, "logs", "demo-spoof", "check.audit.jsonl");
    writeJsonl(forgedAuditPath, rawFindings.map((finding) => finding.event));
    const study = JSON.parse(fs.readFileSync(path.join(bundleDir, "study.json"), "utf8"));
    study.logCopies.push({
      subjectId: "demo",
      path: "logs/demo-spoof/check.audit.jsonl",
      sourcePath: "spoof/check.audit.jsonl",
      sha256: hashFile(forgedAuditPath),
    });
    writeJson(path.join(bundleDir, "study.json"), study);
    writeSha256Sums(bundleDir);

    const validate = runBundle(["--validate", "--bundle", bundleDir]);

    assert.equal(validate.status, 1);
    assert.match(validate.stderr, /does not match copied report audit log event/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus evidence bundle validator rejects copy paths that escape the bundle", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-bundle-copy-escape-"));
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

    const outsideManifest = path.join(tempDir, "outside-manifest.json");
    writeJson(outsideManifest, { schemaVersion: "cellfence.manifest.v1", cells: [] });
    const studyPath = path.join(bundleDir, "study.json");
    const study = JSON.parse(fs.readFileSync(studyPath, "utf8"));
    study.manifestCopies[0].path = "../outside-manifest.json";
    study.manifestCopies[0].sha256 = hashFile(outsideManifest);
    writeJson(studyPath, study);
    writeSha256Sums(bundleDir);

    const validate = runBundle(["--validate", "--bundle", bundleDir]);

    assert.equal(validate.status, 1);
    assert.match(validate.stderr, /unsafe bundle path: \.\.\/outside-manifest\.json/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus evidence bundle validator rejects duplicate or unsafe checksum paths", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-bundle-sums-"));
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
    const sumsPath = path.join(bundleDir, "SHA256SUMS");
    const firstLine = fs.readFileSync(sumsPath, "utf8").split(/\r?\n/).find(Boolean);
    fs.appendFileSync(sumsPath, `${firstLine}\n${"0".repeat(64)}  ../outside.json\n`);

    const validate = runBundle(["--validate", "--bundle", bundleDir]);

    assert.equal(validate.status, 1);
    assert.match(validate.stderr, /duplicates/);
    assert.match(validate.stderr, /unsafe path \.\.\/outside\.json/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus evidence bundle validator rejects omitted copied audit findings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-bundle-audit-omission-"));
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

    const rawFindingsPath = path.join(bundleDir, "findings.raw.jsonl");
    const rawFindings = fs.readFileSync(rawFindingsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .slice(0, 2);
    writeJsonl(rawFindingsPath, rawFindings);

    const report = JSON.parse(fs.readFileSync(path.join(bundleDir, "report.json"), "utf8"));
    report.summary.totalFindings = 2;
    writeJson(path.join(bundleDir, "report.json"), report);
    const study = JSON.parse(fs.readFileSync(path.join(bundleDir, "study.json"), "utf8"));
    study.summary.rawFindings = 2;
    writeJson(path.join(bundleDir, "study.json"), study);
    writeSha256Sums(bundleDir);

    const validate = runBundle(["--validate", "--bundle", bundleDir]);

    assert.equal(validate.status, 1);
    assert.match(validate.stderr, /raw finding count does not match copied audit log/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus evidence bundle validator rejects duplicated raw audit event indexes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-bundle-audit-duplicate-"));
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

    const rawFindingsPath = path.join(bundleDir, "findings.raw.jsonl");
    const rawFindings = fs.readFileSync(rawFindingsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    rawFindings[2] = {
      ...rawFindings[2],
      eventIndex: rawFindings[1].eventIndex,
      event: rawFindings[1].event,
    };
    writeJsonl(rawFindingsPath, rawFindings);
    writeSha256Sums(bundleDir);

    const validate = runBundle(["--validate", "--bundle", bundleDir]);

    assert.equal(validate.status, 1);
    assert.match(validate.stderr, /raw findings repeat an audit eventIndex/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus evidence bundle generation rejects missing audit logs with claimed findings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-bundle-missing-audit-"));
  try {
    const { auditLogPath, corpusPath, reportPath } = createFixture(tempDir);
    fs.rmSync(auditLogPath);
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

    assert.equal(result.status, 1);
    assert.match(result.stderr, /audit log is missing/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus evidence bundle generation rejects audit count mismatches", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-bundle-audit-count-"));
  try {
    const { auditLogPath, corpusPath, reportPath } = createFixture(tempDir);
    const events = fs.readFileSync(auditLogPath, "utf8").trim().split(/\r?\n/).slice(0, 2);
    fs.writeFileSync(auditLogPath, `${events.join("\n")}\n`);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    report.subjects[0].check.auditLogSha256 = hashFile(auditLogPath);
    writeJson(reportPath, report);
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

    assert.equal(result.status, 1);
    assert.match(result.stderr, /audit log finding count mismatch/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus evidence bundle generation rejects missing audit log hash", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-bundle-missing-audit-hash-"));
  try {
    const { corpusPath, reportPath } = createFixture(tempDir);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    delete report.subjects[0].check.auditLogSha256;
    writeJson(reportPath, report);
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

    assert.equal(result.status, 1);
    assert.match(result.stderr, /audit log SHA-256 is missing/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
