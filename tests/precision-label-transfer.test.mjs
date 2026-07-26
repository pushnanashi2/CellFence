import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const scriptPath = path.join(root, "scripts", "precision-label-transfer.mjs");
const worklistScriptPath = path.join(root, "scripts", "precision-label-worklist.mjs");
const fixtureCommit = "a".repeat(40);
const fixtureGitTree = "b".repeat(40);
const fixtureManifest = {
  schemaVersion: "cellfence.manifest.v1",
  cells: [
    {
      id: "demo",
      owns: ["src/**"],
      publicEntrypoints: ["src/index.ts"],
    },
  ],
};
const fixtureManifestText = `${JSON.stringify(fixtureManifest, null, 2)}\n`;
const fixtureManifestSha256 = crypto.createHash("sha256").update(fixtureManifestText).digest("hex");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "");
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function listFilesRecursive(dir) {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }
  walk(dir);
  return files;
}

function writeSha256Sums(dir) {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && entry.name !== "SHA256SUMS") {
        files.push(path.relative(dir, absolute).replace(/\\/g, "/"));
      }
    }
  }
  walk(dir);
  files.sort();
  fs.writeFileSync(
    path.join(dir, "SHA256SUMS"),
    `${files.map((file) => `${hashFile(path.join(dir, file))}  ${file}`).join("\n")}\n`,
  );
}

