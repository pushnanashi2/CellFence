import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const scriptPath = path.join(root, "scripts/corpus-precision-claim.mjs");

function runClaim(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

function safeName(value) {
  const slug = String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "subject";
  return `${slug}-${hashText(value).slice(0, 12)}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function preLabelArtifactSetSha256(bundleDir) {
  const excluded = new Set(["SHA256SUMS", "labels.jsonl", "study.json"]);
  const artifacts = listFiles(bundleDir)
    .map((filePath) => path.relative(bundleDir, filePath).replace(/\\/g, "/"))
    .filter((relativePath) => !excluded.has(relativePath))
    .sort()
    .map((relativePath) => ({
      path: relativePath,
      sha256: hashFile(path.join(bundleDir, relativePath)),
    }));
  return hashText(JSON.stringify(canonicalize(artifacts)));
}

const fixtureManifest = {
  schemaVersion: "cellfence.manifest.v1",
  governance: {
    requireOwnership: true,
    include: ["src/**"],
    exclude: [],
    requiredRules: [],
  },
  cells: [
    {
      id: "producer",
      ownedPaths: ["src/producer/**"],
      publicEntry: "src/producer/public.ts",
      publicSymbols: ["producer"],
      consumes: [],
      producesArtifacts: [],
    },
  ],
};
const fixtureManifestSha256 = hashText(`${JSON.stringify(fixtureManifest, null, 2)}\n`);

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

function finalizeFindings(findings) {
  const occurrenceCounts = new Map();
  return findings.map((finding) => {
    const occurrenceKey = [
      finding.subjectId,
      finding.commit || "",
      finding.manifestSha256 || "",
      finding.ruleId,
      finding.cellfenceFingerprint,
    ].join("\0");
    const occurrenceIndex = occurrenceCounts.get(occurrenceKey) || 0;
    occurrenceCounts.set(occurrenceKey, occurrenceIndex + 1);
    const finalized = { ...finding, occurrenceIndex };
    return {
      ...finalized,
      findingId: findingIdFor(finalized),
    };
  });
}

function listFiles(baseDir) {
  const files = [];
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath));
    else if (entry.isFile() && entry.name !== "SHA256SUMS") files.push(fullPath);
  }
  return files.sort();
}

function writeSha256Sums(bundleDir) {
  const lines = listFiles(bundleDir).map((filePath) => {
    const relativePath = path.relative(bundleDir, filePath).replace(/\\/g, "/");
    return `${hashFile(filePath)}  ${relativePath}`;
  });
  fs.writeFileSync(path.join(bundleDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

function createFinding(index, patch = {}) {
  const subjectNumber = (index % 20) + 1;
  const ruleId = index % 2 === 0 ? "CELLFENCE_PRIVATE_IMPORT" : "CELLFENCE_UNDECLARED_CONSUMER";
  return finalizeFindings([{
    schemaVersion: "cellfence.corpus-finding.v1",
    studyId: "fixture-claim",
    occurrenceIndex: 0,
    subjectId: `subject-${subjectNumber}`,
    repository: `https://github.com/example/subject-${subjectNumber}.git`,
    commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    gitTree: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    manifestSha256: fixtureManifestSha256,
    manifestStrategy: "copy",
    manifestReviewStatus: "reviewed",
    precisionEligible: true,
    ruleId,
    severity: "error",
    filePath: `src/consumer-${index}/use.ts`,
    line: 1,
    message: "fixture finding",
    cellfenceFingerprint: `fingerprint-${index}`,
    cellId: "consumer",
    producerCellId: "producer",
    outcome: "rejected",
    ...patch,
  }])[0];
}

function labelsFor(findings, label = "true_positive") {
  return findings.flatMap((finding) => [
    {
      schemaVersion: "cellfence.corpus-label.v1",
      studyId: "fixture-claim",
      findingId: finding.findingId,
      rater: "reviewer-a",
      round: "blind_first",
      assignmentId: `blind-first-${finding.findingId.slice("sha256:".length, "sha256:".length + 12)}`,
      evidencePackageId: `evidence-${finding.findingId.slice("sha256:".length, "sha256:".length + 12)}`,
      sawPeerLabels: false,
      label,
      rationale: "independent fixture label a",
    },
    {
      schemaVersion: "cellfence.corpus-label.v1",
      studyId: "fixture-claim",
      findingId: finding.findingId,
      rater: "reviewer-b",
      round: "blind_second",
      assignmentId: `blind-second-${finding.findingId.slice("sha256:".length, "sha256:".length + 12)}`,
      evidencePackageId: `evidence-${finding.findingId.slice("sha256:".length, "sha256:".length + 12)}`,
      sawPeerLabels: false,
      label,
      rationale: "independent fixture label b",
    },
  ]);
}

