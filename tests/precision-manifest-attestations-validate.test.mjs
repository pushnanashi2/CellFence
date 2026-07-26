import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, "scripts", "precision-manifest-attestations-validate.mjs");

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

function runValidator(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function createBundle(tempDir) {
  const bundleDir = path.join(tempDir, "bundle");
  const manifestA = {
    version: 1,
    cells: [
      {
        id: "subject-a",
        ownedPaths: ["src/a/**"],
        publicEntry: "src/a/index.ts",
        dependencies: [],
      },
    ],
  };
  const manifestB = {
    version: 1,
    cells: [
      {
        id: "subject-b",
        ownedPaths: ["src/b/**"],
        publicEntry: "src/b/index.ts",
        dependencies: [],
      },
    ],
  };
  writeJson(path.join(bundleDir, "manifests/subject-a.json"), manifestA);
  writeJson(path.join(bundleDir, "manifests/subject-b.json"), manifestB);
  const manifestASha = hashFile(path.join(bundleDir, "manifests/subject-a.json"));
  const manifestBSha = hashFile(path.join(bundleDir, "manifests/subject-b.json"));
  const corpus = {
    schemaVersion: "cellfence.corpus.v1",
    subjects: [
      {
        id: "subject-a",
        repository: "https://github.com/example/a.git",
        commit: "a".repeat(40),
        manifest: {
          strategy: "copy",
          source: "manifests/a.json",
          reviewStatus: "reviewed",
          reviewedBy: ["agent-reviewer"],
        },
      },
      {
        id: "subject-b",
        repository: "https://github.com/example/b.git",
        commit: "b".repeat(40),
        manifest: {
          strategy: "copy",
          source: "manifests/b.json",
          reviewStatus: "reviewed",
          reviewedBy: ["agent-reviewer"],
        },
      },
    ],
  };
  const study = {
    schemaVersion: "cellfence.corpus-evidence-bundle.v1",
    studyId: "manifest-attestation-fixture",
    environment: {
      harnessDirty: false,
    },
    summary: {
      rawFindings: 0,
      normalizedFindings: 0,
    },
    preregistration: {},
    manifestCopies: [
      {
        subjectId: "subject-a",
        path: "manifests/subject-a.json",
        sha256: manifestASha,
      },
      {
        subjectId: "subject-b",
        path: "manifests/subject-b.json",
        sha256: manifestBSha,
      },
    ],
    logCopies: [],
  };
  writeJson(path.join(bundleDir, "corpus.json"), corpus);
  writeJson(path.join(bundleDir, "report.json"), {
    schemaVersion: "cellfence.corpus-study.v1",
    environment: study.environment,
    summary: {
      totalFindings: 0,
    },
  });
  writeJson(path.join(bundleDir, "sampling.json"), {
    schemaVersion: "cellfence.corpus-sampling.v1",
    sampledFindingIds: [],
  });
  writeJsonl(path.join(bundleDir, "findings.raw.jsonl"), []);
  writeJsonl(path.join(bundleDir, "findings.normalized.jsonl"), []);
  writeJsonl(path.join(bundleDir, "labels.jsonl"), []);
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
  return {
    bundleDir,
    manifestASha,
    manifestBSha,
    bundleArtifactSetSha256: hashFile(path.join(bundleDir, "SHA256SUMS")),
  };
}

function validAttestations(bundle) {
  return {
    schemaVersion: "cellfence.external-manifest-attestations.v1",
    studyId: "manifest-attestation-fixture",
    bundleArtifactSetSha256: bundle.bundleArtifactSetSha256,
    attestations: [
      {
        subjectId: "subject-a",
        repository: "https://github.com/example/a.git",
        commit: "a".repeat(40),
        manifestCopy: {
          path: "manifests/subject-a.json",
          sha256: bundle.manifestASha,
        },
        reviewStatus: "reviewed",
        review: {
          reviewedAt: "2026-07-26",
          scope: "package/workspace boundary manifest review",
          reviewedManifestSha256: bundle.manifestASha,
          reviewerAttestations: [
            {
              id: "external-reviewer-a",
              reviewerType: "human",
              independent: true,
            },
          ],
        },
      },
      {
        subjectId: "subject-b",
        repository: "https://github.com/example/b.git",
        commit: "b".repeat(40),
        manifestCopy: {
          path: "manifests/subject-b.json",
          sha256: bundle.manifestBSha,
        },
        reviewStatus: "reviewed",
        review: {
          reviewedAt: "2026-07-26",
          scope: "package/workspace boundary manifest review",
          reviewedManifestSha256: bundle.manifestBSha,
          reviewerAttestations: [
            {
              id: "external-org-review",
              reviewerType: "organization",
              independent: true,
            },
          ],
        },
      },
    ],
  };
}

test("manifest attestation validator accepts sealed external attestations and writes reviewed corpus", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-attest-ok-"));
  try {
    const bundle = createBundle(tempDir);
    const attestationsPath = path.join(tempDir, "attestations.json");
    const outCorpusPath = path.join(tempDir, "reviewed-corpus.json");
    writeJson(attestationsPath, validAttestations(bundle));

    const result = runValidator([
      "--bundle",
      bundle.bundleDir,
      "--attestations",
      attestationsPath,
      "--out-corpus",
      outCorpusPath,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.summary.acceptedSubjects, 2);
    const reviewedCorpus = readJson(outCorpusPath);
    assert.equal(reviewedCorpus.subjects[0].manifest.review.reviewedManifestSha256, bundle.manifestASha);
    assert.deepEqual(reviewedCorpus.subjects[0].manifest.reviewedBy, ["external-reviewer-a"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("manifest attestation validator rejects non-human reviewer identities", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-attest-agent-"));
  try {
    const bundle = createBundle(tempDir);
    const attestations = validAttestations(bundle);
    attestations.attestations[0].review.reviewerAttestations[0].id = "codex-agent-reviewer";
    const attestationsPath = path.join(tempDir, "attestations.json");
    writeJson(attestationsPath, attestations);

    const result = runValidator(["--bundle", bundle.bundleDir, "--attestations", attestationsPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /appears non-human/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("manifest attestation validator rejects manifest hash mismatches", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-attest-hash-"));
  try {
    const bundle = createBundle(tempDir);
    const attestations = validAttestations(bundle);
    attestations.attestations[1].review.reviewedManifestSha256 = "0".repeat(64);
    const attestationsPath = path.join(tempDir, "attestations.json");
    writeJson(attestationsPath, attestations);

    const result = runValidator(["--bundle", bundle.bundleDir, "--attestations", attestationsPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /reviewedManifestSha256 does not match sealed manifest copy/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("manifest attestation validator rejects missing subject attestations", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-manifest-attest-missing-"));
  try {
    const bundle = createBundle(tempDir);
    const attestations = validAttestations(bundle);
    attestations.attestations.pop();
    const attestationsPath = path.join(tempDir, "attestations.json");
    writeJson(attestationsPath, attestations);

    const result = runValidator(["--bundle", bundle.bundleDir, "--attestations", attestationsPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.issues.join("\n"), /subject-b is missing an external manifest attestation/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