function preLabelArtifactSetSha256(bundleDir) {
  const excluded = new Set(["SHA256SUMS", "labels.jsonl", "study.json"]);
  const artifacts = listFilesRecursive(bundleDir)
    .map((filePath) => path.relative(bundleDir, filePath).replace(/\\/g, "/"))
    .filter((relativePath) => !excluded.has(relativePath))
    .sort()
    .map((relativePath) => ({
      path: relativePath,
      sha256: hashFile(path.join(bundleDir, relativePath)),
    }));
  return hashText(canonicalJson(artifacts));
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function runTransfer(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function runWorklist(args) {
  return spawnSync(process.execPath, [worklistScriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function findingIdFor(finding) {
  const stableIdParts = [
    finding.subjectId,
    finding.commit || "",
    finding.manifestSha256 || "",
    finding.ruleId,
    finding.cellfenceFingerprint,
  ];
  if ((finding.occurrenceIndex || 0) > 0) stableIdParts.push(String(finding.occurrenceIndex));
  return `sha256:${hashText(stableIdParts.join("\0"))}`;
}

function finding(id, patch = {}) {
  const base = {
    schemaVersion: "cellfence.corpus-finding.v1",
    studyId: "source-study",
    subjectId: "demo",
    repository: "https://github.com/example/demo.git",
    commit: fixtureCommit,
    gitTree: fixtureGitTree,
    manifestSha256: fixtureManifestSha256,
    manifestStrategy: "copy",
    manifestReviewStatus: "reviewed",
    precisionEligible: true,
    ruleId: "CELLFENCE_PRIVATE_IMPORT",
    severity: "error",
    filePath: "src/demo.ts",
    line: null,
    message: "fixture",
    cellfenceFingerprint: id,
    occurrenceIndex: 0,
    cellId: null,
    producerCellId: null,
    outcome: "rejected",
    ...patch,
  };
  return {
    ...base,
    findingId: patch.findingId || findingIdFor(base),
  };
}

function label(findingId, rater, round) {
  return {
    schemaVersion: "cellfence.corpus-label.v1",
    studyId: "source-study",
    findingId,
    rater,
    round,
    assignmentId: `${round}-${rater}-${findingId.slice(-6)}`,
    evidencePackageId: `evidence-${findingId.slice(-6)}`,
    sawPeerLabels: false,
    label: "true_positive",
    rationale: `${rater} fixture label`,
  };
}

function claimLabel(findingId, rater, round, patch = {}) {
  const adjudication = round === "adjudication";
  return {
    ...label(findingId, rater, round),
    raterType: "human",
    role: adjudication ? "adjudicator" : "independent",
    sourceBundleContainsLabels: adjudication ? true : false,
    sawPeerLabels: adjudication ? true : false,
    claimUse: adjudication ? "sealed_adjudication" : "blind_labeling",
    ...patch,
  };
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "subject";
}

function sortFindings(findings) {
  return [...findings].sort((left, right) => [
    left.subjectId || "",
    left.ruleId || "",
    left.filePath || "",
    String(left.line ?? ""),
    left.cellfenceFingerprint || "",
    left.findingId || "",
  ].join("\0").localeCompare([
    right.subjectId || "",
    right.ruleId || "",
    right.filePath || "",
    String(right.line ?? ""),
    right.cellfenceFingerprint || "",
    right.findingId || "",
  ].join("\0")));
}

function auditEventFor(findingEntry) {
  return {
    event: "finding.detected",
    outcome: "rejected",
    ruleId: findingEntry.ruleId,
    severity: findingEntry.severity,
    filePath: findingEntry.filePath,
    line: findingEntry.line,
    message: findingEntry.message,
    fingerprint: findingEntry.cellfenceFingerprint,
    cellId: findingEntry.cellId,
    producerCellId: findingEntry.producerCellId,
  };
}

function createBundle(baseDir, studyId, findings, labels = []) {
  const bundleDir = path.join(baseDir, studyId);
  fs.mkdirSync(bundleDir, { recursive: true });
  const normalizedFindings = sortFindings(findings.map((entry) => ({
    ...entry,
    studyId,
  })));
  const subjects = [...new Map(normalizedFindings.map((entry) => [entry.subjectId, entry])).values()]
    .sort((left, right) => left.subjectId.localeCompare(right.subjectId));
  const manifestCopies = [];
  const logCopies = [];
  const reportSubjects = [];
  const rawFindings = [];
  const eventsBySubject = new Map();
  const corpusSubjects = [];

  for (const subject of subjects) {
    const manifestPath = `manifests/${safeName(subject.subjectId)}.json`;
    writeJson(path.join(bundleDir, manifestPath), fixtureManifest);
    manifestCopies.push({
      subjectId: subject.subjectId,
      path: manifestPath,
      sha256: fixtureManifestSha256,
    });
    corpusSubjects.push({
      id: subject.subjectId,
      repository: subject.repository,
      commit: subject.commit,
      manifest: {
        strategy: "copy",
        source: manifestPath,
        reviewStatus: "reviewed",
        review: {
          reviewers: ["fixture-reviewer"],
          boundaryEvidence: ["precision-label-transfer fixture"],
        },
      },
    });
  }

  for (const findingEntry of normalizedFindings) {
    const event = auditEventFor(findingEntry);
    const subjectEvents = eventsBySubject.get(findingEntry.subjectId) || [];
    const eventIndex = subjectEvents.length;
    subjectEvents.push(event);
    eventsBySubject.set(findingEntry.subjectId, subjectEvents);
    rawFindings.push({
      schemaVersion: "cellfence.corpus-raw-finding.v1",
      studyId,
      subjectId: findingEntry.subjectId,
      auditLogPath: "",
      eventIndex,
      event,
      subject: {
        id: findingEntry.subjectId,
        repository: findingEntry.repository,
        requestedCommit: findingEntry.commit,
        commit: findingEntry.commit,
        gitTree: findingEntry.gitTree,
        manifest: {
          strategy: "copy",
          source: `manifests/${safeName(findingEntry.subjectId)}.json`,
          effectivePath: `manifests/${safeName(findingEntry.subjectId)}.json`,
          sha256: findingEntry.manifestSha256,
          reviewStatus: "reviewed",
        },
      },
    });
  }

  writeJson(path.join(bundleDir, "corpus.json"), {
    schemaVersion: "cellfence.corpus.v1",
    subjects: corpusSubjects,
  });
  const environment = {
    corpusSha256: hashFile(path.join(bundleDir, "corpus.json")),
  };

  for (const subject of subjects) {
    const logPath = `logs/${safeName(subject.subjectId)}/check.audit.jsonl`;
    const events = eventsBySubject.get(subject.subjectId) || [];
    writeJsonl(path.join(bundleDir, logPath), events);
    const auditLogSha256 = hashFile(path.join(bundleDir, logPath));
    logCopies.push({
      subjectId: subject.subjectId,
      path: logPath,
      sha256: auditLogSha256,
    });
    reportSubjects.push({
      id: subject.subjectId,
      repository: subject.repository,
      requestedCommit: subject.commit,
      commit: subject.commit,
      gitTree: subject.gitTree,
      manifest: {
        strategy: "copy",
        effectivePath: `manifests/${safeName(subject.subjectId)}.json`,
        sha256: subject.manifestSha256,
        reviewStatus: "reviewed",
      },
      check: {
        auditLogPath: path.join(bundleDir, logPath),
        auditLogSha256,
        findings: events.length,
      },
    });
  }

  for (const rawFinding of rawFindings) {
    rawFinding.auditLogPath = path.join(bundleDir, `logs/${safeName(rawFinding.subjectId)}/check.audit.jsonl`);
  }

  writeJson(path.join(bundleDir, "report.json"), {
    schemaVersion: "cellfence.corpus-study.v1",
    environment,
    summary: {
      totalFindings: rawFindings.length,
    },
    subjects: reportSubjects,
  });
  writeJsonl(path.join(bundleDir, "findings.raw.jsonl"), rawFindings);
  writeJsonl(path.join(bundleDir, "findings.normalized.jsonl"), normalizedFindings);
  writeJsonl(path.join(bundleDir, "findings.sampled.jsonl"), normalizedFindings);
  writeJson(path.join(bundleDir, "sampling.json"), {
    schemaVersion: "cellfence.corpus-sampling.v1",
    sampledFindingIds: normalizedFindings.map((entry) => entry.findingId),
  });
  writeJson(path.join(bundleDir, "study.json"), {
    schemaVersion: "cellfence.corpus-evidence-bundle.v1",
    studyId,
    environment,
    summary: {
      rawFindings: rawFindings.length,
      normalizedFindings: normalizedFindings.length,
    },
    manifestCopies,
    logCopies,
    preregistration: {
      preLabelArtifactSetSha256: preLabelArtifactSetSha256(bundleDir),
    },
  });
  writeJsonl(path.join(bundleDir, "labels.jsonl"), labels);
  writeSha256Sums(bundleDir);
  return bundleDir;
}

test("precision label transfer rewrites study ids and drops disappeared findings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-transfer-"));
  try {
    const kept = finding("sha256:111111");
    const stale = finding("sha256:222222");
    const sourceBundle = createBundle(tempDir, "source-study", [kept, stale], [
      {
        ...label(kept.findingId, "reviewer-a", "blind_first"),
        confidence: 0.9,
        method: "historical note",
        transferredFrom: { studyId: "older-study" },
      },
      label(kept.findingId, "reviewer-b", "blind_second"),
      label(stale.findingId, "reviewer-a", "blind_first"),
    ]);
    const targetBundle = createBundle(tempDir, "target-study", [kept]);
    const labelsPath = path.join(tempDir, "transferred.labels.jsonl");
    const reportPath = path.join(tempDir, "transfer.report.json");

    const result = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--out",
      labelsPath,
      "--report",
      reportPath,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const labels = readJsonl(labelsPath);
    assert.equal(labels.length, 2);
    assert.equal(labels[0].studyId, "target-study");
    assert.equal(labels[0].transferredFrom, undefined);
    assert.equal(labels[0].confidence, undefined);
    assert.equal(labels[0].method, undefined);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.ok, true);
    assert.equal(report.transferredLabelSources[0].sourceStudyId, "source-study");
    assert.equal(report.summary.staleSourceFindings, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label transfer reports newly sampled target findings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-transfer-missing-"));
  try {
    const kept = finding("sha256:111111");
    const fresh = finding("sha256:333333", { ruleId: "CELLFENCE_UNDECLARED_CONSUMER" });
    const sourceBundle = createBundle(tempDir, "source-study", [kept], [
      label(kept.findingId, "reviewer-a", "blind_first"),
      label(kept.findingId, "reviewer-b", "blind_second"),
    ]);
    const targetBundle = createBundle(tempDir, "target-study", [kept, fresh]);
    const labelsPath = path.join(tempDir, "transferred.labels.jsonl");

    const result = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--out",
      labelsPath,
    ]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.summary.missingTargetFindings, 1);
    assert.equal(report.missingByRule.CELLFENCE_UNDECLARED_CONSUMER, 1);

    const partial = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--out",
      labelsPath,
      "--allow-partial",
    ]);
    assert.equal(partial.status, 0, partial.stderr || partial.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label transfer merges supplemental labels for new findings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-transfer-supplemental-"));
  try {
    const kept = finding("sha256:111111");
    const fresh = finding("sha256:333333", { ruleId: "CELLFENCE_UNDECLARED_RESOURCE_ACCESS" });
    const sourceBundle = createBundle(tempDir, "source-study", [kept], [
      label(kept.findingId, "reviewer-a", "blind_first"),
      label(kept.findingId, "reviewer-b", "blind_second"),
    ]);
    const targetBundle = createBundle(tempDir, "target-study", [kept, fresh]);
    const supplementalPath = path.join(tempDir, "supplemental.jsonl");
    writeJsonl(supplementalPath, [
      label(fresh.findingId, "reviewer-a", "blind_first"),
      label(fresh.findingId, "reviewer-b", "blind_second"),
    ]);
    const labelsPath = path.join(tempDir, "transferred.labels.jsonl");

    const result = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--out",
      labelsPath,
      "--supplemental-labels",
      supplementalPath,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.missingTargetFindings, 0);
    assert.equal(report.summary.supplementalLabels, 2);
    const labels = readJsonl(labelsPath);
    assert.equal(labels.filter((entry) => entry.findingId === fresh.findingId).length, 2);
    assert.equal(labels.at(-1).studyId, "target-study");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label transfer can stamp known rater provenance on transferred labels", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-transfer-rater-type-"));
  try {
    const kept = finding("sha256:111111");
    const sourceBundle = createBundle(tempDir, "source-study", [kept], [
      label(kept.findingId, "reviewer-a", "blind_first"),
      { ...label(kept.findingId, "reviewer-b", "blind_second"), raterType: "human" },
    ]);
    const targetBundle = createBundle(tempDir, "target-study", [kept]);
    const labelsPath = path.join(tempDir, "transferred.labels.jsonl");

    const result = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--out",
      labelsPath,
      "--default-rater-type",
      "agent",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.defaultRaterTypeApplied, "agent");
    const labels = readJsonl(labelsPath);
    const stamped = labels.find((entry) => entry.rater === "reviewer-a");
    const preserved = labels.find((entry) => entry.rater === "reviewer-b");
    assert.equal(stamped.raterType, "agent");
    assert.equal(preserved.raterType, "human");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label transfer strict mode rejects legacy labels before writing output", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-transfer-strict-legacy-"));
  try {
    const kept = finding("sha256:111111");
    const sourceBundle = createBundle(tempDir, "source-study", [kept], [
      label(kept.findingId, "reviewer-a", "blind_first"),
      label(kept.findingId, "reviewer-b", "blind_second"),
    ]);
    const targetBundle = createBundle(tempDir, "target-study", [kept]);
    const worklistDir = path.join(tempDir, "target-worklist");
    const worklist = runWorklist([
      "--bundle",
      targetBundle,
      "--out-dir",
      worklistDir,
      "--raters",
      "reviewer-a,reviewer-b",
      "--rater-types",
      "human,human",
    ]);
    assert.equal(worklist.status, 0, worklist.stderr || worklist.stdout);
    const labelsPath = path.join(tempDir, "transferred.labels.jsonl");

    const result = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--target-worklist",
      worklistDir,
      "--out",
      labelsPath,
      "--strict-claim-labels",
    ]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.labelIssues > 0, true);
    assert.match(report.labelIssues.join("\n"), /role=independent|sourceBundleContainsLabels=false|claimUse=blind_labeling|raterType is required/);
    assert.equal(fs.existsSync(labelsPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label transfer strict mode rejects canonical carry-forward labels without a target worklist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-transfer-strict-ok-"));
  try {
    const kept = finding("sha256:111111");
    const sourceBundle = createBundle(tempDir, "source-study", [kept], [
      claimLabel(kept.findingId, "reviewer-a", "blind_first"),
      claimLabel(kept.findingId, "reviewer-b", "blind_second"),
    ]);
    const targetBundle = createBundle(tempDir, "target-study", [kept]);
    const labelsPath = path.join(tempDir, "transferred.labels.jsonl");

    const result = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--out",
      labelsPath,
      "--strict-claim-labels",
    ]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.match(report.labelIssues.join("\n"), /--strict-claim-labels requires --target-worklist/);
    assert.equal(fs.existsSync(labelsPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label transfer can rebind strict labels to a target sealed worklist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-transfer-worklist-rebind-"));
  try {
    const kept = finding("sha256:111111");
    const sourceBundle = createBundle(tempDir, "source-study", [kept], [
      claimLabel(kept.findingId, "reviewer-a", "blind_first", {
        assignmentId: "assignment-source-a",
        evidencePackageId: "evidence-source-a",
        worklistArtifactSetSha256: "0".repeat(64),
      }),
      claimLabel(kept.findingId, "reviewer-b", "blind_second", {
        assignmentId: "assignment-source-b",
        evidencePackageId: "evidence-source-b",
        worklistArtifactSetSha256: "0".repeat(64),
      }),
    ]);
    const targetBundle = createBundle(tempDir, "target-study", [kept]);
    const worklistDir = path.join(tempDir, "target-worklist");
    const worklist = runWorklist([
      "--bundle",
      targetBundle,
      "--out-dir",
      worklistDir,
      "--raters",
      "reviewer-a,reviewer-b",
      "--rater-types",
      "human,human",
    ]);
    assert.equal(worklist.status, 0, worklist.stderr || worklist.stdout);
    const worklistDigest = hashFile(path.join(worklistDir, "SHA256SUMS"));
    const labelsPath = path.join(tempDir, "transferred.labels.jsonl");

    const result = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--target-worklist",
      worklistDir,
      "--out",
      labelsPath,
      "--strict-claim-labels",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.summary.worklistRebinding.reboundLabels, 2);
    assert.equal(report.summary.worklistRebinding.rewrittenLabels, 2);
    assert.equal(report.summary.worklistRebinding.missingAssignments, 0);
    assert.equal(report.targetWorklists[0].artifactSetSha256, worklistDigest);
    const labels = readJsonl(labelsPath);
    assert.equal(labels.length, 2);
    assert.equal(labels[0].studyId, "target-study");
    assert.equal(labels[0].assignmentId.startsWith("assignment-source-"), false);
    assert.equal(labels[0].evidencePackageId, `evidence-${kept.findingId.replace(/^sha256:/, "").slice(0, 16)}`);
    assert.equal(labels[0].worklistArtifactSetSha256, worklistDigest);
    assert.equal(labels[0].claimUse, "blind_labeling");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label transfer rejects target worklist rebinding gaps before writing output", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-transfer-worklist-gap-"));
  try {
    const kept = finding("sha256:111111");
    const sourceBundle = createBundle(tempDir, "source-study", [kept], [
      claimLabel(kept.findingId, "reviewer-c", "blind_first"),
    ]);
    const targetBundle = createBundle(tempDir, "target-study", [kept]);
    const worklistDir = path.join(tempDir, "target-worklist");
    const worklist = runWorklist([
      "--bundle",
      targetBundle,
      "--out-dir",
      worklistDir,
      "--raters",
      "reviewer-a,reviewer-b",
      "--rater-types",
      "human,human",
    ]);
    assert.equal(worklist.status, 0, worklist.stderr || worklist.stdout);
    const labelsPath = path.join(tempDir, "transferred.labels.jsonl");

    const result = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--target-worklist",
      worklistDir,
      "--out",
      labelsPath,
      "--strict-claim-labels",
    ]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.worklistRebinding.missingAssignments, 1);
    assert.match(report.labelIssues.join("\n"), /no target worklist assignment/);
    assert.equal(fs.existsSync(labelsPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label transfer rejects target worklists bound to a different bundle digest", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-transfer-worklist-bundle-drift-"));
  try {
    const kept = finding("sha256:111111");
    const sourceBundle = createBundle(tempDir, "source-study", [kept], [
      claimLabel(kept.findingId, "reviewer-a", "blind_first"),
      claimLabel(kept.findingId, "reviewer-b", "blind_second"),
    ]);
    const targetBundle = createBundle(tempDir, "target-study", [kept]);
    const worklistDir = path.join(tempDir, "target-worklist");
    const worklist = runWorklist([
      "--bundle",
      targetBundle,
      "--out-dir",
      worklistDir,
      "--raters",
      "reviewer-a,reviewer-b",
      "--rater-types",
      "human,human",
    ]);
    assert.equal(worklist.status, 0, worklist.stderr || worklist.stdout);
    fs.appendFileSync(path.join(targetBundle, "SHA256SUMS"), "# drift\n");
    const labelsPath = path.join(tempDir, "transferred.labels.jsonl");

    const result = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--target-worklist",
      worklistDir,
      "--out",
      labelsPath,
      "--strict-claim-labels",
    ]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.labelIssues.join("\n"), /worklist bundle\.artifactSetSha256 does not match the evidence bundle/);
    assert.equal(fs.existsSync(labelsPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label transfer rejects target worklists when the target bundle digest is missing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-transfer-worklist-missing-bundle-digest-"));
  try {
    const kept = finding("sha256:111111");
    const sourceBundle = createBundle(tempDir, "source-study", [kept], [
      claimLabel(kept.findingId, "reviewer-a", "blind_first"),
      claimLabel(kept.findingId, "reviewer-b", "blind_second"),
    ]);
    const targetBundle = createBundle(tempDir, "target-study", [kept]);
    const worklistDir = path.join(tempDir, "target-worklist");
    const worklist = runWorklist([
      "--bundle",
      targetBundle,
      "--out-dir",
      worklistDir,
      "--raters",
      "reviewer-a,reviewer-b",
      "--rater-types",
      "human,human",
    ]);
    assert.equal(worklist.status, 0, worklist.stderr || worklist.stdout);
    fs.rmSync(path.join(targetBundle, "SHA256SUMS"));
    const labelsPath = path.join(tempDir, "transferred.labels.jsonl");

    const result = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--target-worklist",
      worklistDir,
      "--out",
      labelsPath,
      "--strict-claim-labels",
    ]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.labelIssues.join("\n"), /target bundle .* SHA256SUMS is missing/);
    assert.equal(fs.existsSync(labelsPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label transfer can rebind strict adjudication labels to a target sealed worklist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-transfer-adjudication-rebind-"));
  try {
    const kept = finding("sha256:111111");
    const sourceBundle = createBundle(tempDir, "source-study", [kept], [
      claimLabel(kept.findingId, "reviewer-c", "adjudication", {
        assignmentId: "assignment-source-c",
        evidencePackageId: "evidence-source-c",
        worklistArtifactSetSha256: "0".repeat(64),
        label: "true_positive",
      }),
    ]);
    const targetBundle = createBundle(tempDir, "target-study", [kept], [
      claimLabel(kept.findingId, "reviewer-a", "blind_first", {
        studyId: "target-study",
        label: "true_positive",
      }),
      claimLabel(kept.findingId, "reviewer-b", "blind_second", {
        studyId: "target-study",
        label: "false_positive",
      }),
    ]);
    const worklistDir = path.join(tempDir, "target-adjudication-worklist");
    const worklist = runWorklist([
      "--mode",
      "adjudication",
      "--bundle",
      targetBundle,
      "--out-dir",
      worklistDir,
      "--adjudicator",
      "reviewer-c",
      "--adjudicator-type",
      "human",
    ]);
    assert.equal(worklist.status, 0, worklist.stderr || worklist.stdout);
    const worklistDigest = hashFile(path.join(worklistDir, "SHA256SUMS"));
    const labelsPath = path.join(tempDir, "transferred.labels.jsonl");

    const result = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--target-worklist",
      worklistDir,
      "--out",
      labelsPath,
      "--strict-claim-labels",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.summary.worklistRebinding.reboundLabels, 1);
    assert.equal(report.summary.worklistRebinding.rewrittenLabels, 1);
    const labels = readJsonl(labelsPath);
    assert.equal(labels.length, 1);
    assert.equal(labels[0].role, "adjudicator");
    assert.equal(labels[0].round, "adjudication");
    assert.equal(labels[0].claimUse, "sealed_adjudication");
    assert.equal(labels[0].assignmentId.startsWith("assignment-source-"), false);
    assert.equal(labels[0].worklistArtifactSetSha256, worklistDigest);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision label transfer reports missing target worklists before writing output", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-label-transfer-worklist-missing-"));
  try {
    const kept = finding("sha256:111111");
    const sourceBundle = createBundle(tempDir, "source-study", [kept], [
      claimLabel(kept.findingId, "reviewer-a", "blind_first"),
    ]);
    const targetBundle = createBundle(tempDir, "target-study", [kept]);
    const missingWorklistDir = path.join(tempDir, "missing-worklist");
    const labelsPath = path.join(tempDir, "transferred.labels.jsonl");

    const result = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--target-worklist",
      missingWorklistDir,
      "--out",
      labelsPath,
      "--strict-claim-labels",
    ]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.worklistRebinding.enabled, true);
    assert.equal(report.summary.worklistRebinding.missingAssignments, 1);
    assert.match(report.labelIssues.join("\n"), /worklist not found/);
    assert.equal(fs.existsSync(labelsPath), false);

    const allowPartialResult = runTransfer([
      "--source-bundle",
      sourceBundle,
      "--target-bundle",
      targetBundle,
      "--target-worklist",
      missingWorklistDir,
      "--out",
      labelsPath,
      "--strict-claim-labels",
      "--allow-partial",
    ]);
    assert.equal(allowPartialResult.status, 1, allowPartialResult.stderr || allowPartialResult.stdout);
    assert.equal(fs.existsSync(labelsPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