function createBundle(tempDir, findings, labels) {
  const bundleDir = path.join(tempDir, "bundle");
  fs.mkdirSync(bundleDir, { recursive: true });
  const normalizedFindings = [...findings].sort((left, right) => [
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
  const subjects = [...new Map(normalizedFindings.map((finding) => [finding.subjectId, finding])).values()].sort((left, right) => left.subjectId.localeCompare(right.subjectId));
  const manifestCopies = [];
  for (const subject of subjects) {
    const relativePath = `manifests/${safeName(subject.subjectId)}.json`;
    writeJson(path.join(bundleDir, relativePath), fixtureManifest);
    manifestCopies.push({
      subjectId: subject.subjectId,
      path: relativePath,
      sha256: fixtureManifestSha256,
    });
  }
  const corpusSubjects = subjects.map((subject) => ({
    id: subject.subjectId,
    repository: subject.repository,
    commit: subject.commit,
    manifest: {
      strategy: "copy",
      source: `manifests/${subject.subjectId}.json`,
      reviewStatus: "reviewed",
      review: {
        reviewers: ["reviewer-a"],
        boundaryEvidence: ["fixture package boundary"],
      },
    },
  }));
  const reportSubjects = subjects.map((subject) => {
    const subjectFindings = normalizedFindings.filter((finding) => finding.subjectId === subject.subjectId);
    return {
      id: subject.subjectId,
      repository: subject.repository,
      requestedCommit: subject.commit,
      status: subjectFindings.length > 0 ? "checked_findings" : "checked_clean",
      commit: subject.commit,
      gitTree: subject.gitTree,
      manifest: {
        strategy: "copy",
        reviewStatus: "reviewed",
        sha256: fixtureManifestSha256,
        status: "completed",
      },
      check: {
        status: subjectFindings.length > 0 ? "checked_findings" : "checked_clean",
        exitCode: subjectFindings.length > 0 ? 1 : 0,
        ok: subjectFindings.length === 0,
        findings: subjectFindings.length,
        warnings: 0,
        auditLogPath: `logs/${subject.subjectId}/check.audit.jsonl`,
        auditLogSha256: "unused-in-sealed-test-bundle",
      },
    };
  });
  const eventIndexesBySubject = new Map();
  const rawFindings = findings.map((finding) => {
    const eventIndex = eventIndexesBySubject.get(finding.subjectId) || 0;
    eventIndexesBySubject.set(finding.subjectId, eventIndex + 1);
    return {
      schemaVersion: "cellfence.corpus-raw-finding.v1",
      studyId: "fixture-claim",
      subjectId: finding.subjectId,
      auditLogPath: `logs/${finding.subjectId}/check.audit.jsonl`,
      eventIndex,
      event: {
        schemaVersion: "cellfence.audit-event.v1",
        runId: "run-1",
        timestamp: "2026-07-18T00:00:00.000Z",
        commit: finding.commit,
        event: "finding.detected",
        command: "check",
        ruleId: finding.ruleId,
        severity: finding.severity,
        cellId: finding.cellId,
        producerCellId: finding.producerCellId,
        filePath: finding.filePath,
        line: finding.line,
        message: finding.message,
        fingerprint: finding.cellfenceFingerprint,
        outcome: finding.outcome,
      },
      subject: {
        id: finding.subjectId,
        repository: finding.repository,
        requestedCommit: finding.commit,
        commit: finding.commit,
        gitTree: finding.gitTree,
        manifest: {
          strategy: finding.manifestStrategy,
          reviewStatus: finding.manifestReviewStatus,
          sha256: finding.manifestSha256,
        },
      },
    };
  });
  const logCopies = subjects.map((subject) => {
    const relativePath = `logs/${safeName(subject.subjectId)}/check.audit.jsonl`;
    const events = rawFindings.filter((finding) => finding.subjectId === subject.subjectId).map((finding) => finding.event);
    writeJsonl(path.join(bundleDir, relativePath), events);
    return {
      subjectId: subject.subjectId,
      path: relativePath,
    };
  });
  for (const subject of reportSubjects) {
    const logCopy = logCopies.find((copy) => copy.subjectId === subject.id);
    subject.check.auditLogPath = logCopy.path;
    subject.check.auditLogSha256 = hashFile(path.join(bundleDir, logCopy.path));
  }
  const writeBundle = (bundleLabels, preLabelArtifactSetSha256 = null) => {
    writeJson(path.join(bundleDir, "study.json"), {
      schemaVersion: "cellfence.corpus-evidence-bundle.v1",
      studyId: "fixture-claim",
      createdAt: "2026-07-18T00:00:00.000Z",
      environment: {
        harnessCommit: "dddddddddddddddddddddddddddddddddddddddd",
      },
      preregistration: {
        preLabelArtifactSetSha256,
      },
      summary: {
        rawFindings: rawFindings.length,
        normalizedFindings: normalizedFindings.length,
        sampledFindings: normalizedFindings.length,
      },
      manifestCopies,
      logCopies,
    });
    writeJson(path.join(bundleDir, "corpus.json"), {
      schemaVersion: "cellfence.corpus.v1",
      subjects: corpusSubjects,
    });
    writeJson(path.join(bundleDir, "report.json"), {
      schemaVersion: "cellfence.corpus-study.v1",
      subjects: reportSubjects,
      summary: {
        totalFindings: rawFindings.length,
      },
    });
    writeJson(path.join(bundleDir, "sampling.json"), {
      schemaVersion: "cellfence.corpus-sampling.v1",
      seed: "sha256:fixture",
      sampledFindingIds: normalizedFindings.map((finding) => finding.findingId),
    });
    writeJsonl(path.join(bundleDir, "findings.raw.jsonl"), rawFindings);
    writeJsonl(path.join(bundleDir, "findings.normalized.jsonl"), normalizedFindings);
    writeJsonl(path.join(bundleDir, "findings.sampled.jsonl"), normalizedFindings);
    writeJsonl(path.join(bundleDir, "labels.jsonl"), bundleLabels);
  };
  writeBundle([]);
  writeSha256Sums(bundleDir);
  const preLabelSha256 = preLabelArtifactSetSha256(bundleDir);
  writeBundle(labels, preLabelSha256);
  writeSha256Sums(bundleDir);
  return bundleDir;
}

function mergeClaimPatch(baseClaim, patch) {
  return {
    ...baseClaim,
    ...(patch.claim || {}),
  };
}

function createProtocol(tempDir, bundleDir, patch = {}) {
  const protocolPath = path.join(tempDir, "protocol.json");
  const baseClaim = {
    toolCommit: "dddddddddddddddddddddddddddddddddddddddd",
    artifactSetSha256: hashFile(path.join(bundleDir, "SHA256SUMS")),
    preLabelArtifactSetSha256: readJson(path.join(bundleDir, "study.json")).preregistration.preLabelArtifactSetSha256,
    targetPopulation: "reviewed TS/JS workspace repositories",
    supportedSyntaxProfile: "ts-js-supported-v1",
    includedRules: [
      "CELLFENCE_PRIVATE_IMPORT",
      "CELLFENCE_UNDECLARED_CONSUMER",
    ],
    primaryMetric: "blocking_precision",
    minimumPrecision: 0.99,
    confidence: 0.95,
  };
  writeJson(protocolPath, {
    schemaVersion: "cellfence.precision-claim-protocol.v1",
    studyId: "fixture-claim",
    claim: mergeClaimPatch(baseClaim, patch),
    samplingPlan: {
      maxRepositoryContribution: 0.1,
      ...(patch.samplingPlan || {}),
    },
    labelingPlan: {
      minimumIndependentRaters: 2,
      requireAdjudicationForDisagreements: true,
      ...(patch.labelingPlan || {}),
    },
    ...Object.fromEntries(Object.entries(patch).filter(([key]) => !["claim", "samplingPlan", "labelingPlan"].includes(key))),
  });
  return protocolPath;
}

function sealBundleAfterCorpusEdit(bundleDir) {
  const studyPath = path.join(bundleDir, "study.json");
  const study = readJson(studyPath);
  study.preregistration = {
    ...(study.preregistration || {}),
    preLabelArtifactSetSha256: preLabelArtifactSetSha256(bundleDir),
  };
  writeJson(studyPath, study);
  writeSha256Sums(bundleDir);
}

function replaceCorpusManifestReviews(bundleDir, reviewFactory) {
  const corpusPath = path.join(bundleDir, "corpus.json");
  const corpus = readJson(corpusPath);
  corpus.subjects = corpus.subjects.map((subject) => ({
    ...subject,
    manifest: {
      ...subject.manifest,
      review: reviewFactory(subject),
    },
  }));
  writeJson(corpusPath, corpus);
  sealBundleAfterCorpusEdit(bundleDir);
}

test("corpus precision claim passes only when the lower confidence bound clears the protocol threshold", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-pass-"));
  try {
    const findings = Array.from({ length: 598 }, (_, index) => createFinding(index));
    const bundleDir = createBundle(tempDir, findings, labelsFor(findings));
    const protocolPath = createProtocol(tempDir, bundleDir);

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "pass");
    assert.equal(report.metrics.occurrence.blocking.trials, 598);
    assert.equal(report.metrics.powerAnalysis.zeroFalsePositiveRequiredTrials, 299);
    assert.ok(report.decision.oneSidedLowerBound >= 0.99);
    assert.equal(report.claimGates.failures.length, 0);
    assert.equal(report.metrics.repositories.maxRepositoryContribution <= 0.1, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim reports insufficient evidence for a perfect but underpowered sample", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-short-"));
  try {
    const findings = Array.from({ length: 50 }, (_, index) => createFinding(index));
    const bundleDir = createBundle(tempDir, findings, labelsFor(findings));
    const protocolPath = createProtocol(tempDir, bundleDir);

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "insufficient_evidence");
    assert.equal(report.metrics.occurrence.blocking.observedPrecision, 1);
    assert.ok(report.decision.oneSidedLowerBound < 0.99);
    assert.match(report.labelQuality.warnings.join("\n"), /zero observed blocking failures/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim rejects relaxed repository contribution caps", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-cap-"));
  try {
    const findings = Array.from({ length: 598 }, (_, index) => createFinding(index));
    const bundleDir = createBundle(tempDir, findings, labelsFor(findings));
    const protocolPath = createProtocol(tempDir, bundleDir, {
      samplingPlan: {
        maxRepositoryContribution: 1,
      },
    });

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "invalid");
    assert.match(report.labelQuality.issues.join("\n"), /maxRepositoryContribution/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim rejects mismatched pre-label artifact registration", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-prelabel-"));
  try {
    const findings = Array.from({ length: 598 }, (_, index) => createFinding(index));
    const bundleDir = createBundle(tempDir, findings, labelsFor(findings));
    const protocolPath = createProtocol(tempDir, bundleDir, {
      claim: {
        preLabelArtifactSetSha256: "0".repeat(64),
      },
    });

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "invalid");
    assert.match(report.labelQuality.issues.join("\n"), /preLabelArtifactSetSha256/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim requires independent labels and adjudicates disagreements", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-labels-"));
  try {
    const findings = [createFinding(0)];
    const labels = [
      {
        schemaVersion: "cellfence.corpus-label.v1",
        studyId: "fixture-claim",
        findingId: findings[0].findingId,
        rater: "reviewer-a",
        round: "blind_first",
        assignmentId: "blind-first-a",
        evidencePackageId: "evidence-a",
        sawPeerLabels: false,
        label: "true_positive",
        rationale: "first opinion",
      },
      {
        schemaVersion: "cellfence.corpus-label.v1",
        studyId: "fixture-claim",
        findingId: findings[0].findingId,
        rater: "reviewer-b",
        round: "blind_second",
        assignmentId: "blind-second-a",
        evidencePackageId: "evidence-a",
        sawPeerLabels: false,
        label: "false_positive",
        rationale: "second opinion",
      },
    ];
    const bundleDir = createBundle(tempDir, findings, labels);
    const protocolPath = createProtocol(tempDir, bundleDir, {
      claim: {
        includedRules: ["CELLFENCE_PRIVATE_IMPORT"],
        primaryMetric: "blocking_precision",
        minimumPrecision: 0.5,
        confidence: 0.95,
      },
    });

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "invalid");
    assert.match(report.labelQuality.issues.join("\n"), /conflicting labels and no adjudication/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim rejects labels that violate rater provenance policy", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-rater-"));
  try {
    const findings = Array.from({ length: 2 }, (_, index) => createFinding(index));
    const labels = labelsFor(findings).map((entry, index) => {
      if (index === 0) return { ...entry, rater: "agent-blind-first", raterType: "agent" };
      return { ...entry, raterType: "human" };
    });
    const bundleDir = createBundle(tempDir, findings, labels);
    const protocolPath = createProtocol(tempDir, bundleDir, {
      claim: {
        minimumPrecision: 0.5,
        confidence: 0.75,
      },
      labelingPlan: {
        requireKnownRaterType: true,
        allowedRaterTypes: ["human"],
        allowNonHumanRaters: false,
      },
    });

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "invalid");
    assert.match(report.labelQuality.issues.join("\n"), /raterType\/raterClass agent is not allowed/);
    assert.match(report.labelQuality.issues.join("\n"), /disallows non-human/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim counts needs_policy as semantic success but blocking failure", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-needs-policy-"));
  try {
    const findings = [createFinding(0), createFinding(1)];
    const labels = [
      ...labelsFor([findings[0]], "true_positive"),
      ...labelsFor([findings[1]], "needs_policy"),
    ];
    const bundleDir = createBundle(tempDir, findings, labels);
    const protocolPath = createProtocol(tempDir, bundleDir);

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.metrics.occurrence.blocking.successes, 1);
    assert.equal(report.metrics.occurrence.blocking.trials, 2);
    assert.equal(report.metrics.occurrence.blocking.observedPrecision, 0.5);
    assert.equal(report.metrics.occurrence.semanticCorrectness.successes, 2);
    assert.equal(report.metrics.occurrence.semanticCorrectness.observedPrecision, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim rejects tampered bundle files even when SHA256SUMS itself is unchanged", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-tamper-"));
  try {
    const findings = Array.from({ length: 598 }, (_, index) => createFinding(index));
    const bundleDir = createBundle(tempDir, findings, labelsFor(findings));
    const protocolPath = createProtocol(tempDir, bundleDir);
    const labelsPath = path.join(bundleDir, "labels.jsonl");
    fs.appendFileSync(labelsPath, `${JSON.stringify({
      schemaVersion: "cellfence.corpus-label.v1",
      studyId: "fixture-claim",
      findingId: findings[0].findingId,
      rater: "tamper",
      round: "blind_first",
      assignmentId: "tamper",
      evidencePackageId: "tamper",
      sawPeerLabels: false,
      label: "false_positive",
      rationale: "tampered after sealing",
    })}\n`);

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "invalid");
    assert.match(report.labelQuality.issues.join("\n"), /SHA256 mismatch for labels\.jsonl/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim rejects schema-invalid bundle metadata", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-schema-"));
  try {
    const findings = Array.from({ length: 598 }, (_, index) => createFinding(index));
    const bundleDir = createBundle(tempDir, findings, labelsFor(findings));
    const protocolPath = createProtocol(tempDir, bundleDir);
    const study = JSON.parse(fs.readFileSync(path.join(bundleDir, "study.json"), "utf8"));
    study.schemaVersion = "wrong";
    writeJson(path.join(bundleDir, "study.json"), study);
    writeSha256Sums(bundleDir);

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "invalid");
    assert.match(report.labelQuality.issues.join("\n"), /study\.json has unexpected schemaVersion/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim rejects incomplete bundles even when labels are perfect", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-incomplete-"));
  try {
    const findings = Array.from({ length: 598 }, (_, index) => createFinding(index));
    const bundleDir = createBundle(tempDir, findings, labelsFor(findings));
    const protocolPath = createProtocol(tempDir, bundleDir);
    fs.rmSync(path.join(bundleDir, "findings.raw.jsonl"));
    writeSha256Sums(bundleDir);

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "invalid");
    assert.match(report.labelQuality.issues.join("\n"), /bundle validation failed/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim recomputes reviewed eligibility from the sealed corpus", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-eligibility-"));
  try {
    const findings = Array.from({ length: 598 }, (_, index) => createFinding(index));
    const bundleDir = createBundle(tempDir, findings, labelsFor(findings));
    const protocolPath = createProtocol(tempDir, bundleDir);
    const corpusPath = path.join(bundleDir, "corpus.json");
    const corpus = readJson(corpusPath);
    corpus.subjects[0].manifest.reviewStatus = "unreviewed";
    writeJson(corpusPath, corpus);
    writeSha256Sums(bundleDir);

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "invalid");
    assert.match(report.labelQuality.issues.join("\n"), /precision-eligible without a reviewed manifest|precisionEligible does not match/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim accepts attestation-only reviewed copy manifests", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-attestation-"));
  try {
    const findings = Array.from({ length: 598 }, (_, index) => createFinding(index));
    const bundleDir = createBundle(tempDir, findings, labelsFor(findings));
    replaceCorpusManifestReviews(bundleDir, () => ({
      reviewerAttestations: [
        {
          id: "reviewer-a",
          reviewerType: "human",
          independent: true,
        },
      ],
      reviewedAt: "2026-07-20",
      reviewedManifestSha256: fixtureManifestSha256,
      scope: "package/workspace boundary manifest review",
      boundaryEvidence: ["fixture package boundary"],
    }));
    const protocolPath = createProtocol(tempDir, bundleDir, {
      manifestReviewPlan: {
        requireExternalAttestations: true,
      },
    });

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "pass");
    assert.equal(report.protocol.requireExternalManifestReview, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim hash-binds external manifest review attestations", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-attestation-hash-"));
  try {
    const findings = [createFinding(0), createFinding(1)];
    const bundleDir = createBundle(tempDir, findings, labelsFor(findings));
    replaceCorpusManifestReviews(bundleDir, () => ({
      reviewerAttestations: [
        {
          id: "reviewer-a",
          reviewerType: "human",
          independent: true,
        },
      ],
      reviewedAt: "2026-07-20",
      reviewedManifestSha256: "0".repeat(64),
      scope: "package/workspace boundary manifest review",
      boundaryEvidence: ["fixture package boundary"],
    }));
    const protocolPath = createProtocol(tempDir, bundleDir, {
      claim: {
        minimumPrecision: 0.5,
        confidence: 0.75,
      },
      manifestReviewPlan: {
        requireExternalAttestations: true,
      },
    });

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "invalid");
    assert.match(report.labelQuality.issues.join("\n"), /reviewedManifestSha256 does not match sealed manifest copy/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim does not pass when an included rule is underpowered", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-rule-gate-"));
  try {
    const privateFindings = Array.from({ length: 299 }, (_, index) => createFinding(index * 2, { ruleId: "CELLFENCE_PRIVATE_IMPORT" }));
    const consumerFinding = createFinding(9999, { ruleId: "CELLFENCE_UNDECLARED_CONSUMER" });
    const findings = [...privateFindings, consumerFinding];
    const bundleDir = createBundle(tempDir, findings, labelsFor(findings));
    const protocolPath = createProtocol(tempDir, bundleDir);

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "insufficient_evidence");
    assert.match(report.claimGates.failures.join("\n"), /CELLFENCE_UNDECLARED_CONSUMER rule-level lower bound/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim gates duplicate occurrence evidence by unique fingerprint", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-unique-gate-"));
  try {
    const findings = finalizeFindings(Array.from({ length: 598 }, (_, index) => createFinding(index, {
      cellfenceFingerprint: index % 2 === 0 ? "private-fingerprint" : "consumer-fingerprint",
    })));
    const bundleDir = createBundle(tempDir, findings, labelsFor(findings));
    const protocolPath = createProtocol(tempDir, bundleDir);

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.metrics.uniqueFingerprint.uniqueFingerprints, 20);
    assert.match(report.claimGates.failures.join("\n"), /unique-fingerprint lower bound/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("corpus precision claim gates repository macro precision", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-precision-claim-repo-gate-"));
  try {
    const findings = Array.from({ length: 598 }, (_, index) => createFinding(index));
    const badFinding = createFinding(10000, {
      subjectId: "subject-bad",
      repository: "https://github.com/example/bad.git",
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
    });
    const bundleDir = createBundle(tempDir, [...findings, badFinding], [
      ...labelsFor(findings),
      ...labelsFor([badFinding], "false_positive"),
    ]);
    const protocolPath = createProtocol(tempDir, bundleDir);

    const result = runClaim(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.decision.status, "insufficient_evidence");
    assert.match(report.claimGates.failures.join("\n"), /repository macro precision|bad\.git observed blocking precision/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
