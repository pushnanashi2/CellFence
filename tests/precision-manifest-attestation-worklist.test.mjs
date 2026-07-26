import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, "scripts", "precision-manifest-attestation-worklist.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

function runWorklist(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function createBundle(tempDir) {
  const bundleDir = path.join(tempDir, "bundle");
  writeJson(path.join(bundleDir, "manifests/subject-a.json"), {
    version: 1,
    cells: [{ id: "a", ownedPaths: ["src/a/**"], publicEntry: "src/a/index.ts" }],
  });
  writeJson(path.join(bundleDir, "manifests/subject-b.json"), {
    version: 1,
    cells: [{ id: "b", ownedPaths: ["src/b/**"], publicEntry: "src/b/index.ts" }],
  });
  const manifestASha = hashFile(path.join(bundleDir, "manifests/subject-a.json"));
  const manifestBSha = hashFile(path.join(bundleDir, "manifests/subject-b.json"));
  writeJson(path.join(bundleDir, "corpus.json"), {
    schemaVersion: "cellfence.corpus.v1",
    subjects: [
      {
        id: "subject-a",
        repository: "https://github.com/example/a.git",
        commit: "a".repeat(40),
        manifest: { strategy: "copy", source: "manifests/a.json", reviewStatus: "reviewed", reviewedBy: ["agent-reviewer"] },
      },
      {
        id: "subject-b",
        repository: "https://github.com/example/b.git",
        commit: "b".repeat(40),
        manifest: { strategy: "copy", source: "manifests/b.json", reviewStatus: "reviewed", reviewedBy: ["agent-reviewer"] },
      },
    ],
  });
  writeJson(path.join(bundleDir, "report.json"), {
    schemaVersion: "cellfence.corpus-study.v1",
    environment: { harnessDirty: false },
    summary: { totalFindings: 0 },
  });
  writeJson(path.join(bundleDir, "sampling.json"), {
    schemaVersion: "cellfence.corpus-sampling.v1",
    sampledFindingIds: [],
  });
  writeJsonl(path.join(bundleDir, "findings.raw.jsonl"), []);
  writeJsonl(path.join(bundleDir, "findings.normalized.jsonl"), []);
  writeJsonl(path.join(bundleDir, "labels.jsonl"), []);
  const study = {
    schemaVersion: "cellfence.corpus-evidence-bundle.v1",
    studyId: "manifest-worklist-fixture",
    environment: { harnessDirty: false },
    summary: { rawFindings: 0, normalizedFindings: 0 },
    preregistration: {},
    manifestCopies: [
      { subjectId: "subject-a", path: "manifests/subject-a.json", sha256: manifestASha },
      { subjectId: "subject-b", path: "manifests/subject-b.json", sha256: manifestBSha },
    ],
    logCopies: [],
  };
  const preLabelArtifacts = listFiles(bundleDir)
    .map((filePath) => path.relative(bundleDir, filePath).replace(/\\/g, "/"))
    .filter((relativePath) => !new Set(["SHA256SUMS", "labels.jsonl", "study.json"]).has(relativePath))
    .sort()
    .map((relativePath) => ({
      path: relativePath,
      sha256: hashFile(path.join(bundleDir, relativePath)),
    }));
  study.preregistration.preLabelArtifactSetSha256 = hashText(canonicalJson(preLabelArtifacts));
  writeJson(path.join(bundleDir, "study.json"), study);
  writeSha256Sums(bundleDir);
  return { bundleDir, manifestASha, manifestBSha };
}

test("manifest attestation worklist creates sealed per-subject assignments", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-worklist-ok-"));
  try {
    const bundle = createBundle(tempDir);
    const outDir = path.join(tempDir, "manifest-worklist");

    const result = runWorklist([
      "--bundle",
      bundle.bundleDir,
      "--out-dir",
      outDir,
      "--reviewers",
      "external-reviewer-a,external-org-review",
      "--reviewer-types",
      "human,organization",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.subjects, 2);
    assert.equal(report.summary.reviewers, 2);
    assert.equal(report.summary.assignments, 4);
    assert.match(report.artifactSetSha256, /^[a-f0-9]{64}$/);
    const worklist = readJson(path.join(outDir, "worklist.json"));
    assert.equal(worklist.assignments.length, 4);
    const assignment = readJson(path.join(outDir, worklist.assignments[0].path));
    assert.equal(assignment.schemaVersion, "cellfence.manifest-attestation-assignment.v1");
    assert.equal(assignment.attestationTemplate.review.reviewerAttestations[0].independent, true);
    assert.equal(assignment.attestationTemplate.review.reviewedManifestSha256, assignment.manifestCopy.sha256);
    assert.equal(fs.existsSync(path.join(outDir, "SHA256SUMS")), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("manifest attestation worklist rejects non-human reviewer identities", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-worklist-agent-"));
  try {
    const bundle = createBundle(tempDir);
    const result = runWorklist([
      "--bundle",
      bundle.bundleDir,
      "--out-dir",
      path.join(tempDir, "manifest-worklist"),
      "--reviewers",
      "codex-agent-reviewer",
      "--reviewer-types",
      "human",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /appears non-human/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("manifest attestation worklist refuses output inside the sealed bundle", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-worklist-overlap-"));
  try {
    const bundle = createBundle(tempDir);
    const result = runWorklist([
      "--bundle",
      bundle.bundleDir,
      "--out-dir",
      path.join(bundle.bundleDir, "worklist"),
      "--reviewers",
      "external-reviewer-a",
      "--reviewer-types",
      "human",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /must not overlap --bundle/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("manifest attestation worklist force only replaces marked output directories", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-worklist-force-"));
  try {
    const bundle = createBundle(tempDir);
    const outDir = path.join(tempDir, "manifest-worklist");
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, "user-file.txt"), "do not delete\n");

    const rejected = runWorklist([
      "--bundle",
      bundle.bundleDir,
      "--out-dir",
      outDir,
      "--reviewers",
      "external-reviewer-a",
      "--reviewer-types",
      "human",
      "--force",
    ]);

    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /refusing to delete unmarked output directory/);

    fs.writeFileSync(path.join(outDir, ".cellfence-manifest-attestation-worklist"), "marker\n");
    const accepted = runWorklist([
      "--bundle",
      bundle.bundleDir,
      "--out-dir",
      outDir,
      "--reviewers",
      "external-reviewer-a",
      "--reviewer-types",
      "human",
      "--force",
    ]);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.equal(fs.existsSync(path.join(outDir, "user-file.txt")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
