import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeExclusionRules, protocolFilterSha256 } from "./precision-policy-filters.mjs";

const worklistSchemaVersions = new Set(["cellfence.precision-label-worklist.v1", "cellfence.precision-label-worklist.v2"]);
const assignmentSchemaVersion = "cellfence.precision-label-assignment.v1";
const canonicalAllowedLabels = [
  "true_positive",
  "false_positive",
  "needs_policy",
  "needs_review",
  "invalid_setup",
  "out_of_scope",
];
const allowedRaterTypes = new Set(["human", "organization", "agent"]);
const labelLeakPattern = /(^|[^a-z0-9])(true_positive|false_positive|needs_policy|needs_review|invalid_setup|out_of_scope|answer|peer|adjudicat)([^a-z0-9]|$)/i;

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeName(value) {
  const slug = String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "subject";
  return `${slug}-${hashText(value).slice(0, 12)}`;
}

export function hashFile(filePath) {
  return hashBuffer(fs.readFileSync(filePath));
}

export function posixify(value) {
  return String(value).replace(/\\/g, "/").split(path.sep).join("/");
}

export function isAdjudication(label) {
  return label?.role === "adjudicator" || label?.round === "adjudication" || label?.adjudication === true || label?.adjudicated === true;
}

export function labelRaterType(label) {
  return label?.raterType || label?.raterClass || "";
}

export function validateClaimLabelMetadata(label, line, issues, options = {}) {
  const location = `${options.location || "labels.jsonl"}:${line}`;
  const sealedWorklist = options.sealedWorklist === true;
  const allowLegacyRaterClass = options.allowLegacyRaterClass !== false && !sealedWorklist;

  if (Object.hasOwn(label, "raterType") && typeof label.raterType !== "string") {
    issues.push(`${location} raterType must be a string`);
  }
  if (Object.hasOwn(label, "raterClass")) {
    if (!allowLegacyRaterClass) {
      issues.push(`${location} raterClass is not allowed for sealed claim labels; use raterType`);
    }
    if (typeof label.raterClass !== "string") {
      issues.push(`${location} raterClass must be a string`);
    }
  }
  if (Object.hasOwn(label, "raterType") && Object.hasOwn(label, "raterClass")) {
    issues.push(`${location} must not declare both raterType and raterClass`);
  }
  if (Object.hasOwn(label, "role") && typeof label.role !== "string") {
    issues.push(`${location} role must be a string`);
  }
  if (Object.hasOwn(label, "sourceBundleContainsLabels") && typeof label.sourceBundleContainsLabels !== "boolean") {
    issues.push(`${location} sourceBundleContainsLabels must be a boolean`);
  }
  if (Object.hasOwn(label, "sawPeerLabels") && typeof label.sawPeerLabels !== "boolean") {
    issues.push(`${location} sawPeerLabels must be a boolean`);
  }
  if (Object.hasOwn(label, "adjudication") && typeof label.adjudication !== "boolean") {
    issues.push(`${location} adjudication must be a boolean`);
  }
  if (Object.hasOwn(label, "adjudicated") && typeof label.adjudicated !== "boolean") {
    issues.push(`${location} adjudicated must be a boolean`);
  }

  const adjudication = isAdjudication(label);
  if (adjudication) {
    if (label.role !== "adjudicator") issues.push(`${location} adjudication label must declare role=adjudicator`);
    if (label.round !== "adjudication") issues.push(`${location} adjudication label must use round=adjudication`);
    if (sealedWorklist) {
      if (label.sawPeerLabels !== true) issues.push(`${location} adjudication label must declare sawPeerLabels=true`);
      if (label.sourceBundleContainsLabels !== true) issues.push(`${location} adjudication label must declare sourceBundleContainsLabels=true`);
      if (label.claimUse !== "sealed_adjudication") issues.push(`${location} adjudication label must declare claimUse=sealed_adjudication`);
    }
  } else {
    if (label.role !== "independent") issues.push(`${location} independent label must declare role=independent`);
    if (label.sourceBundleContainsLabels !== false) issues.push(`${location} independent label must declare sourceBundleContainsLabels=false`);
    if (label.claimUse !== "blind_labeling") issues.push(`${location} independent label must declare claimUse=blind_labeling`);
    if (Object.hasOwn(label, "adjudication") && label.adjudication !== false) {
      issues.push(`${location} independent label must not declare adjudication=true`);
    }
    if (Object.hasOwn(label, "adjudicated") && label.adjudicated !== false) {
      issues.push(`${location} independent label must not declare adjudicated=true`);
    }
  }

  const metadataKeys = [
    "schemaVersion",
    "studyId",
    "findingId",
    "rater",
    "raterType",
    "raterClass",
    "round",
    "assignmentId",
    "evidencePackageId",
    "claimUse",
  ];
  for (const key of metadataKeys) {
    if (typeof label[key] === "string") rejectLabelLeak(issues, label[key], `${location}.${key}`);
  }
  if (typeof label.role === "string" && label.role !== "independent" && label.role !== "adjudicator") {
    rejectLabelLeak(issues, label.role, `${location}.role`);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(issues, value, allowedKeys, label) {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object`);
    return;
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${label} has unexpected field ${key}`);
  }
}

function validateArtifactRefShape(issues, value, label) {
  if (value === null || value === undefined) return;
  rejectUnknownKeys(issues, value, ["path", "sha256"], label);
}

function validateArtifactMapShape(issues, value, allowedKeys, label) {
  rejectUnknownKeys(issues, value, allowedKeys, label);
  if (!isRecord(value)) return;
  for (const key of allowedKeys) validateArtifactRefShape(issues, value[key], `${label}.${key}`);
}

function validateRaterShape(issues, value, label) {
  rejectUnknownKeys(issues, value, ["rater", "raterType", "round"], label);
}

function validateWorklistEntryShape(issues, value, label) {
  rejectUnknownKeys(issues, value, ["path", "assignmentId", "evidencePackageId", "findingId", "subjectId", "ruleId", "round", "rater", "raterType"], label);
}

function validateExclusionRulesShape(issues, value, label) {
  return normalizeExclusionRules(value, issues, { label });
}

