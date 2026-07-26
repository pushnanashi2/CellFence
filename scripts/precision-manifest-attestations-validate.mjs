#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { validateBundle } from "./corpus-evidence-bundle.mjs";
import { appearsNonHumanRater, hashFile, posixify } from "./precision-worklist-lib.mjs";

const schemaVersion = "cellfence.external-manifest-attestations.v1";
const allowedReviewerTypes = new Set(["human", "organization"]);

function usage() {
  console.error(`Usage:
  node scripts/precision-manifest-attestations-validate.mjs --bundle reports/corpus/id-bundle --attestations attestations.json [--worklist reports/corpus/id-manifest-review-worklist] [--expected-worklist-artifact-set-sha256 sha256] [--out report.json] [--out-corpus reviewed-corpus.json]

Validates externally returned manifest-review attestations against a sealed
evidence bundle. It may write a reviewed corpus only when every required
attestation is valid. When --worklist is supplied, attestations.json must include
the returned worklistArtifactSetSha256 and it must match the sealed worklist
SHA256SUMS digest. It never creates reviewer attestations by itself.`);
}

function parseArgs(argv) {
  const parsed = {
    bundleDir: "",
    attestationsPath: "",
    worklistDir: "",
    expectedWorklistArtifactSetSha256: "",
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
    } else if (argument === "--worklist") {
      parsed.worklistDir = path.resolve(requireValue(argv, index, "--worklist"));
      index += 1;
    } else if (argument.startsWith("--worklist=")) {
      parsed.worklistDir = path.resolve(requireInlineValue(argument, "--worklist=", "--worklist"));
    } else if (argument === "--expected-worklist-artifact-set-sha256") {
      parsed.expectedWorklistArtifactSetSha256 = requireValue(argv, index, "--expected-worklist-artifact-set-sha256");
      index += 1;
    } else if (argument.startsWith("--expected-worklist-artifact-set-sha256=")) {
      parsed.expectedWorklistArtifactSetSha256 = requireInlineValue(argument, "--expected-worklist-artifact-set-sha256=", "--expected-worklist-artifact-set-sha256");
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

function reviewerKey(id, reviewerType) {
  return `${id}\0${reviewerType}`;
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

function resolveWorklistPath(worklistDir, relativePath, issues, label) {
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
    issues.push(`${label} has unsafe worklist path: ${relativePath}`);
    return null;
  }
  const root = path.resolve(worklistDir);
  const resolved = path.resolve(root, relativePath);
  const lexicalRelative = path.relative(root, resolved);
  if (lexicalRelative === "" || lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    issues.push(`${label} escapes worklist root: ${relativePath}`);
    return null;
  }
  return resolved;
}

function listFilesRecursive(baseDir, issues = [], rootDir = baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isSymbolicLink()) {
      issues.push(`worklist contains symlink: ${posixify(path.relative(rootDir, fullPath))}`);
    } else if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath, issues, rootDir));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function readSha256Sums(baseDir, issues) {
  const sumsPath = path.join(baseDir, "SHA256SUMS");
  if (!fs.existsSync(sumsPath)) {
    issues.push("worklist SHA256SUMS is missing");
    return new Map();
  }
  const sums = new Map();
  for (const [index, line] of fs.readFileSync(sumsPath, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      issues.push(`worklist SHA256SUMS:${index + 1} is malformed`);
      continue;
    }
    const relativePath = match[2];
    if (sums.has(relativePath)) issues.push(`worklist SHA256SUMS:${index + 1} duplicates ${relativePath}`);
    resolveWorklistPath(baseDir, relativePath, issues, `worklist SHA256SUMS:${index + 1}`);
    sums.set(relativePath, match[1]);
  }
  return sums;
}

