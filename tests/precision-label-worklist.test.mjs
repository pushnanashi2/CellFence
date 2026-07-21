import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const bundleScriptPath = path.join(root, "scripts", "corpus-evidence-bundle.mjs");
const worklistScriptPath = path.join(root, "scripts", "precision-label-worklist.mjs");

function runNode(scriptPath, args, cwd = root) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

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

function readJsonl(filePath) {
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  return text.split(/\r?\n/).map((line) => JSON.parse(line));
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

function createCorpusFixture(tempDir) {
  const subjectDir = path.join(tempDir, "subjects", "demo");
  const manifestPath = path.join(subjectDir, "control", "cellfence.manifest.json");
  const auditLogPath = path.join(subjectDir, "logs", "check.audit.jsonl");
  const corpusPath = path.join(tempDir, "corpus.json");
  const reportPath = path.join(tempDir, "report.json");
  const manifest = {
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
  };
  const events = [
    {
      schemaVersion: "cellfence.audit-event.v1",
      runId: "run-1",
      timestamp: "2026-07-20T00:00:00.000Z",
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      event: "finding.detected",
      command: "check",
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      severity: "error",
      cellId: "demo",
      filePath: "src/demo/internal.ts",
      line: 1,
      message: "private import",
      fingerprint: "fingerprint-a",
      outcome: "rejected",
    },
    {
      schemaVersion: "cellfence.audit-event.v1",
      runId: "run-1",
      timestamp: "2026-07-20T00:00:01.000Z",
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      event: "finding.detected",
      command: "check",
      ruleId: "CELLFENCE_UNDECLARED_CONSUMER",
      severity: "error",
      cellId: "demo",
      filePath: "src/demo/public.ts",
      line: 2,
      message: "undeclared consumer",
      fingerprint: "fingerprint-b",
      outcome: "rejected",
    },
  ];
  writeJson(manifestPath, manifest);
  writeJsonl(auditLogPath, events);
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
    generatedAt: "2026-07-20T00:00:02.000Z",
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
          findings: events.length,
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
      totalFindings: events.length,
    },
  });
  return { corpusPath, reportPath };
}