function validateProtocolBindingShape(issues, value, label) {
  if (value === undefined) return;
  rejectUnknownKeys(issues, value, [
    "pathHint",
    "sha256",
    "studyId",
    "sourceBundleArtifactSetSha256",
    "preLabelArtifactSetSha256",
    "includedRules",
    "blockingSeverities",
    "exclusionRules",
    "filterSha256",
  ], label);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${label} must be an object when present`);
    return;
  }
  rejectLabelLeak(issues, value.pathHint, `${label}.pathHint`);
  validateSha256(issues, value.sha256, `${label}.sha256`);
  if (value.studyId !== null && typeof value.studyId !== "string") issues.push(`${label}.studyId must be a string or null`);
  validateSha256(issues, value.sourceBundleArtifactSetSha256, `${label}.sourceBundleArtifactSetSha256`, { required: false });
  validateSha256(issues, value.preLabelArtifactSetSha256, `${label}.preLabelArtifactSetSha256`, { required: false });
  validateStringArray(issues, value.includedRules, `${label}.includedRules`);
  validateStringArray(issues, value.blockingSeverities, `${label}.blockingSeverities`);
  validateExclusionRulesShape(issues, value.exclusionRules, `${label}.exclusionRules`);
  validateSha256(issues, value.filterSha256, `${label}.filterSha256`);
}

function validateSourceLabelShape(issues, value, label) {
  rejectUnknownKeys(issues, value, ["schemaVersion", "studyId", "findingId", "rater", "raterType", "role", "round", "assignmentId", "evidencePackageId", "sawPeerLabels", "sourceBundleContainsLabels", "claimUse", "label", "rationale"], label);
}

function worklistMode(worklist) {
  if (worklist.mode === "adjudication") return "adjudication";
  return "blind_labeling";
}

function validateWorklistShape(worklist, issues) {
  rejectUnknownKeys(issues, worklist, ["schemaVersion", "mode", "createdBy", "studyId", "bundle", "filters", "protocol", "raters", "summary", "assignments"], "worklist.json");
  if (worklist.mode !== undefined && worklist.mode !== "blind_labeling" && worklist.mode !== "adjudication") {
    issues.push("worklist.mode must be blind_labeling or adjudication");
  }
  rejectUnknownKeys(issues, worklist.bundle, ["pathHint", "artifactSetSha256", "preLabelArtifactSetSha256", "createdAt"], "worklist.bundle");
  rejectUnknownKeys(issues, worklist.filters, ["includedRules", "blockingSeverities", "exclusionRules", "filterSha256", "allowExistingLabels"], "worklist.filters");
  rejectUnknownKeys(issues, worklist.summary, ["selectedFindings", "assignments", "existingLabelsInBundle", "disagreements"], "worklist.summary");
  rejectLabelLeak(issues, worklist.createdBy, "worklist.createdBy");
  rejectLabelLeak(issues, worklist.bundle?.pathHint, "worklist.bundle.pathHint");
  validateSha256(issues, worklist.bundle?.artifactSetSha256, "worklist.bundle.artifactSetSha256");
  validateSha256(issues, worklist.bundle?.preLabelArtifactSetSha256, "worklist.bundle.preLabelArtifactSetSha256", { required: false });
  validateCreatedAt(issues, worklist.bundle?.createdAt, "worklist.bundle.createdAt");
  validateStringArray(issues, worklist.filters?.includedRules, "worklist.filters.includedRules");
  validateStringArray(issues, worklist.filters?.blockingSeverities, "worklist.filters.blockingSeverities");
  validateExclusionRulesShape(issues, worklist.filters?.exclusionRules, "worklist.filters.exclusionRules");
  validateSha256(issues, worklist.filters?.filterSha256, "worklist.filters.filterSha256", { required: false });
  if (typeof worklist.filters?.allowExistingLabels !== "boolean") {
    issues.push("worklist.filters.allowExistingLabels must be a boolean");
  }
  validateProtocolBindingShape(issues, worklist.protocol, "worklist.protocol");
  if (Array.isArray(worklist.raters)) {
    worklist.raters.forEach((rater, index) => {
      validateRaterShape(issues, rater, `worklist.raters[${index}]`);
      rejectLabelLeak(issues, rater?.rater, `worklist.raters[${index}].rater`);
      validateRaterType(issues, rater?.raterType, `worklist.raters[${index}].raterType`);
    });
  } else {
    issues.push("worklist.raters must be an array");
  }
  if (Array.isArray(worklist.assignments)) {
    worklist.assignments.forEach((entry, index) => validateWorklistEntryShape(issues, entry, `worklist.assignments[${index}]`));
  }
}

function validateAssignmentShape(assignment, label, issues) {
  rejectUnknownKeys(issues, assignment, ["schemaVersion", "studyId", "bundle", "assignment", "evidenceArtifacts", "finding", "sourceLabels", "allowedLabels", "labelTemplate"], label);
  rejectUnknownKeys(issues, assignment.bundle, ["pathHint", "artifactSetSha256", "preLabelArtifactSetSha256"], `${label}.bundle`);
  rejectUnknownKeys(issues, assignment.assignment, ["assignmentId", "evidencePackageId", "round", "rater", "raterType", "sawPeerLabels", "peerLabelsIncluded", "sourceBundleContainsLabels", "claimUse"], `${label}.assignment`);
  rejectUnknownKeys(issues, assignment.evidenceArtifacts, ["bundleFiles", "subject"], `${label}.evidenceArtifacts`);
  if (isRecord(assignment.evidenceArtifacts)) {
    validateArtifactMapShape(issues, assignment.evidenceArtifacts.bundleFiles, ["corpus", "report", "rawFindings", "normalizedFindings", "sampledFindings", "sampling"], `${label}.evidenceArtifacts.bundleFiles`);
    validateArtifactMapShape(issues, assignment.evidenceArtifacts.subject, ["manifest", "auditLog", "evidenceGraph", "checkStdout", "checkStderr"], `${label}.evidenceArtifacts.subject`);
  }
  rejectUnknownKeys(issues, assignment.finding, ["findingId", "subjectId", "repository", "commit", "gitTree", "manifestSha256", "manifestStrategy", "manifestReviewStatus", "ruleId", "severity", "filePath", "line", "message", "cellId", "producerCellId", "cellfenceFingerprint", "occurrenceIndex"], `${label}.finding`);
  rejectUnknownKeys(issues, assignment.labelTemplate, ["schemaVersion", "studyId", "findingId", "rater", "raterType", "role", "round", "assignmentId", "evidencePackageId", "sawPeerLabels", "sourceBundleContainsLabels", "claimUse", "label", "rationale"], `${label}.labelTemplate`);
  if (Array.isArray(assignment.sourceLabels)) {
    assignment.sourceLabels.forEach((sourceLabel, index) => validateSourceLabelShape(issues, sourceLabel, `${label}.sourceLabels[${index}]`));
  } else if (assignment.sourceLabels !== undefined) {
    issues.push(`${label}.sourceLabels must be an array when present`);
  }
}

function listFilesRecursive(baseDir, issues = [], rootDir = baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  const entries = [];
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isSymbolicLink()) {
      issues.push(`worklist contains symlink: ${posixify(path.relative(rootDir, fullPath))}`);
    } else if (entry.isDirectory()) {
      entries.push(...listFilesRecursive(fullPath, issues, rootDir));
    } else if (entry.isFile()) {
      entries.push(fullPath);
    }
  }
  return entries.sort((left, right) => posixify(path.relative(baseDir, left)).localeCompare(posixify(path.relative(baseDir, right))));
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
    if (sums.has(relativePath)) {
      issues.push(`worklist SHA256SUMS:${index + 1} duplicates ${relativePath}`);
    }
    const segments = posixify(relativePath).split("/");
    if (
      relativePath.length === 0
      || relativePath.includes("\0")
      || path.isAbsolute(relativePath)
      || segments.includes("")
      || segments.includes(".")
      || segments.includes("..")
      || relativePath === "SHA256SUMS"
    ) {
      issues.push(`worklist SHA256SUMS:${index + 1} has unsafe path ${relativePath}`);
    }
    sums.set(relativePath, match[1]);
  }
  return sums;
}

function validateSha256Sums(baseDir, issues) {
  const expected = readSha256Sums(baseDir, issues);
  if (expected.size === 0) return { artifactSetSha256: null, hashedFiles: new Set() };
  const actualFiles = listFilesRecursive(baseDir, issues)
    .filter((filePath) => path.basename(filePath) !== "SHA256SUMS")
    .map((filePath) => posixify(path.relative(baseDir, filePath)))
    .sort();
  const expectedFiles = [...expected.keys()].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    issues.push("worklist SHA256SUMS file list does not match worklist contents");
    return {
      artifactSetSha256: fs.existsSync(path.join(baseDir, "SHA256SUMS")) ? hashFile(path.join(baseDir, "SHA256SUMS")) : null,
      hashedFiles: new Set(expectedFiles),
    };
  }
  for (const relativePath of actualFiles) {
    const actualHash = hashFile(path.join(baseDir, relativePath));
    if (actualHash !== expected.get(relativePath)) {
      issues.push(`worklist SHA256 mismatch for ${relativePath}`);
    }
  }
  return {
    artifactSetSha256: fs.existsSync(path.join(baseDir, "SHA256SUMS")) ? hashFile(path.join(baseDir, "SHA256SUMS")) : null,
    hashedFiles: new Set(expectedFiles),
  };
}

function safeJoin(baseDir, relativePath, issues, label) {
  if (!relativePath || typeof relativePath !== "string") {
    issues.push(`${label} is missing`);
    return null;
  }
  const resolved = path.resolve(baseDir, relativePath);
  const relative = path.relative(path.resolve(baseDir), resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    issues.push(`${label} escapes the worklist directory`);
    return null;
  }
  return resolved;
}

function assertEqual(issues, actual, expected, message) {
  if (actual !== expected) issues.push(`${message}: expected ${expected}, got ${actual}`);
}

function rejectLabelLeak(issues, value, label) {
  if (typeof value === "string" && labelLeakPattern.test(value)) {
    issues.push(`${label} contains label/answer-suggestive text`);
  }
}

function validateSha256(issues, value, label, { required = true } = {}) {
  if (value === null || value === undefined) {
    if (required) issues.push(`${label} is required`);
    return;
  }
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    issues.push(`${label} must be a lowercase 64-hex SHA-256 digest`);
  }
  rejectLabelLeak(issues, value, label);
}

function validateCreatedAt(issues, value, label) {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    issues.push(`${label} must be null or an ISO-like timestamp string`);
  }
  rejectLabelLeak(issues, value, label);
}

function validateStringArray(issues, value, label) {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array`);
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.length === 0) issues.push(`${label}[${index}] must be a non-empty string`);
    rejectLabelLeak(issues, entry, `${label}[${index}]`);
  }
}