function validateWorklistSha256Sums(worklistDir, issues) {
  const expected = readSha256Sums(worklistDir, issues);
  const artifactSetSha256 = fs.existsSync(path.join(worklistDir, "SHA256SUMS")) ? hashFile(path.join(worklistDir, "SHA256SUMS")) : null;
  if (expected.size === 0) {
    issues.push("worklist SHA256SUMS must list sealed worklist files");
    return { artifactSetSha256, hashedFiles: new Set() };
  }
  const actualFiles = listFilesRecursive(worklistDir, issues)
    .filter((filePath) => path.basename(filePath) !== "SHA256SUMS")
    .map((filePath) => posixify(path.relative(worklistDir, filePath)))
    .sort();
  const expectedFiles = [...expected.keys()].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    issues.push("worklist SHA256SUMS file list does not match worklist contents");
    return { artifactSetSha256, hashedFiles: new Set(expectedFiles) };
  }
  for (const relativePath of actualFiles) {
    if (hashFile(path.join(worklistDir, relativePath)) !== expected.get(relativePath)) {
      issues.push(`worklist SHA256 mismatch for ${relativePath}`);
    }
  }
  return { artifactSetSha256, hashedFiles: new Set(expectedFiles) };
}

function readWorklist(worklistDir, bundleArtifactSetSha256, issues) {
  if (!worklistDir) return null;
  const hashValidation = validateWorklistSha256Sums(worklistDir, issues);
  const worklistPath = path.join(worklistDir, "worklist.json");
  if (!fs.existsSync(worklistPath)) {
    issues.push("worklist.json is missing");
    return {
      path: worklistDir,
      artifactSetSha256: hashValidation.artifactSetSha256,
      assignments: 0,
      reviewersBySubject: new Map(),
    };
  }
  const worklist = readJson(worklistPath);
  if (!isRecord(worklist)) {
    issues.push("worklist.json must be an object");
    return {
      path: worklistDir,
      artifactSetSha256: hashValidation.artifactSetSha256,
      assignments: 0,
      reviewersBySubject: new Map(),
    };
  }
  if (worklist.schemaVersion !== "cellfence.manifest-attestation-worklist.v1") {
    issues.push("worklist.json has unexpected schemaVersion");
  }
  if (worklist.bundle?.artifactSetSha256 !== bundleArtifactSetSha256) {
    issues.push("worklist bundle artifactSetSha256 does not match sealed bundle");
  }
  if (!Array.isArray(worklist.assignments)) issues.push("worklist.assignments must be an array");
  const assignments = Array.isArray(worklist.assignments) ? worklist.assignments : [];
  validateDeclaredWorklistFiles(hashValidation.hashedFiles, assignments, issues);
  if (worklist.summary?.assignments !== assignments.length) {
    issues.push(`worklist.summary.assignments does not match assignment count: expected ${assignments.length}, got ${worklist.summary?.assignments}`);
  }
  const reviewersBySubject = new Map();
  for (const [index, assignment] of assignments.entries()) {
    const label = `worklist.assignments[${index}]`;
    if (!isRecord(assignment)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    validateAssignmentPacket(worklistDir, assignment, worklist, hashValidation.hashedFiles, label, issues);
    const key = subjectKey(assignment.subjectId, assignment.phase || null);
    if (!assignment.assignmentId || typeof assignment.assignmentId !== "string") issues.push(`${label}.assignmentId is required`);
    if (!assignment.path || typeof assignment.path !== "string") issues.push(`${label}.path is required`);
    if (!assignment.subjectId || typeof assignment.subjectId !== "string") issues.push(`${label}.subjectId is required`);
    if (assignment.phase !== null && assignment.phase !== undefined && assignment.phase !== "before") issues.push(`${label}.phase must be null, omitted, or before`);
    if (!assignment.reviewer || typeof assignment.reviewer !== "string") issues.push(`${label}.reviewer is required`);
    if (!allowedReviewerTypes.has(assignment.reviewerType)) issues.push(`${label}.reviewerType must be human or organization`);
    if (appearsNonHumanRater(assignment.reviewer)) issues.push(`${label}.reviewer appears non-human`);
    const reviewers = reviewersBySubject.get(key) || new Map();
    const keyForReviewer = reviewerKey(assignment.reviewer, assignment.reviewerType);
    if (reviewers.has(keyForReviewer)) issues.push(`${label} duplicates reviewer assignment for ${assignment.subjectId}`);
    reviewers.set(keyForReviewer, {
      id: assignment.reviewer,
      reviewerType: assignment.reviewerType,
    });
    reviewersBySubject.set(key, reviewers);
  }
  return {
    path: worklistDir,
    artifactSetSha256: hashValidation.artifactSetSha256,
    assignments: assignments.length,
    reviewersBySubject,
  };
}

function validateExpectedWorklistArtifactSetSha256(options, worklist, issues) {
  if (!options.expectedWorklistArtifactSetSha256) return;
  validateSha256(issues, options.expectedWorklistArtifactSetSha256, "--expected-worklist-artifact-set-sha256");
  if (!options.worklistDir) {
    issues.push("--expected-worklist-artifact-set-sha256 requires --worklist");
    return;
  }
  if (worklist?.artifactSetSha256 && worklist.artifactSetSha256 !== options.expectedWorklistArtifactSetSha256) {
    issues.push("worklist artifactSetSha256 does not match --expected-worklist-artifact-set-sha256");
  }
}

function validateDeclaredWorklistFiles(hashedFiles, assignments, issues) {
  const declaredFiles = new Set([".cellfence-manifest-attestation-worklist", "worklist.json"]);
  for (const assignment of assignments) {
    if (assignment?.path && typeof assignment.path === "string") declaredFiles.add(posixify(assignment.path));
  }
  for (const relativePath of hashedFiles) {
    if (!declaredFiles.has(relativePath)) {
      issues.push(`worklist contains undeclared sealed file: ${relativePath}`);
    }
  }
  for (const relativePath of declaredFiles) {
    if (!hashedFiles.has(relativePath)) {
      issues.push(`worklist declared file is missing from SHA256SUMS: ${relativePath}`);
    }
  }
}

function assertEqual(issues, actual, expected, label) {
  if (actual !== expected) issues.push(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function validateAssignmentPacket(worklistDir, entry, worklist, hashedFiles, label, issues) {
  const assignmentPath = resolveWorklistPath(worklistDir, entry.path, issues, `${label}.path`);
  if (!assignmentPath || !fs.existsSync(assignmentPath)) {
    issues.push(`${label}.path assignment file is missing: ${entry.path || "<missing>"}`);
    return;
  }
  const stat = fs.lstatSync(assignmentPath);
  if (!stat.isFile()) {
    issues.push(`${entry.path} must be a regular file listed in worklist SHA256SUMS`);
    return;
  }
  const relativeAssignmentPath = posixify(path.relative(path.resolve(worklistDir), assignmentPath));
  if (!hashedFiles.has(relativeAssignmentPath)) {
    issues.push(`${entry.path} is not listed in worklist SHA256SUMS`);
  }
  const packet = readJson(assignmentPath);
  rejectUnknownKeys(issues, packet, ["schemaVersion", "studyId", "bundle", "assignment", "subject", "manifestCopy", "attestationTemplate"], entry.path);
  rejectUnknownKeys(issues, packet.bundle, ["pathHint", "artifactSetSha256"], `${entry.path}.bundle`);
  rejectUnknownKeys(issues, packet.assignment, ["assignmentId", "subjectId", "phase", "reviewer", "reviewerType", "claimUse"], `${entry.path}.assignment`);
  rejectUnknownKeys(issues, packet.subject, ["subjectId", "phase", "repository", "commit"], `${entry.path}.subject`);
  rejectUnknownKeys(issues, packet.manifestCopy, ["path", "sha256"], `${entry.path}.manifestCopy`);
  rejectUnknownKeys(issues, packet.attestationTemplate, ["subjectId", "phase", "repository", "commit", "manifestCopy", "reviewStatus", "review"], `${entry.path}.attestationTemplate`);
  rejectUnknownKeys(issues, packet.attestationTemplate?.manifestCopy, ["path", "sha256"], `${entry.path}.attestationTemplate.manifestCopy`);
  rejectUnknownKeys(issues, packet.attestationTemplate?.review, ["reviewedAt", "scope", "reviewedManifestSha256", "reviewerAttestations"], `${entry.path}.attestationTemplate.review`);
  assertEqual(issues, packet.schemaVersion, "cellfence.manifest-attestation-assignment.v1", `${entry.path}.schemaVersion`);
  assertEqual(issues, packet.studyId, worklist.studyId, `${entry.path}.studyId`);
  assertEqual(issues, packet.bundle?.pathHint, worklist.bundle?.pathHint, `${entry.path}.bundle.pathHint`);
  assertEqual(issues, packet.bundle?.artifactSetSha256, worklist.bundle?.artifactSetSha256, `${entry.path}.bundle.artifactSetSha256`);
  assertEqual(issues, packet.assignment?.assignmentId, entry.assignmentId, `${entry.path}.assignment.assignmentId`);
  assertEqual(issues, packet.assignment?.subjectId, entry.subjectId, `${entry.path}.assignment.subjectId`);
  assertEqual(issues, packet.assignment?.phase ?? null, entry.phase ?? null, `${entry.path}.assignment.phase`);
  assertEqual(issues, packet.assignment?.reviewer, entry.reviewer, `${entry.path}.assignment.reviewer`);
  assertEqual(issues, packet.assignment?.reviewerType, entry.reviewerType, `${entry.path}.assignment.reviewerType`);
  assertEqual(issues, packet.assignment?.claimUse, "external_manifest_review", `${entry.path}.assignment.claimUse`);
  assertEqual(issues, packet.subject?.subjectId, entry.subjectId, `${entry.path}.subject.subjectId`);
  assertEqual(issues, packet.subject?.phase ?? null, entry.phase ?? null, `${entry.path}.subject.phase`);
  assertEqual(issues, packet.attestationTemplate?.subjectId, entry.subjectId, `${entry.path}.attestationTemplate.subjectId`);
  assertEqual(issues, packet.attestationTemplate?.phase ?? null, entry.phase ?? null, `${entry.path}.attestationTemplate.phase`);
  assertEqual(issues, packet.attestationTemplate?.repository ?? null, packet.subject?.repository ?? null, `${entry.path}.attestationTemplate.repository`);
  assertEqual(issues, packet.attestationTemplate?.commit ?? null, packet.subject?.commit ?? null, `${entry.path}.attestationTemplate.commit`);
  assertEqual(issues, packet.attestationTemplate?.manifestCopy?.path, packet.manifestCopy?.path, `${entry.path}.attestationTemplate.manifestCopy.path`);
  assertEqual(issues, packet.attestationTemplate?.manifestCopy?.sha256, packet.manifestCopy?.sha256, `${entry.path}.attestationTemplate.manifestCopy.sha256`);
  assertEqual(issues, packet.attestationTemplate?.reviewStatus, "reviewed", `${entry.path}.attestationTemplate.reviewStatus`);
  assertEqual(issues, packet.attestationTemplate?.review?.reviewedAt, "YYYY-MM-DD", `${entry.path}.attestationTemplate.review.reviewedAt`);
  assertEqual(issues, packet.attestationTemplate?.review?.reviewedManifestSha256, packet.manifestCopy?.sha256, `${entry.path}.attestationTemplate.review.reviewedManifestSha256`);
  validateSha256(issues, packet.bundle?.artifactSetSha256, `${entry.path}.bundle.artifactSetSha256`);
  validateSha256(issues, packet.manifestCopy?.sha256, `${entry.path}.manifestCopy.sha256`);
  const reviewers = packet.attestationTemplate?.review?.reviewerAttestations;
  if (!Array.isArray(reviewers) || reviewers.length !== 1) {
    issues.push(`${entry.path}.attestationTemplate.review.reviewerAttestations must contain exactly one assigned reviewer`);
    return;
  }
  const reviewer = reviewers[0];
  rejectUnknownKeys(issues, reviewer, ["id", "reviewerType", "independent"], `${entry.path}.attestationTemplate.review.reviewerAttestations[0]`);
  assertEqual(issues, reviewer.id, entry.reviewer, `${entry.path}.attestationTemplate.review.reviewerAttestations[0].id`);
  assertEqual(issues, reviewer.reviewerType, entry.reviewerType, `${entry.path}.attestationTemplate.review.reviewerAttestations[0].reviewerType`);
  if (reviewer.independent !== true) issues.push(`${entry.path}.attestationTemplate.review.reviewerAttestations[0].independent must be true`);
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
  if (!rejectUnknownKeys(issues, attestations, ["schemaVersion", "studyId", "bundleArtifactSetSha256", "worklistArtifactSetSha256", "attestations"], "attestations.json")) {
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
  const worklist = readWorklist(options.worklistDir, actualArtifactSetSha256, issues);
  validateExpectedWorklistArtifactSetSha256(options, worklist, issues);
  validateReturnedWorklistArtifactSetSha256(attestations, worklist, issues);

  const copyBySubject = manifestCopies(study, options.bundleDir, issues);
  const expected = expectedSubjects(corpus);
  const expectedByKey = new Map(expected.map((entry) => [subjectKey(entry.subjectId, entry.phase), entry]));
  validateWorklistSubjectSet(worklist, expectedByKey, issues);
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
    validateWorklistCoverage(worklist, key, attestation, label, issues);
    accepted.push({ key, attestation });
  }
  for (const entry of expected) {
    const key = subjectKey(entry.subjectId, entry.phase);
    if (!seen.has(key)) issues.push(`${posixify(key)} is missing an external manifest attestation`);
  }

  return report(options, study, corpus, attestations, issues, accepted, worklist);
}

function validateReturnedWorklistArtifactSetSha256(attestations, worklist, issues) {
  if (attestations.worklistArtifactSetSha256 === undefined) {
    if (worklist) issues.push("attestations.worklistArtifactSetSha256 is required when --worklist is supplied");
    return;
  }
  validateSha256(issues, attestations.worklistArtifactSetSha256, "attestations.worklistArtifactSetSha256");
  if (!worklist) {
    issues.push("attestations.worklistArtifactSetSha256 requires --worklist");
    return;
  }
  if (worklist.artifactSetSha256 && attestations.worklistArtifactSetSha256 !== worklist.artifactSetSha256) {
    issues.push("attestations.worklistArtifactSetSha256 does not match sealed worklist SHA256SUMS");
  }
}

function validateWorklistSubjectSet(worklist, expectedByKey, issues) {
  if (!worklist) return;
  for (const key of worklist.reviewersBySubject.keys()) {
    if (!expectedByKey.has(key)) {
      issues.push(`worklist includes reviewer assignments for unknown subject/phase ${posixify(key)}`);
    }
  }
}

function validateWorklistCoverage(worklist, key, attestation, label, issues) {
  if (!worklist) return;
  const expectedReviewers = worklist.reviewersBySubject.get(key);
  if (!expectedReviewers || expectedReviewers.size === 0) {
    issues.push(`${label} has no sealed worklist reviewer assignment`);
    return;
  }
  const actualReviewers = new Set((attestation.review?.reviewerAttestations || []).map((reviewer) => {
    const reviewerType = reviewer.reviewerType || reviewer.raterType || reviewer.reviewerClass || "";
    return reviewerKey(reviewer.id, reviewerType);
  }));
  for (const reviewer of expectedReviewers.values()) {
    if (!actualReviewers.has(reviewerKey(reviewer.id, reviewer.reviewerType))) {
      issues.push(`${label} is missing sealed worklist reviewer ${reviewer.id}/${reviewer.reviewerType}`);
    }
  }
  for (const reviewerKeyValue of actualReviewers) {
    if (!expectedReviewers.has(reviewerKeyValue)) {
      const [id, reviewerType] = reviewerKeyValue.split("\0");
      issues.push(`${label} includes reviewer ${id}/${reviewerType} not assigned in sealed worklist`);
    }
  }
}

function report(options, study, corpus, attestations, issues, accepted, worklist = null) {
  const acceptedRows = accepted || [];
  const expected = expectedSubjects(corpus);
  const acceptedCount = issues.length === 0 ? acceptedRows.length : 0;
  const output = {
    schemaVersion: "cellfence.external-manifest-attestation-validation.v1",
    generatedAt: new Date().toISOString(),
    ok: issues.length === 0,
    inputs: {
      bundle: posixify(options.bundleDir),
      attestations: posixify(options.attestationsPath),
      worklist: options.worklistDir ? posixify(options.worklistDir) : null,
      expectedWorklistArtifactSetSha256: options.expectedWorklistArtifactSetSha256 || null,
      returnedWorklistArtifactSetSha256: attestations?.worklistArtifactSetSha256 || null,
    },
    studyId: study?.studyId || null,
    summary: {
      requiredSubjects: expected.length,
      attestationRows: Array.isArray(attestations?.attestations) ? attestations.attestations.length : 0,
      acceptedSubjects: acceptedCount,
      missingSubjects: issues.length === 0 ? 0 : Math.max(0, expected.length - acceptedRows.length),
      worklistAssignments: worklist?.assignments ?? null,
    },
    worklist: worklist ? {
      path: posixify(worklist.path),
      artifactSetSha256: worklist.artifactSetSha256,
      assignments: worklist.assignments,
    } : null,
    issues,
  };
  if (issues.length === 0 && options.outCorpusPath) {
    writeJson(options.outCorpusPath, applyAttestationsToCorpus(corpus, acceptedRows));
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
