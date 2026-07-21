import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const scriptPath = path.join(root, "scripts", "precision-labels-validate.mjs");

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

function runValidator(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
  });
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
  const filePath = path.join(baseDir, relativePath);
  if (!fs.existsSync(filePath)) return null;
  return {
    path: relativePath,
    sha256: hashFile(filePath),
  };
}

function evidenceArtifacts(bundleDir) {
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
      manifest: null,
      auditLog: null,
      evidenceGraph: null,
      checkStdout: null,
      checkStderr: null,
    },
  };
}

function finding(id, patch = {}) {
  return {
    schemaVersion: "cellfence.corpus-finding.v1",
    studyId: "label-fixture",
    findingId: `sha256:${id.repeat(64).slice(0, 64)}`,
    subjectId: "demo",
    repository: "https://github.com/example/demo.git",
    precisionEligible: true,
    ruleId: "CELLFENCE_PRIVATE_IMPORT",
    severity: "error",
    ...patch,
  };
}

function label(findingId, rater, value, patch = {}) {
  const isAdjudication = patch.role === "adjudicator" || patch.adjudication === true || patch.adjudicated === true;
  const round = patch.round || (isAdjudication ? "adjudication" : rater.endsWith("-b") ? "blind_second" : "blind_first");
  const assignmentId = `assignment-${hashText(["label-fixture", findingId, round, rater].join("\0")).slice(0, 16)}`;
  const provenance = isAdjudication
    ? { role: "adjudicator" }
    : { role: "independent", sourceBundleContainsLabels: false, claimUse: "blind_labeling" };
  return {
    schemaVersion: "cellfence.corpus-label.v1",
    studyId: "label-fixture",
    findingId,
    rater,
    raterType: "human",
    round,
    assignmentId,
    evidencePackageId: `evidence-${findingId.slice("sha256:".length, "sha256:".length + 16)}`,
    sawPeerLabels: isAdjudication ? true : false,
    ...provenance,
    label: value,
    rationale: `${rater} fixture rationale`,
    ...patch,
  };
}

function createBundle(tempDir, labels) {
  const bundleDir = path.join(tempDir, "bundle");
  const findings = [finding("a"), finding("b")];
  writeJson(path.join(bundleDir, "study.json"), {
    schemaVersion: "cellfence.corpus-evidence-bundle.v1",
    studyId: "label-fixture",
  });
  writeJson(path.join(bundleDir, "sampling.json"), {
    schemaVersion: "cellfence.corpus-sampling.v1",
    sampledFindingIds: findings.map((entry) => entry.findingId),
  });
  writeJsonl(path.join(bundleDir, "findings.normalized.jsonl"), findings);
  writeJsonl(path.join(bundleDir, "labels.jsonl"), labels(findings));
  writeSha256Sums(bundleDir);
  return { bundleDir, findings };
}