function validateRaterType(issues, value, label) {
  if (typeof value !== "string" || !allowedRaterTypes.has(value)) {
    issues.push(`${label} must be one of human, organization, agent`);
  }
  rejectLabelLeak(issues, value, label);
}

function firstSubjectArtifact(study, subjectId, suffix) {
  return (study?.logCopies || []).find((copy) => {
    return copy?.subjectId === subjectId && String(copy.path || "").endsWith(suffix);
  })?.path || null;
}

function resolveBundleRelativePath(bundleDir, relativePath, issues, label) {
  if (!bundleDir || typeof relativePath !== "string" || relativePath.length === 0) {
    if (relativePath) issues.push(`${label} cannot be resolved without a sealed bundle directory`);
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
  const bundleRoot = path.resolve(bundleDir);
  const resolved = path.resolve(bundleRoot, relativePath);
  const lexicalRelative = path.relative(bundleRoot, resolved);
  if (lexicalRelative === "" || lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    issues.push(`${label} escapes bundle root: ${relativePath}`);
    return null;
  }
  if (fs.existsSync(resolved)) {
    const realRoot = fs.realpathSync.native(bundleRoot);
    const realResolved = fs.realpathSync.native(resolved);
    const realRelative = path.relative(realRoot, realResolved);
    if (realRelative === "" || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      issues.push(`${label} resolves outside bundle root: ${relativePath}`);
      return null;
    }
  }
  return resolved;
}

function artifactRef(bundleDir, relativePath, issues, label) {
  if (!bundleDir || !relativePath) return null;
  const artifactPath = resolveBundleRelativePath(bundleDir, relativePath, issues, label);
  if (!artifactPath || !fs.existsSync(artifactPath)) return null;
  return {
    path: posixify(relativePath),
    sha256: hashFile(artifactPath),
  };
}

function expectedEvidenceArtifacts(study, bundleDir, finding, issues) {
  const manifestCopy = (study?.manifestCopies || []).find((copy) => copy?.subjectId === finding.subjectId)?.path || null;
  return {
    bundleFiles: {
      corpus: artifactRef(bundleDir, "corpus.json", issues, "bundle file corpus.json"),
      report: artifactRef(bundleDir, "report.json", issues, "bundle file report.json"),
      rawFindings: artifactRef(bundleDir, "findings.raw.jsonl", issues, "bundle file findings.raw.jsonl"),
      normalizedFindings: artifactRef(bundleDir, "findings.normalized.jsonl", issues, "bundle file findings.normalized.jsonl"),
      sampledFindings: artifactRef(bundleDir, "findings.sampled.jsonl", issues, "bundle file findings.sampled.jsonl"),
      sampling: artifactRef(bundleDir, "sampling.json", issues, "bundle file sampling.json"),
    },
    subject: {
      manifest: artifactRef(bundleDir, manifestCopy, issues, `manifest copy path ${manifestCopy || "<missing>"}`),
      auditLog: artifactRef(bundleDir, firstSubjectArtifact(study, finding.subjectId, "check.audit.jsonl"), issues, `audit log copy for ${finding.subjectId}`),
      evidenceGraph: artifactRef(bundleDir, firstSubjectArtifact(study, finding.subjectId, "evidence-graph.json"), issues, `evidence graph copy for ${finding.subjectId}`),
      checkStdout: artifactRef(bundleDir, firstSubjectArtifact(study, finding.subjectId, "check.stdout.log"), issues, `check stdout copy for ${finding.subjectId}`),
      checkStderr: artifactRef(bundleDir, firstSubjectArtifact(study, finding.subjectId, "check.stderr.log"), issues, `check stderr copy for ${finding.subjectId}`),
    },
  };
}

function expectedFindingEvidence(finding) {
  return {
    findingId: finding.findingId,
    subjectId: finding.subjectId || null,
    repository: finding.repository || null,
    commit: finding.commit || null,
    gitTree: finding.gitTree || null,
    manifestSha256: finding.manifestSha256 || null,
    manifestStrategy: finding.manifestStrategy || null,
    manifestReviewStatus: finding.manifestReviewStatus || null,
    ruleId: finding.ruleId,
    severity: finding.severity || "error",
    filePath: finding.filePath || null,
    line: finding.line ?? null,
    message: finding.message || "",
    cellId: finding.cellId || null,
    producerCellId: finding.producerCellId || null,
    cellfenceFingerprint: finding.cellfenceFingerprint || null,
    occurrenceIndex: finding.occurrenceIndex ?? null,
  };
}

function validateAssignmentEvidenceBinding(assignment, entry, context, issues) {
  const expectedFinding = context.findingsById.get(entry.findingId);
  if (!expectedFinding) {
    issues.push(`${entry.path} findingId is not present in the sealed bundle findings`);
    return;
  }
  const expectedFindingRecord = expectedFindingEvidence(expectedFinding);
  for (const key of Object.keys(assignment.finding || {})) {
    if (canonicalJson(assignment.finding[key]) !== canonicalJson(expectedFindingRecord[key])) {
      issues.push(`${entry.path} finding.${key} does not match the sealed bundle finding`);
    }
  }
  const expectedArtifacts = expectedEvidenceArtifacts(context.study, context.bundleDir, expectedFinding, issues);
  for (const groupKey of Object.keys(expectedArtifacts)) {
    const actualGroup = assignment.evidenceArtifacts?.[groupKey];
    const expectedGroup = expectedArtifacts[groupKey] || {};
    if (!isRecord(actualGroup)) {
      if (Object.values(expectedGroup).some((entry) => entry !== null)) {
        issues.push(`${entry.path} evidenceArtifacts.${groupKey} must include available sealed evidence references`);
      }
      continue;
    }
    for (const key of Object.keys(expectedGroup)) {
      if (canonicalJson(actualGroup[key] ?? null) !== canonicalJson(expectedGroup[key] ?? null)) {
        issues.push(`${entry.path} evidenceArtifacts.${groupKey}.${key} does not match the sealed bundle artifact`);
      }
    }
  }
  const expectedAssignmentId = `assignment-${hashText([context.studyId, entry.findingId, entry.round, entry.rater].join("\0")).slice(0, 16)}`;
  if (entry.assignmentId !== expectedAssignmentId) {
    issues.push(`${entry.path} assignmentId does not match the generator-derived assignment id`);
  }
  const expectedEvidencePackageId = `evidence-${entry.findingId.replace(/^sha256:/, "").slice(0, 16)}`;
  if (entry.evidencePackageId !== expectedEvidencePackageId) {
    issues.push(`${entry.path} evidencePackageId does not match the generator-derived evidence package id`);
  }
  const expectedPath = posixify(path.join(
    "assignments",
    entry.round,
    `${safeName(expectedFinding.subjectId || "subject")}-${safeName(expectedFinding.ruleId)}-${expectedAssignmentId.replace(/^assignment-/, "")}.json`,
  ));
  if (posixify(entry.path) !== expectedPath) {
    issues.push(`${entry.path} path does not match the generator-derived assignment path`);
  }
  rejectLabelLeak(issues, entry.assignmentId, `${entry.path} assignmentId`);
  rejectLabelLeak(issues, entry.evidencePackageId, `${entry.path} evidencePackageId`);
  rejectLabelLeak(issues, entry.rater, `${entry.path} rater`);
}

function sourceLabelSnapshot(label) {
  return {
    schemaVersion: label.schemaVersion || "cellfence.corpus-label.v1",
    studyId: label.studyId,
    findingId: label.findingId,
    rater: label.rater,
    raterType: label.raterType || "",
    role: label.role || "independent",
    round: label.round,
    assignmentId: label.assignmentId,
    evidencePackageId: label.evidencePackageId,
    sawPeerLabels: label.sawPeerLabels,
    sourceBundleContainsLabels: label.sourceBundleContainsLabels,
    claimUse: label.claimUse,
    label: label.label,
    rationale: label.rationale || "",
  };
}

function validateAssignmentSourceLabels(assignment, entry, context, issues) {
  const sourceLabels = Array.isArray(assignment.sourceLabels) ? assignment.sourceLabels : [];
  if (entry.round !== "adjudication") {
    if (sourceLabels.length !== 0) issues.push(`${entry.path} blind assignments must not include sourceLabels`);
    return;
  }
  const independent = (context.labelsByFindingId.get(entry.findingId) || []).filter((label) => !isAdjudication(label));
  const blindFirst = independent.filter((label) => label.round === "blind_first");
  const blindSecond = independent.filter((label) => label.round === "blind_second");
  const distinctLabels = new Set(independent.map((label) => label.label));
  if (blindFirst.length !== 1 || blindSecond.length !== 1 || distinctLabels.size <= 1) {
    issues.push(`${entry.path} adjudication assignment must be backed by exactly two disagreeing independent labels`);
  }
  const expected = independent
    .map(sourceLabelSnapshot)
    .sort((left, right) => `${left.round}\0${left.rater}`.localeCompare(`${right.round}\0${right.rater}`));
  const actual = sourceLabels
    .map(sourceLabelSnapshot)
    .sort((left, right) => `${left.round}\0${left.rater}`.localeCompare(`${right.round}\0${right.rater}`));
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    issues.push(`${entry.path} sourceLabels do not match sealed independent labels`);
  }
}

