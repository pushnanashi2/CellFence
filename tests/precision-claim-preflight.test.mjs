import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const scriptPath = path.join(root, "scripts", "precision-claim-preflight.mjs");
const fixtureManifest = {
  schemaVersion: "cellfence.manifest.v1",
  cells: [],
};
const fixtureManifestSha256 = crypto.createHash("sha256").update(`${JSON.stringify(fixtureManifest, null, 2)}\n`).digest("hex");

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

function readJsonl(filePath) {
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  return text.split(/\r?\n/).map((line) => JSON.parse(line));
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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

function safeName(value) {
  const slug = String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "subject";
  return `${slug}-${hashText(value).slice(0, 12)}`;
}

function listFiles(baseDir) {
  const files = [];
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath));
    else if (entry.isFile() && entry.name !== "SHA256SUMS") files.push(fullPath);
  }
  return files;
}

function writeSha256Sums(baseDir) {
  const lines = listFiles(baseDir)
    .map((filePath) => path.relative(baseDir, filePath).replace(/\\/g, "/"))
    .sort()
    .map((relativePath) => `${hashFile(path.join(baseDir, relativePath))}  ${relativePath}`);
  fs.writeFileSync(path.join(baseDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

function artifactRef(baseDir, relativePath) {
  if (!relativePath) return null;
  const filePath = path.join(baseDir, relativePath);
  if (!fs.existsSync(filePath)) return null;
  return {
    path: relativePath.replace(/\\/g, "/"),
    sha256: hashFile(filePath),
  };
}

function firstSubjectArtifact(study, subjectId, suffix) {
  return (study.logCopies || []).find((copy) => {
    return copy?.subjectId === subjectId && String(copy.path || "").endsWith(suffix);
  })?.path || null;
}

function evidenceArtifacts(bundleDir, study, findingRecord) {
  const manifestCopy = (study.manifestCopies || []).find((copy) => copy?.subjectId === findingRecord?.subjectId)?.path || null;
  return {
    bundleFiles: {
      corpus: artifactRef(bundleDir, "corpus.json"),
      report: artifactRef(bundleDir, "report.json"),
      rawFindings: artifactRef(bundleDir, "findings.raw.jsonl"),
      normalizedFindings: artifactRef(bundleDir, "findings.normalized.jsonl"),
      sampledFindings: artifactRef(bundleDir, "findings.sampled.jsonl"),
      sampling: artifactRef(bundleDir, "sampling.json"),
    },
    subject: {
      manifest: artifactRef(bundleDir, manifestCopy),
      auditLog: artifactRef(bundleDir, firstSubjectArtifact(study, findingRecord?.subjectId, "check.audit.jsonl")),
      evidenceGraph: artifactRef(bundleDir, firstSubjectArtifact(study, findingRecord?.subjectId, "evidence-graph.json")),
      checkStdout: artifactRef(bundleDir, firstSubjectArtifact(study, findingRecord?.subjectId, "check.stdout.log")),
      checkStderr: artifactRef(bundleDir, firstSubjectArtifact(study, findingRecord?.subjectId, "check.stderr.log")),
    },
  };
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
  return hashText(canonicalJson(artifacts));
}

function claimBinding(bundleDir) {
  const study = readJson(path.join(bundleDir, "study.json"));
  return {
    toolCommit: study.environment.harnessCommit,
    artifactSetSha256: hashFile(path.join(bundleDir, "SHA256SUMS")),
    preLabelArtifactSetSha256: study.preregistration.preLabelArtifactSetSha256,
  };
}

function protocolFilterSha256(filters) {
  return hashText(canonicalJson({
    includedRules: filters.includedRules || [],
    blockingSeverities: filters.blockingSeverities || ["error"],
    exclusionRules: filters.exclusionRules || [],
  }));
}

function runPreflight(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function finding(index, patch = {}) {
  return {
    schemaVersion: "cellfence.corpus-finding.v1",
    studyId: "preflight-fixture",
    findingId: `sha256:${String(index).repeat(64).slice(0, 64)}`,
    subjectId: `subject-${index}`,
    repository: `https://github.com/example/subject-${index}.git`,
    precisionEligible: true,
    ruleId: "CELLFENCE_PRIVATE_IMPORT",
    severity: "error",
    filePath: `src/${index}.ts`,
    line: index,
    message: "fixture finding",
    ...patch,
  };
}

function label(findingId, rater, round) {
  const assignmentId = `assignment-${hashText(["preflight-fixture", findingId, round, rater].join("\0")).slice(0, 16)}`;
  return {
    schemaVersion: "cellfence.corpus-label.v1",
    studyId: "preflight-fixture",
    findingId,
    rater,
    role: "independent",
    round,
    assignmentId,
    evidencePackageId: `evidence-${findingId.slice("sha256:".length, "sha256:".length + 16)}`,
    sawPeerLabels: false,
    sourceBundleContainsLabels: false,
    claimUse: "blind_labeling",
    label: "true_positive",
    rationale: `${rater} fixture rationale`,
  };
}

function protocol(patch = {}) {
  const { claim = {}, samplingPlan = {}, ...rest } = patch;
  return {
    schemaVersion: "cellfence.precision-claim-protocol.v1",
    studyId: "preflight-fixture",
    claim: {
      includedRules: ["CELLFENCE_PRIVATE_IMPORT"],
      primaryMetric: "blocking_precision",
      minimumPrecision: 0.5,
      confidence: 0.75,
      blockingSeverities: ["error"],
      ...claim,
    },
    samplingPlan: {
      maxRepositoryContribution: 1,
      ...samplingPlan,
    },
    ...rest,
  };
}

function createBundle(tempDir, findings, labels, patch = {}) {
  const bundleDir = path.join(tempDir, "bundle");
  const subjects = [...new Map(findings.map((entry) => [entry.subjectId, entry])).values()];
  const manifestCopies = [];
  for (const subject of subjects) {
    const relativePath = `manifests/${subject.subjectId}.json`;
    writeJson(path.join(bundleDir, relativePath), fixtureManifest);
    manifestCopies.push({
      subjectId: subject.subjectId,
      path: relativePath,
      sha256: fixtureManifestSha256,
    });
  }
  writeJson(path.join(bundleDir, "study.json"), {
    schemaVersion: "cellfence.corpus-evidence-bundle.v1",
    studyId: "preflight-fixture",
    environment: {
      harnessDirty: false,
    },
    manifestCopies,
    ...patch.study,
  });
  writeJson(path.join(bundleDir, "corpus.json"), {
    schemaVersion: "cellfence.corpus.v1",
    subjects: subjects.map((subject) => ({
      id: subject.subjectId,
      repository: subject.repository,
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      manifest: {
        strategy: "copy",
        source: `manifests/${subject.subjectId}.json`,
        reviewStatus: "reviewed",
        review: {
          reviewers: ["reviewer-a"],
          boundaryEvidence: ["fixture boundary"],
        },
      },
    })),
    ...patch.corpus,
  });
  writeJson(path.join(bundleDir, "sampling.json"), {
    schemaVersion: "cellfence.corpus-sampling.v1",
    sampledFindingIds: findings.map((entry) => entry.findingId),
    ...patch.sampling,
  });
  writeJsonl(path.join(bundleDir, "findings.normalized.jsonl"), findings);
  writeJsonl(path.join(bundleDir, "labels.jsonl"), labels);
  const studyPath = path.join(bundleDir, "study.json");
  const study = readJson(studyPath);
  study.environment = {
    harnessCommit: "dddddddddddddddddddddddddddddddddddddddd",
    harnessDirty: false,
    ...study.environment,
  };
  writeJson(path.join(bundleDir, "report.json"), {
    schemaVersion: "cellfence.corpus-study.v1",
    environment: study.environment,
    summary: {
      totalFindings: findings.length,
    },
    ...patch.report,
  });
  study.preregistration = {
    ...study.preregistration,
    preLabelArtifactSetSha256: study.preregistration?.preLabelArtifactSetSha256 || preLabelArtifactSetSha256(bundleDir),
  };
  writeJson(studyPath, study);
  writeSha256Sums(bundleDir);
  return bundleDir;
}

function createWorklist(tempDir, bundleDir, findings, labels, patch = {}) {
  const worklistDir = path.join(tempDir, "worklist");
  const bundleSha256 = hashFile(path.join(bundleDir, "SHA256SUMS"));
  const study = readJson(path.join(bundleDir, "study.json"));
  const bundlePreLabelSha256 = study.preregistration.preLabelArtifactSetSha256;
  const assignments = labels.filter((entry) => entry.round !== "adjudication").map((entry) => {
    const findingRecord = findings.find((candidate) => candidate.findingId === entry.findingId);
    const assignment = {
      schemaVersion: "cellfence.precision-label-assignment.v1",
      studyId: "preflight-fixture",
      bundle: {
        pathHint: path.basename(bundleDir),
        artifactSetSha256: bundleSha256,
        preLabelArtifactSetSha256: bundlePreLabelSha256,
      },
      assignment: {
        assignmentId: entry.assignmentId,
        evidencePackageId: entry.evidencePackageId,
        round: entry.round,
        rater: entry.rater,
        raterType: entry.raterType || "human",
        sawPeerLabels: false,
        peerLabelsIncluded: false,
        sourceBundleContainsLabels: false,
        claimUse: "blind_labeling",
      },
      evidenceArtifacts: evidenceArtifacts(bundleDir, study, findingRecord),
      finding: {
        findingId: entry.findingId,
        subjectId: findingRecord?.subjectId || null,
        ruleId: findingRecord?.ruleId || null,
      },
      allowedLabels: ["true_positive", "false_positive", "needs_policy", "needs_review", "invalid_setup", "out_of_scope"],
      labelTemplate: {
        schemaVersion: "cellfence.corpus-label.v1",
        studyId: "preflight-fixture",
        findingId: entry.findingId,
        rater: entry.rater,
        raterType: entry.raterType || "human",
        role: "independent",
        round: entry.round,
        assignmentId: entry.assignmentId,
        evidencePackageId: entry.evidencePackageId,
        sawPeerLabels: false,
        sourceBundleContainsLabels: false,
        claimUse: "blind_labeling",
        label: "",
        rationale: "",
      },
    };
    const relativePath = path.join(
      "assignments",
      entry.round,
      `${safeName(findingRecord?.subjectId || "subject")}-${safeName(findingRecord?.ruleId || "rule")}-${entry.assignmentId.replace(/^assignment-/, "")}.json`,
    );
    writeJson(path.join(worklistDir, relativePath), assignment);
    return {
      path: relativePath.replace(/\\/g, "/"),
      assignmentId: entry.assignmentId,
      evidencePackageId: entry.evidencePackageId,
      findingId: entry.findingId,
      subjectId: findingRecord?.subjectId || null,
      ruleId: findingRecord?.ruleId || null,
      round: entry.round,
      rater: entry.rater,
      raterType: entry.raterType || "human",
    };
  });
  const worklist = {
    schemaVersion: "cellfence.precision-label-worklist.v1",
    createdBy: "test",
    studyId: "preflight-fixture",
    bundle: {
      pathHint: path.basename(bundleDir),
      artifactSetSha256: bundleSha256,
      preLabelArtifactSetSha256: bundlePreLabelSha256,
    },
    filters: {
      includedRules: [],
      blockingSeverities: ["error"],
      ...patch.filters,
      allowExistingLabels: false,
    },
    protocol: patch.protocol,
    raters: [
      { rater: "reviewer-a", raterType: "human", round: "blind_first" },
      { rater: "reviewer-b", raterType: "human", round: "blind_second" },
    ],
    summary: {
      selectedFindings: findings.length,
      assignments: assignments.length,
      existingLabelsInBundle: 0,
    },
    assignments,
  };
  if (!worklist.protocol) delete worklist.protocol;
  writeJson(path.join(worklistDir, "worklist.json"), worklist);
  writeSha256Sums(worklistDir);
  return worklistDir;
}

test("precision claim preflight accepts a labeled, balanced bundle with enough power", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-ok-"));
  try {
    const findings = [finding(1), finding(2)];
    const labels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]).map((entry) => ({ ...entry, raterType: "human" }));
    const bundleDir = createBundle(tempDir, findings, labels);
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: {
        ...claimBinding(bundleDir),
        worklistArtifactSetSha256: hashFile(path.join(worklistDir, "SHA256SUMS")),
      },
      labelingPlan: {
        requireKnownRaterType: true,
        allowedRaterTypes: ["human"],
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath, "--worklist", worklistDir]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.claimReady, true);
    assert.equal(report.protocol.requiredZeroFalsePositiveFindingsPerRule, 2);
    assert.equal(report.selectedByRule.CELLFENCE_PRIVATE_IMPORT.additionalTruePositiveTrialsNeeded, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight rejects post-worklist exclusion denominator shrinkage", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-exclusion-worklist-"));
  try {
    const findings = [finding(1), finding(2)];
    const labels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]).map((entry) => ({ ...entry, raterType: "human" }));
    const bundleDir = createBundle(tempDir, findings, labels);
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: {
        ...claimBinding(bundleDir),
        worklistArtifactSetSha256: hashFile(path.join(worklistDir, "SHA256SUMS")),
      },
      labelingPlan: {
        requireKnownRaterType: true,
        allowedRaterTypes: ["human"],
      },
      exclusionRules: [
        {
          field: "findingId",
          equals: findings[1].findingId,
          reason: "attempt to remove a sealed worklist finding",
        },
      ],
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath, "--worklist", worklistDir]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.valid, false);
    assert.equal(report.summary.excludedFindings, 1);
    assert.equal(report.protocol.exclusionRules.length, 1);
    assert.match(report.issues.join("\n"), /sealed blind_first worklist finding set does not match protocol-selected findings/);
    assert.match(report.issues.join("\n"), /sealed blind_second worklist finding set does not match protocol-selected findings/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight is not claim-ready without sealed worklist binding", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-no-worklist-"));
  try {
    const findings = [finding(1), finding(2)];
    const labels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]);
    const bundleDir = createBundle(tempDir, findings, labels);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: claimBinding(bundleDir),
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.claimReady, false);
    assert.match(report.gateFailures.join("\n"), /sealed worklist binding is required/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight rejects duplicate sealed worklist rounds", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-duplicate-worklist-rounds-"));
  try {
    const findings = [finding(1), finding(2)];
    const labels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]).map((entry) => ({ ...entry, raterType: "human" }));
    const bundleDir = createBundle(tempDir, findings, labels);
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const worklistSha256 = hashFile(path.join(worklistDir, "SHA256SUMS"));
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: {
        ...claimBinding(bundleDir),
        worklistArtifactSetSha256s: [worklistSha256, worklistSha256],
      },
      labelingPlan: {
        requireKnownRaterType: true,
        allowedRaterTypes: ["human"],
      },
    }));

    const result = runPreflight([
      "--bundle",
      bundleDir,
      "--protocol",
      protocolPath,
      "--worklist",
      worklistDir,
      "--worklist",
      worklistDir,
    ]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /duplicate sealed worklist round blind_first/);
    assert.match(report.issues.join("\n"), /duplicate sealed worklist round blind_second/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight rejects missing sealed claim binding fields", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-binding-"));
  try {
    const findings = [finding(1), finding(2)];
    const labels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]).map((entry) => ({ ...entry, raterType: "human" }));
    const bundleDir = createBundle(tempDir, findings, labels);
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: {
        worklistArtifactSetSha256: hashFile(path.join(worklistDir, "SHA256SUMS")),
      },
      labelingPlan: {
        requireKnownRaterType: true,
        allowedRaterTypes: ["human"],
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath, "--worklist", worklistDir]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /claim\.toolCommit is required/);
    assert.match(report.issues.join("\n"), /claim\.artifactSetSha256 is required/);
    assert.match(report.issues.join("\n"), /claim\.preLabelArtifactSetSha256 is required/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight rejects bundles without bound harness commits", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-harness-commit-"));
  try {
    const findings = [finding(1), finding(2)];
    const labels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]).map((entry) => ({ ...entry, raterType: "human" }));
    const bundleDir = createBundle(tempDir, findings, labels);
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const studyPath = path.join(bundleDir, "study.json");
    const study = readJson(studyPath);
    delete study.environment.harnessCommit;
    writeJson(studyPath, study);
    writeSha256Sums(bundleDir);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: {
        toolCommit: "dddddddddddddddddddddddddddddddddddddddd",
        artifactSetSha256: hashFile(path.join(bundleDir, "SHA256SUMS")),
        preLabelArtifactSetSha256: study.preregistration.preLabelArtifactSetSha256,
        worklistArtifactSetSha256: hashFile(path.join(worklistDir, "SHA256SUMS")),
      },
      labelingPlan: {
        requireKnownRaterType: true,
        allowedRaterTypes: ["human"],
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath, "--worklist", worklistDir]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /study\.environment\.harnessCommit is required/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight rejects study environment spoofing after pre-label sealing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-environment-spoof-"));
  try {
    const findings = [finding(1), finding(2)];
    const labels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]).map((entry) => ({ ...entry, raterType: "human" }));
    const bundleDir = createBundle(tempDir, findings, labels);
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const studyPath = path.join(bundleDir, "study.json");
    const study = readJson(studyPath);
    study.environment.harnessCommit = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    writeJson(studyPath, study);
    writeSha256Sums(bundleDir);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: {
        toolCommit: study.environment.harnessCommit,
        artifactSetSha256: hashFile(path.join(bundleDir, "SHA256SUMS")),
        preLabelArtifactSetSha256: study.preregistration.preLabelArtifactSetSha256,
        worklistArtifactSetSha256: hashFile(path.join(worklistDir, "SHA256SUMS")),
      },
      labelingPlan: {
        requireKnownRaterType: true,
        allowedRaterTypes: ["human"],
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath, "--worklist", worklistDir]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /study\.environment does not match sealed report\.environment/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight recomputes pre-label digest when report and study are spoofed together", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-prelabel-spoof-"));
  try {
    const findings = [finding(1), finding(2)];
    const labels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]).map((entry) => ({ ...entry, raterType: "human" }));
    const bundleDir = createBundle(tempDir, findings, labels);
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const spoofedEnvironment = {
      harnessCommit: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      harnessDirty: false,
    };
    const reportPath = path.join(bundleDir, "report.json");
    const report = readJson(reportPath);
    report.environment = spoofedEnvironment;
    writeJson(reportPath, report);
    const studyPath = path.join(bundleDir, "study.json");
    const study = readJson(studyPath);
    study.environment = spoofedEnvironment;
    writeJson(studyPath, study);
    writeSha256Sums(bundleDir);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: {
        toolCommit: spoofedEnvironment.harnessCommit,
        artifactSetSha256: hashFile(path.join(bundleDir, "SHA256SUMS")),
        preLabelArtifactSetSha256: study.preregistration.preLabelArtifactSetSha256,
        worklistArtifactSetSha256: hashFile(path.join(worklistDir, "SHA256SUMS")),
      },
      labelingPlan: {
        requireKnownRaterType: true,
        allowedRaterTypes: ["human"],
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath, "--worklist", worklistDir]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const preflightReport = JSON.parse(result.stdout);
    assert.match(preflightReport.issues.join("\n"), /preLabelArtifactSetSha256 does not match bundle artifacts/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight rejects bundle files tampered after SHA256SUMS sealing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-tamper-"));
  try {
    const findings = [finding(1), finding(2)];
    const labels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]).map((entry) => ({ ...entry, raterType: "human" }));
    const bundleDir = createBundle(tempDir, findings, labels);
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: {
        ...claimBinding(bundleDir),
        worklistArtifactSetSha256: hashFile(path.join(worklistDir, "SHA256SUMS")),
      },
      labelingPlan: {
        requireKnownRaterType: true,
        allowedRaterTypes: ["human"],
      },
    }));
    const tamperedLabels = readJsonl(path.join(bundleDir, "labels.jsonl"));
    tamperedLabels[0].rationale = "tampered after sealing";
    writeJsonl(path.join(bundleDir, "labels.jsonl"), tamperedLabels);

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath, "--worklist", worklistDir]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /bundle SHA256 mismatch for labels\.jsonl/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight rejects empty bundle SHA256SUMS even when the protocol hashes it", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-empty-sums-"));
  try {
    const findings = [finding(1), finding(2)];
    const labels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]).map((entry) => ({ ...entry, raterType: "human" }));
    const bundleDir = createBundle(tempDir, findings, labels);
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    fs.writeFileSync(path.join(bundleDir, "SHA256SUMS"), "");
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: {
        ...claimBinding(bundleDir),
        worklistArtifactSetSha256: hashFile(path.join(worklistDir, "SHA256SUMS")),
      },
      labelingPlan: {
        requireKnownRaterType: true,
        allowedRaterTypes: ["human"],
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath, "--worklist", worklistDir]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /bundle SHA256SUMS file list does not match bundle contents/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight rejects duplicate or unsafe bundle SHA256SUMS paths", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-sums-"));
  try {
    const findings = [finding(1), finding(2)];
    const labels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]).map((entry) => ({ ...entry, raterType: "human" }));
    const bundleDir = createBundle(tempDir, findings, labels);
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const sumsPath = path.join(bundleDir, "SHA256SUMS");
    const firstLine = fs.readFileSync(sumsPath, "utf8").split(/\r?\n/).find(Boolean);
    fs.appendFileSync(sumsPath, `${firstLine}\n${"0".repeat(64)}  ../outside.json\n`);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: {
        ...claimBinding(bundleDir),
        worklistArtifactSetSha256: hashFile(path.join(worklistDir, "SHA256SUMS")),
      },
      labelingPlan: {
        requireKnownRaterType: true,
        allowedRaterTypes: ["human"],
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath, "--worklist", worklistDir]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /duplicates/);
    assert.match(report.issues.join("\n"), /unsafe path \.\.\/outside\.json/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight reports dirty, unlabeled, and underpowered evidence separately", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-underpowered-"));
  try {
    const findings = [finding(1)];
    const bundleDir = createBundle(tempDir, findings, [], {
      study: {
        environment: {
          harnessDirty: true,
        },
      },
    });
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: {
        ...claimBinding(bundleDir),
        includedRules: ["CELLFENCE_PRIVATE_IMPORT"],
        primaryMetric: "blocking_precision",
        minimumPrecision: 0.99,
        confidence: 0.95,
        blockingSeverities: ["error"],
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.claimReady, false);
    assert.match(report.gateFailures.join("\n"), /dirty CellFence worktree/);
    assert.match(report.gateFailures.join("\n"), /not fully independently labeled/);
    assert.match(report.gateFailures.join("\n"), /299 zero-false-positive findings/);
    assert.equal(report.selectedByRule.CELLFENCE_PRIVATE_IMPORT.sampleDeficitBeforeLabeling, 298);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight rejects repository concentration before claim evaluation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-contribution-"));
  try {
    const findings = [finding(1, { repository: "https://github.com/example/one.git" }), finding(2, { repository: "https://github.com/example/one.git" })];
    const labels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]);
    const bundleDir = createBundle(tempDir, findings, labels);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: claimBinding(bundleDir),
      samplingPlan: {
        maxRepositoryContribution: 0.5,
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.repositoryContribution.maxRepositoryContribution, 1);
    assert.match(report.gateFailures.join("\n"), /contributes 100.0%/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight applies structured exclusion rules before label readiness", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-exclusion-"));
  try {
    const findings = [
      finding(1, { filePath: "src/keep.ts" }),
      finding(2, { filePath: "src/generated/out.ts" }),
    ];
    const labels = [
      label(findings[0].findingId, "reviewer-a", "blind_first"),
      label(findings[0].findingId, "reviewer-b", "blind_second"),
    ];
    const bundleDir = createBundle(tempDir, findings, labels);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: claimBinding(bundleDir),
      exclusionRules: [
        {
          field: "filePath",
          pattern: "src/generated/**",
          reason: "generated artifacts are outside this claim",
        },
      ],
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.selectedByRule.CELLFENCE_PRIVATE_IMPORT.selectedFindings, 1);
    assert.doesNotMatch(report.gateFailures.join("\n"), /selected findings are not fully independently labeled/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight rejects descriptive exclusion strings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-exclusion-string-"));
  try {
    const findings = [finding(1)];
    const bundleDir = createBundle(tempDir, findings, []);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: claimBinding(bundleDir),
      exclusionRules: ["generated files are excluded"],
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /descriptive strings are not applied/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight gates rater provenance when protocol requires it", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-rater-"));
  try {
    const findings = [finding(1)];
    const labels = [
      label(findings[0].findingId, "agent-blind-first", "blind_first"),
      label(findings[0].findingId, "reviewer-b", "blind_second"),
    ];
    labels[1].raterType = "human";
    const bundleDir = createBundle(tempDir, findings, labels);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: claimBinding(bundleDir),
      labelingPlan: {
        requireKnownRaterType: true,
        allowedRaterTypes: ["human"],
        allowNonHumanRaters: false,
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /missing raterType\/raterClass/);
    assert.match(report.issues.join("\n"), /non-human/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight rejects malformed label rows before claim evaluation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-label-row-"));
  try {
    const findings = [finding(1)];
    const labels = [
      { ...label(findings[0].findingId, "reviewer-a", "blind_first"), studyId: "wrong-study", peerLabels: ["true_positive"] },
      label(findings[0].findingId, "reviewer-b", "blind_second"),
    ];
    const bundleDir = createBundle(tempDir, findings, labels);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: claimBinding(bundleDir),
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /unexpected studyId/);
    assert.match(report.issues.join("\n"), /unexpected field peerLabels/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight rejects labels that are not bound to a sealed worklist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-worklist-"));
  try {
    const findings = [finding(1), finding(2)];
    const correctLabels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]).map((entry) => ({ ...entry, raterType: "human" }));
    const tamperedLabels = correctLabels.map((entry, index) => (index === 0 ? { ...entry, assignmentId: "fabricated-assignment" } : entry));
    const bundleDir = createBundle(tempDir, findings, tamperedLabels);
    const worklistDir = createWorklist(tempDir, bundleDir, findings, correctLabels);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: {
        ...claimBinding(bundleDir),
        worklistArtifactSetSha256: hashFile(path.join(worklistDir, "SHA256SUMS")),
      },
      labelingPlan: {
        requireKnownRaterType: true,
        allowedRaterTypes: ["human"],
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath, "--worklist", worklistDir]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /no sealed worklist assignment fabricated-assignment/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight rejects protocol-bound worklist filter metadata drift", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-worklist-protocol-"));
  try {
    const findings = [finding(1), finding(2)];
    const labels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]).map((entry) => ({ ...entry, raterType: "human" }));
    const bundleDir = createBundle(tempDir, findings, labels);
    const binding = claimBinding(bundleDir);
    const sealedFilters = {
      includedRules: ["CELLFENCE_PRIVATE_IMPORT", "CELLFENCE_UNDECLARED_CONSUMER"],
      blockingSeverities: ["error"],
      exclusionRules: [],
    };
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels, {
      filters: {
        ...sealedFilters,
        filterSha256: protocolFilterSha256(sealedFilters),
      },
      protocol: {
        pathHint: "protocol.json",
        sha256: "a".repeat(64),
        studyId: "preflight-fixture",
        sourceBundleArtifactSetSha256: binding.artifactSetSha256,
        preLabelArtifactSetSha256: binding.preLabelArtifactSetSha256,
        ...sealedFilters,
        filterSha256: protocolFilterSha256(sealedFilters),
      },
    });
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: {
        ...binding,
        worklistArtifactSetSha256: hashFile(path.join(worklistDir, "SHA256SUMS")),
        includedRules: ["CELLFENCE_PRIVATE_IMPORT"],
      },
      labelingPlan: {
        requireKnownRaterType: true,
        allowedRaterTypes: ["human"],
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath, "--worklist", worklistDir]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /worklist\.protocol\.includedRules does not match the active claim protocol/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight rejects worklist filters that drift from sealed protocol metadata", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-worklist-filter-drift-"));
  try {
    const findings = [finding(1), finding(2)];
    const labels = findings.flatMap((entry) => [
      label(entry.findingId, "reviewer-a", "blind_first"),
      label(entry.findingId, "reviewer-b", "blind_second"),
    ]).map((entry) => ({ ...entry, raterType: "human" }));
    const bundleDir = createBundle(tempDir, findings, labels);
    const binding = claimBinding(bundleDir);
    const protocolFilters = {
      includedRules: ["CELLFENCE_PRIVATE_IMPORT"],
      blockingSeverities: ["error"],
      exclusionRules: [],
    };
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels, {
      filters: {
        includedRules: ["CELLFENCE_PRIVATE_IMPORT", "CELLFENCE_UNDECLARED_CONSUMER"],
        blockingSeverities: ["error"],
        exclusionRules: [],
        filterSha256: protocolFilterSha256(protocolFilters),
      },
      protocol: {
        pathHint: "protocol.json",
        sha256: "a".repeat(64),
        studyId: "preflight-fixture",
        sourceBundleArtifactSetSha256: binding.artifactSetSha256,
        preLabelArtifactSetSha256: binding.preLabelArtifactSetSha256,
        ...protocolFilters,
        filterSha256: protocolFilterSha256(protocolFilters),
      },
    });
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: {
        ...binding,
        worklistArtifactSetSha256: hashFile(path.join(worklistDir, "SHA256SUMS")),
      },
      labelingPlan: {
        requireKnownRaterType: true,
        allowedRaterTypes: ["human"],
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath, "--worklist", worklistDir]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /worklist\.filters\.includedRules does not match the active claim protocol/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight gates external manifest review provenance", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-manifest-review-"));
  try {
    const findings = [finding(1)];
    const labels = [
      label(findings[0].findingId, "reviewer-a", "blind_first"),
      label(findings[0].findingId, "reviewer-b", "blind_second"),
    ];
    const bundleDir = createBundle(tempDir, findings, labels, {
      corpus: {
        subjects: [
          {
            id: "subject-1",
            repository: "https://github.com/example/subject-1.git",
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            manifest: {
              strategy: "copy",
              source: "manifests/subject-1.json",
              reviewStatus: "reviewed",
              review: {
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
                boundaryEvidence: ["fixture boundary"],
              },
            },
          },
        ],
      },
    });
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: claimBinding(bundleDir),
      manifestReviewPlan: {
        requireExternalAttestations: true,
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /reviewedManifestSha256 does not match sealed manifest copy/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision claim preflight rejects escaped manifest copy paths", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-preflight-manifest-escape-"));
  try {
    const findings = [finding(1)];
    const labels = [
      label(findings[0].findingId, "reviewer-a", "blind_first"),
      label(findings[0].findingId, "reviewer-b", "blind_second"),
    ];
    const bundleDir = createBundle(tempDir, findings, labels, {
      corpus: {
        subjects: [
          {
            id: "subject-1",
            repository: "https://github.com/example/subject-1.git",
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            manifest: {
              strategy: "copy",
              source: "manifests/subject-1.json",
              reviewStatus: "reviewed",
              review: {
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
                boundaryEvidence: ["fixture boundary"],
              },
            },
          },
        ],
      },
    });
    const outsideManifest = path.join(tempDir, "outside-manifest.json");
    writeJson(outsideManifest, fixtureManifest);
    const studyPath = path.join(bundleDir, "study.json");
    const study = readJson(studyPath);
    study.manifestCopies[0].path = "../outside-manifest.json";
    study.manifestCopies[0].sha256 = hashFile(outsideManifest);
    writeJson(studyPath, study);
    writeSha256Sums(bundleDir);
    const protocolPath = path.join(tempDir, "protocol.json");
    writeJson(protocolPath, protocol({
      claim: claimBinding(bundleDir),
      manifestReviewPlan: {
        requireExternalAttestations: true,
      },
    }));

    const result = runPreflight(["--bundle", bundleDir, "--protocol", protocolPath]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /unsafe bundle path: \.\.\/outside-manifest\.json/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