function buildBundle(tempDir) {
  const { corpusPath, reportPath } = createCorpusFixture(tempDir);
  const bundleDir = path.join(tempDir, "bundle");
  const result = runNode(bundleScriptPath, [
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
  return bundleDir;
}

function labelForFinding(studyId, findingId, rater, round, value) {
  return {
    schemaVersion: "cellfence.corpus-label.v1",
    studyId,
    findingId,
    rater,
    raterType: "human",
    role: "independent",
    round,
    assignmentId: `assignment-${crypto.createHash("sha256").update([studyId, findingId, round, rater].join("\0")).digest("hex").slice(0, 16)}`,
    evidencePackageId: `evidence-${findingId.slice("sha256:".length, "sha256:".length + 16)}`,
    sawPeerLabels: false,
    sourceBundleContainsLabels: false,
    claimUse: "blind_labeling",
    label: value,
    rationale: `${rater} ${value}`,
  };
}

test("precision label worklist creates blind assignment packages", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-worklist-"));
  try {
    const bundleDir = buildBundle(tempDir);
    const outDir = path.join(tempDir, "worklist");

    const result = runNode(worklistScriptPath, [
      "--bundle",
      bundleDir,
      "--out-dir",
      outDir,
      "--raters",
      "reviewer-a,reviewer-b",
      "--rater-types",
      "human,human",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = readJson(path.join(outDir, "worklist.json"));
    assert.equal(manifest.summary.selectedFindings, 2);
    assert.equal(manifest.summary.assignments, 4);
    assert.equal(manifest.raters[0].round, "blind_first");
    assert.equal(manifest.raters[1].round, "blind_second");
    const firstAssignment = readJson(path.join(outDir, manifest.assignments[0].path));
    assert.equal(manifest.bundle.pathHint, path.basename(bundleDir));
    assert.equal(firstAssignment.bundle.pathHint, path.basename(bundleDir));
    assert.equal(firstAssignment.assignment.peerLabelsIncluded, false);
    assert.equal(firstAssignment.assignment.sawPeerLabels, false);
    assert.equal(firstAssignment.assignment.sourceBundleContainsLabels, false);
    assert.equal(firstAssignment.assignment.claimUse, "blind_labeling");
    assert.equal(firstAssignment.labelTemplate.raterType, firstAssignment.assignment.raterType);
    assert.equal(firstAssignment.evidenceArtifacts.subject.manifest.path.startsWith("manifests/"), true);
    assert.equal(firstAssignment.evidenceArtifacts.subject.auditLog.path.startsWith("logs/"), true);
    assert.match(firstAssignment.evidenceArtifacts.bundleFiles.normalizedFindings.sha256, /^[a-f0-9]{64}$/);
    assert.equal(firstAssignment.labelTemplate.sawPeerLabels, false);
    assert.equal(firstAssignment.labelTemplate.label, "");
    assert.equal(firstAssignment.labelTemplate.rationale, "");
    assert.ok(fs.existsSync(path.join(outDir, "SHA256SUMS")));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label worklist creates sealed adjudication packages for disagreements only", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-adjudication-worklist-"));
  try {
    const bundleDir = buildBundle(tempDir);
    const findings = readJsonl(path.join(bundleDir, "findings.normalized.jsonl"));
    writeJsonl(path.join(bundleDir, "labels.jsonl"), [
      labelForFinding("fixture-study", findings[0].findingId, "reviewer-a", "blind_first", "true_positive"),
      labelForFinding("fixture-study", findings[0].findingId, "reviewer-b", "blind_second", "false_positive"),
      labelForFinding("fixture-study", findings[1].findingId, "reviewer-a", "blind_first", "true_positive"),
      labelForFinding("fixture-study", findings[1].findingId, "reviewer-b", "blind_second", "true_positive"),
    ]);
    writeSha256Sums(bundleDir);
    const outDir = path.join(tempDir, "adjudication-worklist");

    const result = runNode(worklistScriptPath, [
      "--mode",
      "adjudication",
      "--bundle",
      bundleDir,
      "--out-dir",
      outDir,
      "--adjudicator",
      "reviewer-c",
      "--adjudicator-type",
      "human",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = readJson(path.join(outDir, "worklist.json"));
    assert.equal(manifest.schemaVersion, "cellfence.precision-label-worklist.v2");
    assert.equal(manifest.mode, "adjudication");
    assert.equal(manifest.summary.selectedFindings, 1);
    assert.equal(manifest.summary.assignments, 1);
    assert.equal(manifest.summary.disagreements, 1);
    assert.equal(manifest.raters[0].round, "adjudication");
    const assignment = readJson(path.join(outDir, manifest.assignments[0].path));
    assert.equal(assignment.assignment.peerLabelsIncluded, true);
    assert.equal(assignment.assignment.sawPeerLabels, true);
    assert.equal(assignment.assignment.sourceBundleContainsLabels, true);
    assert.equal(assignment.assignment.claimUse, "sealed_adjudication");
    assert.equal(assignment.labelTemplate.role, "adjudicator");
    assert.equal(assignment.labelTemplate.claimUse, "sealed_adjudication");
    assert.equal(assignment.sourceLabels.length, 2);
    assert.deepEqual(new Set(assignment.sourceLabels.map((label) => label.label)), new Set(["true_positive", "false_positive"]));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label worklist rejects already adjudicated source bundles", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-adjudication-worklist-final-bundle-"));
  try {
    const bundleDir = buildBundle(tempDir);
    const findings = readJsonl(path.join(bundleDir, "findings.normalized.jsonl"));
    writeJsonl(path.join(bundleDir, "labels.jsonl"), [
      labelForFinding("fixture-study", findings[0].findingId, "reviewer-a", "blind_first", "true_positive"),
      labelForFinding("fixture-study", findings[0].findingId, "reviewer-b", "blind_second", "false_positive"),
      {
        ...labelForFinding("fixture-study", findings[0].findingId, "reviewer-c", "adjudication", "true_positive"),
        role: "adjudicator",
        sawPeerLabels: true,
        sourceBundleContainsLabels: true,
        claimUse: "sealed_adjudication",
      },
    ]);
    writeSha256Sums(bundleDir);
    const result = runNode(worklistScriptPath, [
      "--mode",
      "adjudication",
      "--bundle",
      bundleDir,
      "--out-dir",
      path.join(tempDir, "adjudication-worklist"),
      "--adjudicator",
      "reviewer-d",
      "--adjudicator-type",
      "human",
    ]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /pre-adjudication bundle/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label worklist rejects labeled bundles unless explicitly allowed", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-worklist-labeled-"));
  try {
    const bundleDir = buildBundle(tempDir);
    const findings = readJsonl(path.join(bundleDir, "findings.normalized.jsonl"));
    writeJsonl(path.join(bundleDir, "labels.jsonl"), [
      {
        schemaVersion: "cellfence.corpus-label.v1",
        studyId: "fixture-study",
        findingId: findings[0].findingId,
        rater: "reviewer-a",
        raterType: "human",
        role: "independent",
        round: "blind_first",
        assignmentId: "assignment-a",
        evidencePackageId: "evidence-a",
        sawPeerLabels: false,
        sourceBundleContainsLabels: false,
        claimUse: "blind_labeling",
        label: "true_positive",
        rationale: "fixture label",
      },
    ]);
    writeSha256Sums(bundleDir);
    const outDir = path.join(tempDir, "worklist");

    const rejected = runNode(worklistScriptPath, [
      "--bundle",
      bundleDir,
      "--out-dir",
      outDir,
      "--raters",
      "reviewer-a,reviewer-b",
      "--rater-types",
      "human,human",
    ]);

    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /already contains labels/);

    const accepted = runNode(worklistScriptPath, [
      "--bundle",
      bundleDir,
      "--out-dir",
      outDir,
      "--raters",
      "reviewer-a,reviewer-b",
      "--rater-types",
      "human,human",
      "--allow-existing-labels",
    ]);

    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    const manifest = readJson(path.join(outDir, "worklist.json"));
    assert.equal(manifest.summary.existingLabelsInBundle, 1);
    const assignment = readJson(path.join(outDir, manifest.assignments[0].path));
    assert.equal(assignment.assignment.sourceBundleContainsLabels, true);
    assert.equal(assignment.assignment.claimUse, "diagnostic_only_existing_labels");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label worklist requires explicit rater types", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-worklist-rater-types-"));
  try {
    const bundleDir = buildBundle(tempDir);
    const result = runNode(worklistScriptPath, [
      "--bundle",
      bundleDir,
      "--out-dir",
      path.join(tempDir, "worklist"),
      "--raters",
      "reviewer-a,reviewer-b",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--rater-types is required/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label worklist rejects unknown rater types", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-worklist-rater-type-values-"));
  try {
    const bundleDir = buildBundle(tempDir);
    const result = runNode(worklistScriptPath, [
      "--bundle",
      bundleDir,
      "--out-dir",
      path.join(tempDir, "worklist"),
      "--raters",
      "reviewer-a,reviewer-b",
      "--rater-types",
      "human,humna",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown --rater-types value: humna/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label worklist path hints are independent of caller cwd", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-worklist-path-hint-"));
  try {
    const bundleDir = buildBundle(tempDir);
    const firstOutDir = path.join(tempDir, "worklist-a");
    const secondOutDir = path.join(tempDir, "worklist-b");
    const args = [
      "--bundle",
      bundleDir,
      "--raters",
      "reviewer-a,reviewer-b",
      "--rater-types",
      "human,human",
    ];

    const first = runNode(worklistScriptPath, [
      ...args,
      "--out-dir",
      firstOutDir,
    ], root);
    const second = runNode(worklistScriptPath, [
      ...args,
      "--out-dir",
      secondOutDir,
    ], tempDir);

    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const firstManifest = readJson(path.join(firstOutDir, "worklist.json"));
    const secondManifest = readJson(path.join(secondOutDir, "worklist.json"));
    assert.equal(firstManifest.bundle.pathHint, secondManifest.bundle.pathHint);
    assert.equal(firstManifest.bundle.pathHint, path.basename(bundleDir));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label worklist rejects output paths that overlap the sealed bundle", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-worklist-overlap-"));
  try {
    const bundleDir = buildBundle(tempDir);
    const insideBundle = runNode(worklistScriptPath, [
      "--bundle",
      bundleDir,
      "--out-dir",
      path.join(bundleDir, "worklist"),
      "--raters",
      "reviewer-a,reviewer-b",
      "--rater-types",
      "human,human",
    ]);

    assert.equal(insideBundle.status, 1);
    assert.match(insideBundle.stderr, /must not overlap/);

    const parentOfBundle = runNode(worklistScriptPath, [
      "--bundle",
      bundleDir,
      "--out-dir",
      tempDir,
      "--raters",
      "reviewer-a,reviewer-b",
      "--rater-types",
      "human,human",
      "--force",
    ]);

    assert.equal(parentOfBundle.status, 1);
    assert.match(parentOfBundle.stderr, /must not overlap/);
    assert.equal(fs.existsSync(path.join(bundleDir, "study.json")), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