function createWorklist(tempDir, bundleDir, findings, labels) {
  const worklistDir = path.join(tempDir, "worklist");
  const bundleSha256 = fs.existsSync(path.join(bundleDir, "SHA256SUMS")) ? hashFile(path.join(bundleDir, "SHA256SUMS")) : "0".repeat(64);
  const assignments = labels.filter((entry) => entry.round !== "adjudication").map((entry) => {
    const findingRecord = findings.find((findingEntry) => findingEntry.findingId === entry.findingId);
    const assignment = {
      schemaVersion: "cellfence.precision-label-assignment.v1",
      studyId: "label-fixture",
      bundle: {
        pathHint: path.basename(bundleDir),
        artifactSetSha256: bundleSha256,
        preLabelArtifactSetSha256: null,
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
      evidenceArtifacts: evidenceArtifacts(bundleDir),
      finding: {
        findingId: entry.findingId,
        subjectId: findingRecord?.subjectId || null,
        ruleId: findingRecord?.ruleId || null,
      },
      allowedLabels: ["true_positive", "false_positive", "needs_policy", "needs_review", "invalid_setup", "out_of_scope"],
      labelTemplate: {
        schemaVersion: "cellfence.corpus-label.v1",
        studyId: "label-fixture",
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
  writeJson(path.join(worklistDir, "worklist.json"), {
    schemaVersion: "cellfence.precision-label-worklist.v1",
    createdBy: "test",
    studyId: "label-fixture",
    bundle: {
      pathHint: path.basename(bundleDir),
      artifactSetSha256: bundleSha256,
      preLabelArtifactSetSha256: null,
    },
    filters: {
      includedRules: [],
      blockingSeverities: ["error"],
      allowExistingLabels: false,
    },
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
  });
  writeSha256Sums(worklistDir);
  return worklistDir;
}

test("precision labels validator accepts independent labels plus separate adjudication", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-ok-"));
  try {
    const { bundleDir } = createBundle(tempDir, (findings) => [
      label(findings[0].findingId, "reviewer-a", "true_positive"),
      label(findings[0].findingId, "reviewer-b", "true_positive"),
      label(findings[1].findingId, "reviewer-a", "true_positive"),
      label(findings[1].findingId, "reviewer-b", "false_positive"),
      label(findings[1].findingId, "adjudicator-c", "needs_policy", { role: "adjudicator" }),
    ]);

    const result = runValidator(["--bundle", bundleDir]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.summary.fullyLabeledFindings, 2);
    assert.equal(report.summary.adjudicatedFindings, 1);
    assert.equal(report.summary.finalLabelCounts.true_positive, 1);
    assert.equal(report.summary.finalLabelCounts.needs_policy, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects independent labels without blind metadata", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-blind-missing-"));
  try {
    const { bundleDir } = createBundle(tempDir, (findings) => [
      {
        schemaVersion: "cellfence.corpus-label.v1",
        studyId: "label-fixture",
        findingId: findings[0].findingId,
        rater: "reviewer-a",
        label: "true_positive",
        rationale: "missing blind fields",
      },
      label(findings[0].findingId, "reviewer-b", "true_positive"),
      label(findings[1].findingId, "reviewer-a", "true_positive"),
      label(findings[1].findingId, "reviewer-b", "true_positive"),
    ]);

    const result = runValidator(["--bundle", bundleDir]);

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /missing assignmentId|independent label must use round/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects unexpected fields in label rows", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-extra-field-"));
  try {
    const { bundleDir } = createBundle(tempDir, (findings) => [
      { ...label(findings[0].findingId, "reviewer-a", "true_positive"), peerLabels: ["false_positive"] },
      label(findings[0].findingId, "reviewer-b", "true_positive"),
      label(findings[1].findingId, "reviewer-a", "true_positive"),
      label(findings[1].findingId, "reviewer-b", "true_positive"),
    ]);

    const result = runValidator(["--bundle", bundleDir]);

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /labels\.jsonl:1 has unexpected field peerLabels/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects two first-round labels for the same finding", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-two-first-"));
  try {
    const { bundleDir } = createBundle(tempDir, (findings) => [
      label(findings[0].findingId, "reviewer-a", "true_positive", { round: "blind_first" }),
      label(findings[0].findingId, "reviewer-b", "true_positive", { round: "blind_first" }),
      label(findings[1].findingId, "reviewer-a", "true_positive"),
      label(findings[1].findingId, "reviewer-b", "true_positive"),
    ]);

    const result = runValidator(["--bundle", bundleDir]);

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /exactly one blind_first and one blind_second/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects second-round labels that saw peer labels", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-peer-visible-"));
  try {
    const { bundleDir } = createBundle(tempDir, (findings) => [
      label(findings[0].findingId, "reviewer-a", "true_positive"),
      label(findings[0].findingId, "reviewer-b", "true_positive", { sawPeerLabels: true }),
      label(findings[1].findingId, "reviewer-a", "true_positive"),
      label(findings[1].findingId, "reviewer-b", "true_positive"),
    ]);

    const result = runValidator(["--bundle", bundleDir]);

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /sawPeerLabels=false/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects incomplete independent labeling", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-missing-"));
  try {
    const { bundleDir } = createBundle(tempDir, (findings) => [
      label(findings[0].findingId, "reviewer-a", "true_positive"),
      label(findings[1].findingId, "reviewer-a", "true_positive"),
      label(findings[1].findingId, "reviewer-b", "true_positive"),
    ]);

    const result = runValidator(["--bundle", bundleDir]);

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.match(report.issues.join("\n"), /1 independent labels; 2 required/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator enforces optional rater provenance constraints", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-rater-"));
  try {
    const { bundleDir } = createBundle(tempDir, (findings) => [
      label(findings[0].findingId, "agent-blind-first", "true_positive", { raterType: "agent" }),
      label(findings[0].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
      label(findings[1].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(findings[1].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
    ]);

    const result = runValidator([
      "--bundle",
      bundleDir,
      "--allowed-rater-types",
      "human",
      "--disallow-non-human-raters",
    ]);

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /raterType\/raterClass agent is not allowed/);
    assert.match(report.issues.join("\n"), /appears non-human/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator binds independent labels to sealed worklist assignments", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-worklist-"));
  try {
    const { bundleDir, findings } = createBundle(tempDir, (entries) => [
      label(entries[0].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[0].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
    ]);
    const labels = readJsonl(path.join(bundleDir, "labels.jsonl"));
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);

    const accepted = runValidator(["--bundle", bundleDir, "--worklist", worklistDir]);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    const acceptedReport = JSON.parse(accepted.stdout);
    assert.equal(acceptedReport.worklist.assignments, 4);

    labels[0].assignmentId = "fabricated-assignment";
    writeJsonl(path.join(bundleDir, "labels.jsonl"), labels);
    const rejected = runValidator(["--bundle", bundleDir, "--worklist", worklistDir]);

    assert.equal(rejected.status, 1);
    const rejectedReport = JSON.parse(rejected.stdout);
    assert.match(rejectedReport.issues.join("\n"), /no sealed worklist assignment fabricated-assignment/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects prefilled sealed worklist label templates", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-worklist-template-"));
  try {
    const { bundleDir, findings } = createBundle(tempDir, (entries) => [
      label(entries[0].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[0].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
    ]);
    const labels = readJsonl(path.join(bundleDir, "labels.jsonl"));
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const worklist = readJson(path.join(worklistDir, "worklist.json"));
    const assignmentPath = path.join(worklistDir, worklist.assignments[0].path);
    const assignment = readJson(assignmentPath);
    assignment.labelTemplate.label = "true_positive";
    assignment.labelTemplate.rationale = "pre-filled answer";
    writeJson(assignmentPath, assignment);
    writeSha256Sums(worklistDir);

    const result = runValidator(["--bundle", bundleDir, "--worklist", worklistDir]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /labelTemplate\.label must be empty/);
    assert.match(report.issues.join("\n"), /labelTemplate\.rationale must be empty/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects symlinked worklist assignment paths", () => {
  if (process.platform === "win32") return;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-worklist-symlink-"));
  try {
    const { bundleDir, findings } = createBundle(tempDir, (entries) => [
      label(entries[0].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[0].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
    ]);
    const labels = readJsonl(path.join(bundleDir, "labels.jsonl"));
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const worklist = readJson(path.join(worklistDir, "worklist.json"));
    const assignmentPath = path.join(worklistDir, worklist.assignments[0].path);
    const outsidePath = path.join(tempDir, "outside-assignment.json");
    fs.copyFileSync(assignmentPath, outsidePath);
    fs.rmSync(assignmentPath);
    fs.symlinkSync(outsidePath, assignmentPath);
    writeSha256Sums(worklistDir);

    const result = runValidator(["--bundle", bundleDir, "--worklist", worklistDir]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /worklist contains symlink/);
    assert.match(report.issues.join("\n"), /regular file listed in worklist SHA256SUMS/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects undeclared sealed worklist files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-worklist-extra-"));
  try {
    const { bundleDir, findings } = createBundle(tempDir, (entries) => [
      label(entries[0].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[0].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
    ]);
    const labels = readJsonl(path.join(bundleDir, "labels.jsonl"));
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    writeJsonl(path.join(worklistDir, "answer-key.jsonl"), labels);
    writeSha256Sums(worklistDir);

    const result = runValidator(["--bundle", bundleDir, "--worklist", worklistDir]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /undeclared sealed file: answer-key\.jsonl/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects answer material embedded in declared worklist files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-worklist-embedded-"));
  try {
    const { bundleDir, findings } = createBundle(tempDir, (entries) => [
      label(entries[0].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[0].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
    ]);
    const labels = readJsonl(path.join(bundleDir, "labels.jsonl"));
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const worklistPath = path.join(worklistDir, "worklist.json");
    const worklist = readJson(worklistPath);
    worklist.answerKey = labels;
    writeJson(worklistPath, worklist);
    const assignmentPath = path.join(worklistDir, worklist.assignments[0].path);
    const assignment = readJson(assignmentPath);
    assignment.allowedLabels = ["true_positive"];
    assignment.finding.message = "answer: true_positive";
    assignment.peerLabels = labels;
    writeJson(assignmentPath, assignment);
    writeSha256Sums(worklistDir);

    const result = runValidator(["--bundle", bundleDir, "--worklist", worklistDir]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /worklist\.json has unexpected field answerKey/);
    assert.match(report.issues.join("\n"), /allowedLabels must exactly match the canonical label set/);
    assert.match(report.issues.join("\n"), /finding\.message does not match the sealed bundle finding/);
    assert.match(report.issues.join("\n"), /unexpected field peerLabels/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects answer material in structural worklist identifiers", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-worklist-structural-"));
  try {
    const { bundleDir, findings } = createBundle(tempDir, (entries) => [
      label(entries[0].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[0].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
    ]);
    const labels = readJsonl(path.join(bundleDir, "labels.jsonl"));
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const worklistPath = path.join(worklistDir, "worklist.json");
    const worklist = readJson(worklistPath);
    const originalPath = worklist.assignments[0].path;
    const assignmentPath = path.join(worklistDir, originalPath);
    const assignment = readJson(assignmentPath);
    const leakedAssignmentId = "assignment-true_positive";
    const leakedRater = "reviewer-answer";

    worklist.raters[0].rater = leakedRater;
    worklist.assignments[0].assignmentId = leakedAssignmentId;
    worklist.assignments[0].rater = leakedRater;
    assignment.assignment.assignmentId = leakedAssignmentId;
    assignment.assignment.rater = leakedRater;
    assignment.labelTemplate.assignmentId = leakedAssignmentId;
    assignment.labelTemplate.rater = leakedRater;
    labels[0].assignmentId = leakedAssignmentId;
    labels[0].rater = leakedRater;

    writeJson(worklistPath, worklist);
    writeJson(assignmentPath, assignment);
    writeJsonl(path.join(bundleDir, "labels.jsonl"), labels);
    writeSha256Sums(worklistDir);

    const result = runValidator(["--bundle", bundleDir, "--worklist", worklistDir]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /assignmentId contains label\/answer-suggestive text/);
    assert.match(report.issues.join("\n"), /rater contains label\/answer-suggestive text/);
    assert.match(report.issues.join("\n"), /assignmentId does not match the generator-derived assignment id/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects inconsistent claim-bound worklist manifests", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-worklist-manifest-"));
  try {
    const { bundleDir, findings } = createBundle(tempDir, (entries) => [
      label(entries[0].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[0].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
    ]);
    const labels = readJsonl(path.join(bundleDir, "labels.jsonl"));
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const worklistPath = path.join(worklistDir, "worklist.json");
    const worklist = readJson(worklistPath);

    worklist.filters.allowExistingLabels = true;
    worklist.summary.existingLabelsInBundle = 4;
    worklist.summary.assignments = 1;
    worklist.summary.selectedFindings = 1;
    worklist.raters.pop();
    writeJson(worklistPath, worklist);
    writeSha256Sums(worklistDir);

    const result = runValidator(["--bundle", bundleDir, "--worklist", worklistDir]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /allowExistingLabels must be false/);
    assert.match(report.issues.join("\n"), /existingLabelsInBundle must be 0/);
    assert.match(report.issues.join("\n"), /summary\.assignments does not match assignment count/);
    assert.match(report.issues.join("\n"), /summary\.selectedFindings does not match selected finding count/);
    assert.match(report.issues.join("\n"), /rater\/round is not declared in worklist\.raters/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects per-finding rater identity drift in worklists", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-worklist-rater-drift-"));
  try {
    const { bundleDir, findings } = createBundle(tempDir, (entries) => [
      label(entries[0].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[0].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
    ]);
    const labels = readJsonl(path.join(bundleDir, "labels.jsonl"));
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const worklistPath = path.join(worklistDir, "worklist.json");
    const worklist = readJson(worklistPath);
    const driftIndex = worklist.assignments.findIndex((entry) => entry.findingId === findings[1].findingId && entry.round === "blind_first");
    const driftEntry = worklist.assignments[driftIndex];
    const assignmentPath = path.join(worklistDir, driftEntry.path);
    const assignment = readJson(assignmentPath);

    worklist.raters.push({ rater: "reviewer-a-02", raterType: "human", round: "blind_first" });
    driftEntry.rater = "reviewer-a-02";
    assignment.assignment.rater = "reviewer-a-02";
    assignment.labelTemplate.rater = "reviewer-a-02";
    const driftLabel = labels.find((entry) => entry.findingId === findings[1].findingId && entry.round === "blind_first");
    driftLabel.rater = "reviewer-a-02";

    writeJson(worklistPath, worklist);
    writeJson(assignmentPath, assignment);
    writeJsonl(path.join(bundleDir, "labels.jsonl"), labels);
    writeSha256Sums(worklistDir);

    const result = runValidator(["--bundle", bundleDir, "--worklist", worklistDir]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /exactly 2 global blind rater/);
    assert.match(report.issues.join("\n"), /rater does not match the global blind_first rater/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects per-finding rater type drift in worklists", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-worklist-rater-type-drift-"));
  try {
    const { bundleDir, findings } = createBundle(tempDir, (entries) => [
      label(entries[0].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[0].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
    ]);
    const labels = readJsonl(path.join(bundleDir, "labels.jsonl"));
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const worklistPath = path.join(worklistDir, "worklist.json");
    const worklist = readJson(worklistPath);
    const driftEntry = worklist.assignments.find((entry) => entry.findingId === findings[1].findingId && entry.round === "blind_first");
    const assignmentPath = path.join(worklistDir, driftEntry.path);
    const assignment = readJson(assignmentPath);

    driftEntry.raterType = "organization";
    assignment.assignment.raterType = "organization";
    assignment.labelTemplate.raterType = "organization";
    const driftLabel = labels.find((entry) => entry.findingId === findings[1].findingId && entry.round === "blind_first");
    driftLabel.raterType = "organization";

    writeJson(worklistPath, worklist);
    writeJson(assignmentPath, assignment);
    writeJsonl(path.join(bundleDir, "labels.jsonl"), labels);
    writeSha256Sums(worklistDir);

    const result = runValidator(["--bundle", bundleDir, "--worklist", worklistDir]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /raterType does not match the global blind_first raterType/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects unsafe or duplicate worklist SHA256SUMS paths", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-worklist-sums-"));
  try {
    const { bundleDir, findings } = createBundle(tempDir, (entries) => [
      label(entries[0].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[0].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
    ]);
    const labels = readJsonl(path.join(bundleDir, "labels.jsonl"));
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const sumsPath = path.join(worklistDir, "SHA256SUMS");
    const firstLine = fs.readFileSync(sumsPath, "utf8").split(/\r?\n/).find(Boolean);
    fs.appendFileSync(sumsPath, `${firstLine}\n${"0".repeat(64)}  ../answer-key.json\n`);

    const result = runValidator(["--bundle", bundleDir, "--worklist", worklistDir]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /duplicates/);
    assert.match(report.issues.join("\n"), /unsafe path \.\.\/answer-key\.json/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator requires worklist assignments to carry sealed evidence references", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-worklist-evidence-"));
  try {
    const { bundleDir, findings } = createBundle(tempDir, (entries) => [
      label(entries[0].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[0].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
    ]);
    const labels = readJsonl(path.join(bundleDir, "labels.jsonl"));
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const worklist = readJson(path.join(worklistDir, "worklist.json"));
    const assignmentPath = path.join(worklistDir, worklist.assignments[0].path);
    const assignment = readJson(assignmentPath);
    assignment.evidenceArtifacts = { bundleFiles: {}, subject: {} };
    writeJson(assignmentPath, assignment);
    writeSha256Sums(worklistDir);

    const result = runValidator(["--bundle", bundleDir, "--worklist", worklistDir]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /evidenceArtifacts\.bundleFiles\.normalizedFindings does not match the sealed bundle artifact/);
    assert.match(report.issues.join("\n"), /evidenceArtifacts\.bundleFiles\.sampling does not match the sealed bundle artifact/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects answer material in worklist metadata and rater types", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-worklist-metadata-"));
  try {
    const { bundleDir, findings } = createBundle(tempDir, (entries) => [
      label(entries[0].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[0].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
    ]);
    const labels = readJsonl(path.join(bundleDir, "labels.jsonl"));
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);
    const worklistPath = path.join(worklistDir, "worklist.json");
    const worklist = readJson(worklistPath);
    const assignmentPath = path.join(worklistDir, worklist.assignments[0].path);
    const assignment = readJson(assignmentPath);

    worklist.bundle.artifactSetSha256 = "answer:true_positive";
    worklist.bundle.preLabelArtifactSetSha256 = "answer:false_positive";
    worklist.filters.includedRules = ["answer:true_positive"];
    worklist.raters[0].raterType = "answer:true_positive";
    assignment.bundle.artifactSetSha256 = "answer:true_positive";
    assignment.bundle.preLabelArtifactSetSha256 = "answer:false_positive";
    assignment.assignment.raterType = "answer:true_positive";
    assignment.labelTemplate.schemaVersion = "answer:true_positive";
    assignment.labelTemplate.studyId = "answer:false_positive";
    assignment.labelTemplate.role = "answer:true_positive";
    assignment.labelTemplate.raterType = "answer:true_positive";
    labels[0].raterType = "answer:true_positive";

    writeJson(worklistPath, worklist);
    writeJson(assignmentPath, assignment);
    writeJsonl(path.join(bundleDir, "labels.jsonl"), labels);
    writeSha256Sums(worklistDir);

    const result = runValidator(["--bundle", bundleDir, "--worklist", worklistDir]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /worklist\.bundle\.artifactSetSha256 must be a lowercase 64-hex/);
    assert.match(report.issues.join("\n"), /worklist\.filters\.includedRules\[0\] contains label\/answer-suggestive text/);
    assert.match(report.issues.join("\n"), /worklist\.raters\[0\]\.raterType must be one of/);
    assert.match(report.issues.join("\n"), /assignment\.raterType must be one of/);
    assert.match(report.issues.join("\n"), /labelTemplate\.schemaVersion contains label\/answer-suggestive text/);
    assert.match(report.issues.join("\n"), /labelTemplate\.studyId contains label\/answer-suggestive text/);
    assert.match(report.issues.join("\n"), /labelTemplate\.role contains label\/answer-suggestive text/);
    assert.match(report.issues.join("\n"), /labelTemplate\.raterType must be one of/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects answer material and loose types in sealed label metadata", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-worklist-label-metadata-"));
  try {
    const { bundleDir, findings } = createBundle(tempDir, (entries) => [
      label(entries[0].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[0].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
    ]);
    const labels = readJsonl(path.join(bundleDir, "labels.jsonl"));
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);

    labels[0].role = "answer:false_positive";
    labels[1].raterClass = "answer:true_positive";
    labels[2].sourceBundleContainsLabels = "false";
    labels[3].adjudication = "false";
    writeJsonl(path.join(bundleDir, "labels.jsonl"), labels);

    const result = runValidator(["--bundle", bundleDir, "--worklist", worklistDir]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    const issues = report.issues.join("\n");
    assert.match(issues, /role contains label\/answer-suggestive text/);
    assert.match(issues, /raterClass is not allowed for sealed claim labels/);
    assert.match(issues, /must not declare both raterType and raterClass/);
    assert.match(issues, /sourceBundleContainsLabels must be a boolean/);
    assert.match(issues, /adjudication must be a boolean/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("precision labels validator rejects adjudication in worklist-bound v1 readiness", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-labels-worklist-adjudication-"));
  try {
    const { bundleDir, findings } = createBundle(tempDir, (entries) => [
      label(entries[0].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[0].findingId, "reviewer-b", "false_positive", { raterType: "human" }),
      label(entries[0].findingId, "adjudicator-c", "true_positive", { role: "adjudicator", raterType: "human" }),
      label(entries[1].findingId, "reviewer-a", "true_positive", { raterType: "human" }),
      label(entries[1].findingId, "reviewer-b", "true_positive", { raterType: "human" }),
    ]);
    const labels = readJsonl(path.join(bundleDir, "labels.jsonl"));
    const worklistDir = createWorklist(tempDir, bundleDir, findings, labels);

    const result = runValidator(["--bundle", bundleDir, "--worklist", worklistDir]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /sealed adjudication worklist/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
