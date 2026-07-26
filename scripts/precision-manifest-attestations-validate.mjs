#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { validateBundle } from "./corpus-evidence-bundle.mjs";
import { appearsNonHumanRater, hashFile, posixify } from "./precision-worklist-lib.mjs";

const schemaVersion = "cellfence.external-manifest-attestations.v1";
const allowedReviewerTypes = new Set(["human", "organization"]);

function usage() {
  console.error(`Usage:
  node scripts/precision-manifest-attestations-validate.mjs --bundle reports/corpus/id-bundle --attestations attestations.json [--out report.json] [--out-corpus reviewed-corpus.json]

Validates externally returned manifest-review attestations against a sealed
evidence bundle. It may write a reviewed corpus only when every required
attestation is valid. It never creates reviewer attestations by itself.`);
}

function parseArgs(argv) {
  const parsed = {
    bundleDir: "",
    attestationsPath: "",
    outPath: "",
    outCorpusPath: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--bundle") {
      parsed.bundleDir = path.resolve(requireValue(argv, index, "--bundle"));
      index += 1;
    } else if (argument.startsWith("--bundle=")) {
      parsed.bundleDir = path.resolve(requireInlineValue(argument, "--bundle=", "--bundle"));
    } else if (argument === "--attestations") {
      parsed.attestationsPath = path.resolve(requireValue(argv, index, "--attestations"));
      index += 1;
    } else if (argument.startsWith("--attestations=")) {
      parsed.attestationsPath = path.resolve(requireInlineValue(argument, "--attestations=", "--attestations"));
    } else if (argument === "--out") {
      parsed.outPath = path.resolve(requireValue(argv, index, "--out"));
      index += 1;
    } else if (argument.startsWith("--out=")) {
      parsed.outPath = path.resolve(requireInlineValue(argument, "--out=", "--out"));
    } else if (argument === "--out-corpus") {
      parsed.outCorpusPath = path.resolve(requireValue(argv, index, "--out-corpus"));
      index += 1;
    } else if (argument.startsWith("--out-corpus=")) {
      parsed.outCorpusPath = path.resolve(requireInlineValue(argument, "--out-corpus=", "--out-corpus"));
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.bundleDir) throw new Error("--bundle is required");
  if (!parsed.attestationsPath) throw new Error("--attestations is required");
  return parsed;
}

function requireValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${optionName} requires a value`);
  return value;
}

function requireInlineValue(argument, prefix, optionName) {
  const value = argument.slice(prefix.length);
  if (!value) throw new Error(`${optionName} requires a value`);
  return value;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(issues, value, allowedKeys, label) {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object`);
    return false;
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${label} has unexpected field ${key}`);
  }
  return true;
}

function validateSha256(issues, value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    issues.push(`${label} must be a lowercase 64-hex SHA-256 digest`);
  }
}

function validateDate(issues, value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    issues.push(`${label} must be YYYY-MM-DD`);
  }
}

function validateReviewerAttestations(issues, reviewers, label) {
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    issues.push(`${label} must contain at least one reviewer attestation`);
    return;
  }
  const reviewerIds = new Set();
  reviewers.forEach((reviewer, index) => {
    const entryLabel = `${label}[${index}]`;
    if (!rejectUnknownKeys(issues, reviewer, ["id", "reviewerType", "raterType", "reviewerClass", "independent"], entryLabel)) return;
    const reviewerType = reviewer.reviewerType || reviewer.raterType || reviewer.reviewerClass;
    if (typeof reviewer.id !== "string" || reviewer.id.length === 0) {
      issues.push(`${entryLabel}.id is required`);
    } else {
      if (reviewerIds.has(reviewer.id)) issues.push(`${entryLabel}.id duplicates another reviewer attestation`);
      reviewerIds.add(reviewer.id);
      if (appearsNonHumanRater(reviewer.id)) {
        issues.push(`${entryLabel}.id appears non-human but external manifest review requires a human/organization reviewer`);
      }
    }
    if (typeof reviewerType !== "string" || !allowedReviewerTypes.has(reviewerType)) {
      issues.push(`${entryLabel}.reviewerType must be one of human, organization`);
    }
    if (reviewer.independent !== true) issues.push(`${entryLabel}.independent must be true`);
  });
}

function subjectKey(subjectId, phase = null) {
  return phase ? `${subjectId}\0${phase}` : subjectId;
}

function manifestCopies(study, bundleDir, issues) {
  const copies = new Map();
  for (const [index, copy] of (study.manifestCopies || []).entries()) {
    if (!copy?.subjectId || !copy?.path) continue;
    const resolved = resolveBundlePath(bundleDir, copy.path, issues, `study.manifestCopies[${index}].path`);
    copies.set(subjectKey(copy.subjectId, copy.phase || null), {
      ...copy,
      actualSha256: resolved && fs.existsSync(resolved) ? hashFile(resolved) : null,
    });
  }
  return copies;
}

function resolveBundlePath(bundleDir, relativePath, issues, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    issues.push(`${label} is required`);
    return null;
  }
  const normalized = posixify(relativePath);
  const segments = normalized.split("/");
  if (
    relativePath.includes("\0")
    || path.isAbsolute(relativePath)
    || segments.includes("")
    || segments.includes(".")
    || segments.includes("..")
  ) {
    issues.push(`${label} has unsafe bundle path: ${relativePath}`);
    return null;
  }
  const root = path.resolve(bundleDir);
  const resolved = path.resolve(root, relativePath);
  const lexicalRelative = path.relative(root, resolved);
  if (lexicalRelative === "" || lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    issues.push(`${label} escapes bundle root: ${relativePath}`);
    return null;
  }
  if (fs.existsSync(resolved)) {
    const realRoot = fs.realpathSync.native(root);
    const realResolved = fs.realpathSync.native(resolved);
    const realRelative = path.relative(realRoot, realResolved);
    if (realRelative === "" || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      issues.push(`${label} resolves outside bundle root: ${relativePath}`);
      return null;
    }
  }
  return resolved;
}

function expectedSubjects(corpus) {
  if (corpus.schemaVersion === "cellfence.history-replay.v1") {
    return (corpus.subjects || []).map((subject) => ({
      subjectId: subject.id,
      phase: "before",
      repository: subject.repository,
      commit: subject.before?.commit || subject.beforeCommit || null,
    }));
  }
  return (corpus.subjects || []).map((subject) => ({
    subjectId: subject.id,
    phase: null,
    repository: subject.repository,
    commit: subject.commit || null,
  }));
}

function validateAttestationShape(issues, attestation, label) {
  if (!rejectUnknownKeys(issues, attestation, [
    "subjectId",
    "phase",
    "repository",
    "commit",
    "manifestCopy",
    "reviewStatus",
    "review",
  ], label)) return false;
  if (typeof attestation.subjectId !== "string" || attestation.subjectId.length === 0) issues.push(`${label}.subjectId is required`);
  if (attestation.phase !== undefined && attestation.phase !== "before") issues.push(`${label}.phase must be omitted or before`);
  if (attestation.repository !== undefined && typeof attestation.repository !== "string") issues.push(`${label}.repository must be a string`);
  if (attestation.commit !== undefined && typeof attestation.commit !== "string") issues.push(`${label}.commit must be a string`);
  if (attestation.reviewStatus !== "reviewed") issues.push(`${label}.reviewStatus must be reviewed`);
  rejectUnknownKeys(issues, attestation.manifestCopy, ["path", "sha256"], `${label}.manifestCopy`);
  rejectUnknownKeys(issues, attestation.review, ["reviewedAt", "scope", "reviewedManifestSha256", "reviewerAttestations"], `${label}.review`);
  validateSha256(issues, attestation.manifestCopy?.sha256, `${label}.manifestCopy.sha256`);
  validateDate(issues, attestation.review?.reviewedAt, `${label}.review.reviewedAt`);
  if (typeof attestation.review?.scope !== "string" || attestation.review.scope.trim().length === 0) {
    issues.push(`${label}.review.scope is required`);
  }
  validateSha256(issues, attestation.review?.reviewedManifestSha256, `${label}.review.reviewedManifestSha256`);
  validateReviewerAttestations(issues, attestation.review?.reviewerAttestations, `${label}.review.reviewerAttestations`);
  return true;
}

function validateAttestations(options) {
  const issues = [];
  try {
    validateBundle(options.bundleDir);
  } catch (error) {
    issues.push(...String(error instanceof Error ? error.message : error).split(/\r?\n/).filter(Boolean).map((issue) => `bundle: ${issue}`));
  }
  const study = readJson(path.join(options.bundleDir, "study.json"));
  const corpus = readJson(path.join(options.bundleDir, "corpus.json"));
  const attestations = readJson(options.attestationsPath);
  if (!rejectUnknownKeys(issues, attestations, ["schemaVersion", "studyId", "bundleArtifactSetSha256", "attestations"], "attestations.json")) {
    return report(options, study, corpus, attestations, issues, null);
  }
  if (attestations.schemaVersion !== schemaVersion) issues.push("attestations.json has unexpected schemaVersion");
  if (attestations.studyId !== study.studyId) issues.push(`attestations studyId ${attestations.studyId} does not match bundle studyId ${study.studyId}`);
  const actualArtifactSetSha256 = fs.existsSync(path.join(options.bundleDir, "SHA256SUMS")) ? hashFile(path.join(options.bundleDir, "SHA256SUMS")) : null;
  if (attestations.bundleArtifactSetSha256 !== undefined) {
    validateSha256(issues, attestations.bundleArtifactSetSha256, "attestations.bundleArtifactSetSha256");
    if (actualArtifactSetSha256 && attestations.bundleArtifactSetSha256 !== actualArtifactSetSha256) {
      issues.push("attestations.bundleArtifactSetSha256 does not match sealed bundle SHA256SUMS");
    }
  }
  if (!Array.isArray(attestations.attestations)) issues.push("attestations.attestations must be an array");

  const copyBySubject = manifestCopies(study, options.bundleDir, issues);
  const expected = expectedSubjects(corpus);
  const expectedByKey = new Map(expected.map((entry) => [subjectKey(entry.subjectId, entry.phase), entry]));
  const seen = new Set();
  const accepted = [];
  for (const [index, attestation] of (attestations.attestations || []).entries()) {
    const label = `attestations.attestations[${index}]`;
    validateAttestationShape(issues, attestation, label);
    const key = subjectKey(attestation.subjectId, attestation.phase || null);
    const expectedSubject = expectedByKey.get(key);
    if (!expectedSubject) {
      issues.push(`${label} references unknown subject/phase ${posixify(key)}`);
      continue;
    }
    if (seen.has(key)) issues.push(`${label} duplicates subject/phase ${posixify(key)}`);
    seen.add(key);
    if (attestation.repository !== undefined && attestation.repository !== expectedSubject.repository) {
      issues.push(`${label}.repository does not match corpus subject`);
    }
    if (attestation.commit !== undefined && expectedSubject.commit && attestation.commit !== expectedSubject.commit) {
      issues.push(`${label}.commit does not match corpus subject`);
    }
    const copy = copyBySubject.get(key);
    if (!copy) {
      issues.push(`${label} has no sealed manifest copy in study.json`);
      continue;
    }
    if (attestation.manifestCopy?.path !== copy.path) issues.push(`${label}.manifestCopy.path does not match sealed manifest copy`);
    if (attestation.manifestCopy?.sha256 !== copy.actualSha256) issues.push(`${label}.manifestCopy.sha256 does not match sealed manifest copy`);
    if (attestation.review?.reviewedManifestSha256 !== copy.actualSha256) {
      issues.push(`${label}.review.reviewedManifestSha256 does not match sealed manifest copy`);
    }
    accepted.push({ key, attestation });
  }
  for (const entry of expected) {
    const key = subjectKey(entry.subjectId, entry.phase);
    if (!seen.has(key)) issues.push(`${posixify(key)} is missing an external manifest attestation`);
  }

  return report(options, study, corpus, attestations, issues, accepted);
}

function report(options, study, corpus, attestations, issues, accepted) {
  const expected = expectedSubjects(corpus);
  const acceptedCount = issues.length === 0 ? accepted.length : 0;
  const output = {
    schemaVersion: "cellfence.external-manifest-attestation-validation.v1",
    generatedAt: new Date().toISOString(),
    ok: issues.length === 0,
    inputs: {
      bundle: posixify(options.bundleDir),
      attestations: posixify(options.attestationsPath),
    },
    studyId: study?.studyId || null,
    summary: {
      requiredSubjects: expected.length,
      attestationRows: Array.isArray(attestations?.attestations) ? attestations.attestations.length : 0,
      acceptedSubjects: acceptedCount,
      missingSubjects: issues.length === 0 ? 0 : Math.max(0, expected.length - (accepted?.length || 0)),
    },
    issues,
  };
  if (issues.length === 0 && options.outCorpusPath) {
    writeJson(options.outCorpusPath, applyAttestationsToCorpus(corpus, accepted));
    output.outputs = { corpus: posixify(options.outCorpusPath) };
  }
  return output;
}

function applyAttestationsToCorpus(corpus, accepted) {
  const byKey = new Map(accepted.map((entry) => [entry.key, entry.attestation]));
  const updated = structuredClone(corpus);
  if (updated.schemaVersion === "cellfence.history-replay.v1") {
    for (const subject of updated.subjects || []) {
      const attestation = byKey.get(subjectKey(subject.id, "before"));
      if (!attestation) continue;
      subject.before.manifest = reviewedManifest(subject.before.manifest || {}, attestation);
      if (subject.after?.manifest) subject.after.manifest.strategy = subject.after.manifest.strategy || "reuse-before";
    }
    return updated;
  }
  for (const subject of updated.subjects || []) {
    const attestation = byKey.get(subjectKey(subject.id, null));
    if (!attestation) continue;
    subject.manifest = reviewedManifest(subject.manifest || {}, attestation);
  }
  return updated;
}

function reviewedManifest(manifest, attestation) {
  const reviewerIds = attestation.review.reviewerAttestations.map((reviewer) => reviewer.id);
  return {
    ...manifest,
    strategy: "copy",
    reviewStatus: "reviewed",
    reviewedBy: reviewerIds,
    review: {
      ...(manifest.review || {}),
      reviewedAt: attestation.review.reviewedAt,
      scope: attestation.review.scope,
      reviewedManifestSha256: attestation.review.reviewedManifestSha256,
      reviewerAttestations: attestation.review.reviewerAttestations,
    },
  };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    const validation = validateAttestations(options);
    if (options.outPath) writeJson(options.outPath, validation);
    else process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
    process.exit(validation.ok ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exit(2);
  }
}

main();