function validateDeclaredWorklistFiles(hashedFiles, assignments, issues) {
  const declaredFiles = new Set(["worklist.json"]);
  for (const entry of assignments) {
    if (entry?.path && typeof entry.path === "string") declaredFiles.add(posixify(entry.path));
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

function validateWorklistManifestConsistency(worklist, assignments, issues) {
  const mode = worklistMode(worklist);
  if (mode === "blind_labeling") {
    if (worklist.filters?.allowExistingLabels !== false) {
      issues.push("worklist.filters.allowExistingLabels must be false for claim-bound blind labeling");
    }
    if (worklist.summary?.existingLabelsInBundle !== 0) {
      issues.push("worklist.summary.existingLabelsInBundle must be 0 for claim-bound blind labeling");
    }
  } else {
    if (worklist.schemaVersion !== "cellfence.precision-label-worklist.v2") {
      issues.push("adjudication worklists must use schemaVersion cellfence.precision-label-worklist.v2");
    }
    if (worklist.filters?.allowExistingLabels !== true) {
      issues.push("worklist.filters.allowExistingLabels must be true for sealed adjudication");
    }
    if (!Number.isInteger(worklist.summary?.existingLabelsInBundle) || worklist.summary.existingLabelsInBundle <= 0) {
      issues.push("worklist.summary.existingLabelsInBundle must be positive for sealed adjudication");
    }
  }
  if (worklist.summary?.assignments !== assignments.length) {
    issues.push(`worklist.summary.assignments does not match assignment count: expected ${assignments.length}, got ${worklist.summary?.assignments}`);
  }
  const selectedFindings = new Set(assignments.map((entry) => entry?.findingId).filter(Boolean));
  if (worklist.summary?.selectedFindings !== selectedFindings.size) {
    issues.push(`worklist.summary.selectedFindings does not match selected finding count: expected ${selectedFindings.size}, got ${worklist.summary?.selectedFindings}`);
  }
  const raterKeys = new Set();
  const raters = Array.isArray(worklist.raters) ? worklist.raters : [];
  const requiredRounds = mode === "adjudication" ? new Set(["adjudication"]) : new Set(["blind_first", "blind_second"]);
  if (raters.length !== requiredRounds.size) {
    issues.push(`worklist.raters must declare exactly ${requiredRounds.size} ${mode === "adjudication" ? "adjudication" : "global blind"} rater(s); got ${raters.length}`);
  }
  const raterNames = new Set(raters.map((rater) => rater?.rater).filter(Boolean));
  if (raterNames.size !== raters.length) {
    issues.push("worklist.raters must use distinct global rater IDs");
  }
  const rounds = new Set(raters.map((rater) => rater?.round));
  for (const round of requiredRounds) {
    if (!rounds.has(round)) issues.push(`worklist.raters must declare ${round}`);
  }
  for (const round of rounds) {
    if (!requiredRounds.has(round)) issues.push(`worklist.raters has unsupported round ${round}`);
  }
  for (const [index, rater] of raters.entries()) {
    const key = `${rater?.round}\0${rater?.rater}`;
    if (raterKeys.has(key)) issues.push(`worklist.raters[${index}] duplicates rater/round ${rater?.rater}/${rater?.round}`);
    raterKeys.add(key);
  }
  const globalRaterByRound = new Map(raters.map((rater) => [rater?.round, rater?.rater]));
  const assignmentRaterKeys = new Set();
  const assignmentsByFinding = new Map();
  for (const entry of assignments) {
    const key = `${entry?.round}\0${entry?.rater}`;
    assignmentRaterKeys.add(key);
    const findingAssignments = assignmentsByFinding.get(entry?.findingId) || [];
    findingAssignments.push(entry);
    assignmentsByFinding.set(entry?.findingId, findingAssignments);
    if (!raterKeys.has(key)) {
      issues.push(`${entry?.path || "<unknown>"} rater/round is not declared in worklist.raters`);
    }
    if (globalRaterByRound.has(entry?.round) && entry?.rater !== globalRaterByRound.get(entry.round)) {
      issues.push(`${entry?.path || "<unknown>"} rater does not match the global ${entry?.round} rater`);
    }
    const globalRater = raters.find((rater) => rater?.round === entry?.round);
    if (globalRater && entry?.raterType !== globalRater.raterType) {
      issues.push(`${entry?.path || "<unknown>"} raterType does not match the global ${entry?.round} raterType`);
    }
  }
  for (const key of raterKeys) {
    if (!assignmentRaterKeys.has(key)) {
      const [round, rater] = key.split("\0");
      issues.push(`worklist.raters declares unused rater/round ${rater}/${round}`);
    }
  }
  for (const [findingId, findingAssignments] of assignmentsByFinding.entries()) {
    if (findingAssignments.length !== requiredRounds.size) {
      issues.push(`worklist finding ${findingId} must have exactly ${requiredRounds.size} ${mode === "adjudication" ? "adjudication" : "blind"} assignment(s); got ${findingAssignments.length}`);
    }
    for (const round of requiredRounds) {
      const roundAssignments = findingAssignments.filter((entry) => entry?.round === round);
      if (roundAssignments.length !== 1) {
        issues.push(`worklist finding ${findingId} must have exactly one ${round} assignment; got ${roundAssignments.length}`);
      }
    }
  }
}

function filtersFromProtocol(protocol) {
  if (!protocol) return null;
  return {
    studyId: protocol.studyId || null,
    preLabelArtifactSetSha256: protocol.preLabelArtifactSetSha256 || null,
    includedRules: protocol.includedRules || [],
    blockingSeverities: protocol.blockingSeverities || ["error"],
    exclusionRules: protocol.exclusionRules || [],
  };
}

function compareJson(issues, actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    issues.push(`${label} does not match the active claim protocol`);
  }
}

function validateWorklistProtocolBinding(worklist, expectedProtocol, issues) {
  const expected = filtersFromProtocol(expectedProtocol);
  const protocolBinding = worklist.protocol;
  const actualFilters = {
    includedRules: worklist.filters?.includedRules || [],
    blockingSeverities: worklist.filters?.blockingSeverities || [],
    exclusionRules: worklist.filters?.exclusionRules || [],
  };
  if (!protocolBinding) {
    if (expectedProtocol && worklist.filters?.filterSha256) {
      const expectedFilterSha256 = protocolFilterSha256(expected);
      compareJson(issues, actualFilters.includedRules, expected.includedRules, "worklist.filters.includedRules");
      compareJson(issues, actualFilters.blockingSeverities, expected.blockingSeverities, "worklist.filters.blockingSeverities");
      compareJson(issues, actualFilters.exclusionRules, expected.exclusionRules, "worklist.filters.exclusionRules");
      if (worklist.filters.filterSha256 !== expectedFilterSha256) {
        issues.push("worklist.filters.filterSha256 does not match the active claim protocol");
      }
    }
    return;
  }
  if (!expected) {
    return;
  }
  if (protocolBinding.studyId !== expected.studyId) {
    issues.push("worklist.protocol.studyId does not match the active claim protocol");
  }
  if ((protocolBinding.sourceBundleArtifactSetSha256 || null) !== (worklist.bundle?.artifactSetSha256 || null)) {
    issues.push("worklist.protocol.sourceBundleArtifactSetSha256 does not match worklist.bundle.artifactSetSha256");
  }
  if ((protocolBinding.preLabelArtifactSetSha256 || null) !== expected.preLabelArtifactSetSha256) {
    issues.push("worklist.protocol.preLabelArtifactSetSha256 does not match the active claim protocol");
  }
  compareJson(issues, protocolBinding.includedRules || [], expected.includedRules, "worklist.protocol.includedRules");
  compareJson(issues, protocolBinding.blockingSeverities || [], expected.blockingSeverities, "worklist.protocol.blockingSeverities");
  compareJson(issues, protocolBinding.exclusionRules || [], expected.exclusionRules, "worklist.protocol.exclusionRules");
  compareJson(issues, actualFilters.includedRules, expected.includedRules, "worklist.filters.includedRules");
  compareJson(issues, actualFilters.blockingSeverities, expected.blockingSeverities, "worklist.filters.blockingSeverities");
  compareJson(issues, actualFilters.exclusionRules, expected.exclusionRules, "worklist.filters.exclusionRules");
  const expectedFilterSha256 = protocolFilterSha256(expected);
  if (protocolBinding.filterSha256 !== expectedFilterSha256) {
    issues.push("worklist.protocol.filterSha256 does not match the active claim protocol");
  }
  if (!worklist.filters?.filterSha256) {
    issues.push("protocol-bound worklist.filters.filterSha256 is required");
  } else if (worklist.filters.filterSha256 !== expectedFilterSha256) {
    issues.push("worklist.filters.filterSha256 does not match the active claim protocol");
  }
}

function validateAssignment(worklistDir, entry, worklist, hashedFiles, context, issues) {
  const assignmentPath = safeJoin(worklistDir, entry?.path, issues, "assignment path");
  if (!assignmentPath || !fs.existsSync(assignmentPath)) {
    issues.push(`assignment file is missing: ${entry?.path || "<unknown>"}`);
    return null;
  }
  const relativeAssignmentPath = posixify(path.relative(path.resolve(worklistDir), assignmentPath));
  let assignmentStat;
  try {
    assignmentStat = fs.lstatSync(assignmentPath);
  } catch {
    issues.push(`assignment file is missing: ${entry?.path || "<unknown>"}`);
    return null;
  }
  if (!assignmentStat.isFile()) {
    issues.push(`${entry.path} must be a regular file listed in worklist SHA256SUMS`);
    return null;
  }
  if (!hashedFiles.has(relativeAssignmentPath)) {
    issues.push(`${entry.path} is not listed in worklist SHA256SUMS`);
    return null;
  }
  const assignment = readJson(assignmentPath);
  validateAssignmentShape(assignment, entry.path, issues);
  rejectLabelLeak(issues, assignment.bundle?.pathHint, `${entry.path} bundle.pathHint`);
  validateSha256(issues, assignment.bundle?.artifactSetSha256, `${entry.path} bundle.artifactSetSha256`);
  validateSha256(issues, assignment.bundle?.preLabelArtifactSetSha256, `${entry.path} bundle.preLabelArtifactSetSha256`, { required: false });
  rejectLabelLeak(issues, assignment.assignment?.assignmentId, `${entry.path} assignment.assignmentId`);
  rejectLabelLeak(issues, assignment.assignment?.evidencePackageId, `${entry.path} assignment.evidencePackageId`);
  rejectLabelLeak(issues, assignment.assignment?.rater, `${entry.path} assignment.rater`);
  validateRaterType(issues, assignment.assignment?.raterType, `${entry.path} assignment.raterType`);
  if (assignment.schemaVersion !== assignmentSchemaVersion) {
    issues.push(`${entry.path} has unexpected schemaVersion`);
  }
  if (!Array.isArray(assignment.allowedLabels) || JSON.stringify(assignment.allowedLabels) !== JSON.stringify(canonicalAllowedLabels)) {
    issues.push(`${entry.path} allowedLabels must exactly match the canonical label set`);
  }
  validateAssignmentEvidenceBinding(assignment, entry, context, issues);
  assertEqual(issues, assignment.studyId, worklist.studyId, `${entry.path} studyId`);
  assertEqual(issues, assignment.bundle?.pathHint, worklist.bundle?.pathHint, `${entry.path} bundle.pathHint`);
  assertEqual(issues, assignment.bundle?.artifactSetSha256, worklist.bundle?.artifactSetSha256, `${entry.path} bundle.artifactSetSha256`);
  assertEqual(issues, assignment.bundle?.preLabelArtifactSetSha256, worklist.bundle?.preLabelArtifactSetSha256, `${entry.path} bundle.preLabelArtifactSetSha256`);
  assertEqual(issues, assignment.assignment?.assignmentId, entry.assignmentId, `${entry.path} assignmentId`);
  assertEqual(issues, assignment.assignment?.evidencePackageId, entry.evidencePackageId, `${entry.path} evidencePackageId`);
  assertEqual(issues, assignment.assignment?.round, entry.round, `${entry.path} round`);
  assertEqual(issues, assignment.assignment?.rater, entry.rater, `${entry.path} rater`);
  assertEqual(issues, assignment.assignment?.raterType, entry.raterType, `${entry.path} raterType`);
  assertEqual(issues, assignment.finding?.findingId, entry.findingId, `${entry.path} findingId`);
  assertEqual(issues, assignment.finding?.subjectId, entry.subjectId, `${entry.path} subjectId`);
  assertEqual(issues, assignment.finding?.ruleId, entry.ruleId, `${entry.path} ruleId`);
  const adjudication = entry.round === "adjudication";
  const expectedSawPeerLabels = adjudication ? true : false;
  const expectedSourceBundleContainsLabels = adjudication ? true : false;
  const expectedClaimUse = adjudication ? "sealed_adjudication" : "blind_labeling";
  const expectedRole = adjudication ? "adjudicator" : "independent";
  if (assignment.assignment?.peerLabelsIncluded !== expectedSawPeerLabels) issues.push(`${entry.path} must declare peerLabelsIncluded=${expectedSawPeerLabels}`);
  if (assignment.assignment?.sawPeerLabels !== expectedSawPeerLabels) issues.push(`${entry.path} must declare sawPeerLabels=${expectedSawPeerLabels}`);
  if (assignment.assignment?.sourceBundleContainsLabels !== expectedSourceBundleContainsLabels) {
    issues.push(`${entry.path} must declare sourceBundleContainsLabels=${expectedSourceBundleContainsLabels}`);
  }
  if (assignment.assignment?.claimUse !== expectedClaimUse) {
    issues.push(`${entry.path} must declare claimUse=${expectedClaimUse}`);
  }
  validateAssignmentSourceLabels(assignment, entry, context, issues);
  const template = assignment.labelTemplate || {};
  validateClaimLabelMetadata(template, "labelTemplate", issues, { sealedWorklist: true, location: entry.path });
  rejectLabelLeak(issues, template.rater, `${entry.path} labelTemplate.rater`);
  rejectLabelLeak(issues, template.assignmentId, `${entry.path} labelTemplate.assignmentId`);
  rejectLabelLeak(issues, template.evidencePackageId, `${entry.path} labelTemplate.evidencePackageId`);
  validateRaterType(issues, template.raterType, `${entry.path} labelTemplate.raterType`);
  assertEqual(issues, template.schemaVersion, "cellfence.corpus-label.v1", `${entry.path} labelTemplate.schemaVersion`);
  assertEqual(issues, template.studyId, worklist.studyId, `${entry.path} labelTemplate.studyId`);
  assertEqual(issues, template.findingId, entry.findingId, `${entry.path} labelTemplate.findingId`);
  assertEqual(issues, template.rater, entry.rater, `${entry.path} labelTemplate.rater`);
  assertEqual(issues, template.raterType, entry.raterType, `${entry.path} labelTemplate.raterType`);
  assertEqual(issues, template.role, expectedRole, `${entry.path} labelTemplate.role`);
  assertEqual(issues, template.round, entry.round, `${entry.path} labelTemplate.round`);
  assertEqual(issues, template.assignmentId, entry.assignmentId, `${entry.path} labelTemplate.assignmentId`);
  assertEqual(issues, template.evidencePackageId, entry.evidencePackageId, `${entry.path} labelTemplate.evidencePackageId`);
  if (template.sawPeerLabels !== expectedSawPeerLabels) issues.push(`${entry.path} labelTemplate must declare sawPeerLabels=${expectedSawPeerLabels}`);
  if (template.sourceBundleContainsLabels !== expectedSourceBundleContainsLabels) issues.push(`${entry.path} labelTemplate must declare sourceBundleContainsLabels=${expectedSourceBundleContainsLabels}`);
  if (template.claimUse !== expectedClaimUse) issues.push(`${entry.path} labelTemplate must declare claimUse=${expectedClaimUse}`);
  if (template.label !== "") issues.push(`${entry.path} labelTemplate.label must be empty`);
  if (template.rationale !== "") issues.push(`${entry.path} labelTemplate.rationale must be empty`);
  return assignment;
}

export function verifyWorklistLabels(worklistDir, labels, options = {}) {
  const issues = [];
  if (!worklistDir || !fs.existsSync(worklistDir)) {
    return {
      artifactSetSha256: null,
      assignments: 0,
      rounds: [],
      findingIds: [],
      findingIdsByRound: {},
      issues: [`worklist not found: ${worklistDir || "<missing>"}`],
    };
  }
  const bundleDir = options.bundleDir ? path.resolve(options.bundleDir) : null;
  const findingsById = new Map((options.findings || []).map((finding) => [finding.findingId, finding]));
  const labelsByFindingId = new Map();
  for (const label of labels || []) {
    const existing = labelsByFindingId.get(label?.findingId) || [];
    existing.push(label);
    labelsByFindingId.set(label?.findingId, existing);
  }
  if (!bundleDir || findingsById.size === 0) {
    issues.push("worklist verification requires sealed bundleDir and findings for claim-bound evidence binding");
  }
  const study = bundleDir && fs.existsSync(path.join(bundleDir, "study.json")) ? readJson(path.join(bundleDir, "study.json")) : null;
  const context = {
    bundleDir,
    findingsById,
    study,
    studyId: options.studyId || study?.studyId || "",
    labelsByFindingId,
    worklistBundle: null,
  };
  const hashValidation = validateSha256Sums(worklistDir, issues);
  const artifactSetSha256 = hashValidation.artifactSetSha256;
  if (options.expectedArtifactSetSha256 && artifactSetSha256 !== options.expectedArtifactSetSha256) {
    issues.push("protocol worklistArtifactSetSha256 does not match worklist SHA256SUMS");
  }
  const manifestPath = path.join(worklistDir, "worklist.json");
  if (!fs.existsSync(manifestPath)) {
    issues.push("worklist.json is missing");
    return { artifactSetSha256, assignments: 0, rounds: [], findingIds: [], findingIdsByRound: {}, issues };
  }
  const worklist = readJson(manifestPath);
  context.worklistBundle = worklist.bundle || {};
  validateWorklistShape(worklist, issues);
  if (!worklistSchemaVersions.has(worklist.schemaVersion)) {
    issues.push("worklist schemaVersion must be cellfence.precision-label-worklist.v1 or cellfence.precision-label-worklist.v2");
  }
  if (options.studyId && worklist.studyId !== options.studyId) issues.push(`worklist studyId ${worklist.studyId} does not match ${options.studyId}`);
  if (options.bundleArtifactSetSha256 && worklist.bundle?.artifactSetSha256 !== options.bundleArtifactSetSha256) {
    issues.push("worklist bundle.artifactSetSha256 does not match the evidence bundle");
  }
  if (options.preLabelArtifactSetSha256 && worklist.bundle?.preLabelArtifactSetSha256 !== options.preLabelArtifactSetSha256) {
    issues.push("worklist bundle.preLabelArtifactSetSha256 does not match the evidence bundle");
  }
  validateWorklistProtocolBinding(worklist, options.protocol || null, issues);

  const assignments = Array.isArray(worklist.assignments) ? worklist.assignments : [];
  const coveredRounds = new Set(assignments.map((entry) => entry?.round).filter(Boolean));
  if (!Array.isArray(worklist.assignments)) issues.push("worklist.assignments must be an array");
  validateWorklistManifestConsistency(worklist, assignments, issues);
  validateDeclaredWorklistFiles(hashValidation.hashedFiles, assignments, issues);
  const assignmentsById = new Map();
  const seenPaths = new Set();
  for (const entry of assignments) {
    if (seenPaths.has(entry?.path)) issues.push(`duplicate worklist assignment path: ${entry?.path}`);
    seenPaths.add(entry?.path);
    if (assignmentsById.has(entry?.assignmentId)) issues.push(`duplicate worklist assignmentId: ${entry?.assignmentId}`);
    const assignment = validateAssignment(worklistDir, entry, worklist, hashValidation.hashedFiles, context, issues);
    if (assignment?.assignment?.assignmentId) assignmentsById.set(assignment.assignment.assignmentId, assignment);
  }

  for (const [index, label] of labels.entries()) {
    if (!coveredRounds.has(label?.round)) continue;
    const line = index + 1;
    validateClaimLabelMetadata(label, line, issues, { sealedWorklist: true });
    const adjudication = isAdjudication(label);
    if (!adjudication && label.claimUse && label.claimUse !== "blind_labeling") {
      issues.push(`labels.jsonl:${line} is marked ${label.claimUse} and cannot support a claim`);
    }
    if (!adjudication && label.sourceBundleContainsLabels === true) {
      issues.push(`labels.jsonl:${line} came from a diagnostic label-bearing source bundle`);
    }
    const assignment = assignmentsById.get(label.assignmentId);
    if (!assignment) {
      issues.push(`labels.jsonl:${line} has no sealed worklist assignment ${label.assignmentId}`);
      continue;
    }
    const expected = assignment.labelTemplate || {};
    const comparisons = [
      ["findingId", label.findingId, expected.findingId],
      ["rater", label.rater, expected.rater],
      ["raterType", label.raterType || "", expected.raterType || ""],
      ["role", label.role, expected.role],
      ["round", label.round, expected.round],
      ["evidencePackageId", label.evidencePackageId, expected.evidencePackageId],
      ["sawPeerLabels", label.sawPeerLabels, expected.sawPeerLabels],
      ["sourceBundleContainsLabels", label.sourceBundleContainsLabels, expected.sourceBundleContainsLabels],
      ["claimUse", label.claimUse, expected.claimUse],
    ];
    for (const [field, actual, expectedValue] of comparisons) {
      if (actual !== expectedValue) {
        issues.push(`labels.jsonl:${line} ${field} does not match sealed worklist assignment ${label.assignmentId}`);
      }
    }
    if (Array.isArray(assignment.allowedLabels) && !assignment.allowedLabels.includes(label.label)) {
      issues.push(`labels.jsonl:${line} label ${label.label} is not allowed by sealed assignment ${label.assignmentId}`);
    }
  }

  return {
    artifactSetSha256,
    assignments: assignments.length,
    rounds: [...coveredRounds].sort(),
    findingIds: [...new Set(assignments.map((entry) => entry?.findingId).filter(Boolean))].sort(),
    findingIdsByRound: Object.fromEntries([...coveredRounds].sort().map((round) => [
      round,
      [...new Set(assignments.filter((entry) => entry?.round === round).map((entry) => entry?.findingId).filter(Boolean))].sort(),
    ])),
    issues,
  };
}
