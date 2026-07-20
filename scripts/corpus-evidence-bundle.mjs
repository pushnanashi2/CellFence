#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAdjudication, validateClaimLabelMetadata } from "./precision-worklist-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedLabels = new Set([
  "true_positive",
  "false_positive",
  "needs_policy",
  "needs_review",
  "invalid_setup",
  "out_of_scope",
]);
const labelAllowedKeys = new Set([
  "schemaVersion",
  "studyId",
  "findingId",
  "rater",
  "raterType",
  "raterClass",
  "role",
  "round",
  "assignmentId",
  "evidencePackageId",
  "sawPeerLabels",
  "sourceBundleContainsLabels",
  "claimUse",
  "label",
  "rationale",
  "adjudication",
  "adjudicated",
]);
const defaultMinimumPrecision = 0.99;
const defaultConfidence = 0.95;
const defaultMinPerRepository = 3;

function usage() {
  console.error(`Usage:
  node scripts/corpus-evidence-bundle.mjs --study-id id --corpus corpus.json --report report.json --out-dir reports/corpus/id-bundle [--labels labels.jsonl] [--prelabel-artifact-set-sha256 sha256] [--force]
  node scripts/corpus-evidence-bundle.mjs --validate --bundle reports/corpus/id-bundle

Creates and validates a reproducible evidence bundle for corpus findings. The
bundle stores raw audit findings, normalized stable finding IDs, deterministic
sampling metadata, optional manual labels, copied manifests/logs, and SHA256SUMS.

Sampling defaults to the zero-false-positive sample size needed for a one-sided
95% lower bound of 99% precision, capped per rule. Override with
--minimum-precision, --confidence, or --per-rule-cap only when the study
protocol pre-registers a different claim.`);
}

function parseArgs(argv) {
  const parsed = {
    studyId: "",
    corpusPath: "",
    reportPath: "",
    outDir: "",
    labelsPath: "",
    bundleDir: "",
    minimumPrecision: defaultMinimumPrecision,
    confidence: defaultConfidence,
    perRuleCap: null,
    minPerRepository: defaultMinPerRepository,
    preLabelArtifactSetSha256: "",
    force: false,
    validate: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--study-id") {
      parsed.studyId = requireValue(argv, index, "--study-id");
      index += 1;
    } else if (argument.startsWith("--study-id=")) {
      parsed.studyId = requireInlineValue(argument, "--study-id=", "--study-id");
    } else if (argument === "--corpus") {
      parsed.corpusPath = path.resolve(requireValue(argv, index, "--corpus"));
      index += 1;
    } else if (argument.startsWith("--corpus=")) {
      parsed.corpusPath = path.resolve(requireInlineValue(argument, "--corpus=", "--corpus"));
    } else if (argument === "--report") {
      parsed.reportPath = path.resolve(requireValue(argv, index, "--report"));
      index += 1;
    } else if (argument.startsWith("--report=")) {
      parsed.reportPath = path.resolve(requireInlineValue(argument, "--report=", "--report"));
    } else if (argument === "--out-dir") {
      parsed.outDir = path.resolve(requireValue(argv, index, "--out-dir"));
      index += 1;
    } else if (argument.startsWith("--out-dir=")) {
      parsed.outDir = path.resolve(requireInlineValue(argument, "--out-dir=", "--out-dir"));
    } else if (argument === "--labels") {
      parsed.labelsPath = path.resolve(requireValue(argv, index, "--labels"));
      index += 1;
    } else if (argument.startsWith("--labels=")) {
      parsed.labelsPath = path.resolve(requireInlineValue(argument, "--labels=", "--labels"));
    } else if (argument === "--bundle") {
      parsed.bundleDir = path.resolve(requireValue(argv, index, "--bundle"));
      index += 1;
    } else if (argument.startsWith("--bundle=")) {
      parsed.bundleDir = path.resolve(requireInlineValue(argument, "--bundle=", "--bundle"));
    } else if (argument === "--minimum-precision") {
      parsed.minimumPrecision = parseUnitInterval(requireValue(argv, index, "--minimum-precision"), "--minimum-precision");
      index += 1;
    } else if (argument.startsWith("--minimum-precision=")) {
      parsed.minimumPrecision = parseUnitInterval(requireInlineValue(argument, "--minimum-precision=", "--minimum-precision"), "--minimum-precision");
    } else if (argument === "--confidence") {
      parsed.confidence = parseUnitInterval(requireValue(argv, index, "--confidence"), "--confidence");
      index += 1;
    } else if (argument.startsWith("--confidence=")) {
      parsed.confidence = parseUnitInterval(requireInlineValue(argument, "--confidence=", "--confidence"), "--confidence");
    } else if (argument === "--per-rule-cap") {
      parsed.perRuleCap = parsePositiveInteger(requireValue(argv, index, "--per-rule-cap"), "--per-rule-cap");
      index += 1;
    } else if (argument.startsWith("--per-rule-cap=")) {
      parsed.perRuleCap = parsePositiveInteger(requireInlineValue(argument, "--per-rule-cap=", "--per-rule-cap"), "--per-rule-cap");
    } else if (argument === "--min-per-repository") {
      parsed.minPerRepository = parsePositiveInteger(requireValue(argv, index, "--min-per-repository"), "--min-per-repository");
      index += 1;
    } else if (argument.startsWith("--min-per-repository=")) {
      parsed.minPerRepository = parsePositiveInteger(requireInlineValue(argument, "--min-per-repository=", "--min-per-repository"), "--min-per-repository");
    } else if (argument === "--prelabel-artifact-set-sha256") {
      parsed.preLabelArtifactSetSha256 = requireSha256(requireValue(argv, index, "--prelabel-artifact-set-sha256"), "--prelabel-artifact-set-sha256");
      index += 1;
    } else if (argument.startsWith("--prelabel-artifact-set-sha256=")) {
      parsed.preLabelArtifactSetSha256 = requireSha256(requireInlineValue(argument, "--prelabel-artifact-set-sha256=", "--prelabel-artifact-set-sha256"), "--prelabel-artifact-set-sha256");
    } else if (argument === "--force") {
      parsed.force = true;
    } else if (argument === "--validate") {
      parsed.validate = true;
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (parsed.validate) {
    if (!parsed.bundleDir) throw new Error("--bundle is required with --validate");
    return parsed;
  }
  if (!parsed.studyId) throw new Error("--study-id is required");
  if (!/^[a-zA-Z0-9._-]+$/.test(parsed.studyId)) throw new Error("--study-id may contain only letters, numbers, dot, underscore, and dash");
  if (!parsed.corpusPath) throw new Error("--corpus is required");
  if (!parsed.reportPath) throw new Error("--report is required");
  if (!parsed.outDir) throw new Error("--out-dir is required");
  return parsed;
}

function parseUnitInterval(value, optionName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    throw new Error(`${optionName} must be greater than 0 and less than 1`);
  }
  return parsed;
}

function parsePositiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function requireSha256(value, optionName) {
  if (!/^[a-f0-9]{64}$/.test(String(value))) throw new Error(`${optionName} must be a lowercase 64-hex SHA-256 digest`);
  return value;
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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateLabelShape(label, lineNumber, findings) {
  if (!isRecord(label)) {
    findings.push(`labels.jsonl:${lineNumber} must be an object`);
    return false;
  }
  for (const key of Object.keys(label)) {
    if (!labelAllowedKeys.has(key)) findings.push(`labels.jsonl:${lineNumber} has unexpected field ${key}`);
  }
  return true;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const records = [];
  for (const [index, line] of fs.readFileSync(filePath, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return records;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "");
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hashText(value) {
  return hashBuffer(Buffer.from(String(value)));
}

function hashFile(filePath) {
  return hashBuffer(fs.readFileSync(filePath));
}

function posixify(value) {
  return String(value).replace(/\\/g, "/").split(path.sep).join("/");
}

function resolveBundleRelativePath(bundleDir, relativePath, findings, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    findings.push(`${label} is missing`);
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
    findings.push(`${label} has unsafe bundle path: ${relativePath}`);
    return null;
  }
  const bundleRoot = path.resolve(bundleDir);
  const resolved = path.resolve(bundleRoot, relativePath);
  const lexicalRelative = path.relative(bundleRoot, resolved);
  if (lexicalRelative === "" || lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    findings.push(`${label} escapes bundle root: ${relativePath}`);
    return null;
  }
  if (fs.existsSync(resolved)) {
    const realRoot = fs.realpathSync.native(bundleRoot);
    const realResolved = fs.realpathSync.native(resolved);
    const realRelative = path.relative(realRoot, realResolved);
    if (realRelative === "" || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      findings.push(`${label} resolves outside bundle root: ${relativePath}`);
      return null;
    }
  }
  return resolved;
}

function safeName(value) {
  const slug = String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "subject";
  return `${slug}-${hashText(value).slice(0, 12)}`;
}

function listFilesRecursive(baseDir, findings = null, rootDir = baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  const entries = [];
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isSymbolicLink()) {
      if (findings) findings.push(`bundle contains symlink: ${posixify(path.relative(rootDir, fullPath))}`);
    } else if (entry.isDirectory()) {
      entries.push(...listFilesRecursive(fullPath, findings, rootDir));
    } else if (entry.isFile()) {
      entries.push(fullPath);
    }
  }
  return entries.sort((left, right) => posixify(path.relative(rootDir, left)).localeCompare(posixify(path.relative(rootDir, right))));
}

function copyFileEnsuringDirectory(sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function copyDirectoryFiles(sourceDir, targetDir) {
  if (!sourceDir || !fs.existsSync(sourceDir)) return [];
  const copied = [];
  for (const sourcePath of listFilesRecursive(sourceDir)) {
    const relativePath = posixify(path.relative(sourceDir, sourcePath));
    const targetPath = path.join(targetDir, relativePath);
    copyFileEnsuringDirectory(sourcePath, targetPath);
    copied.push(posixify(path.relative(targetDir, targetPath)));
  }
  return copied;
}

function manifestReviewStatus(subject) {
  const strategy = subject.manifest?.strategy || "existing";
  if (subject.manifest?.reviewStatus) return subject.manifest.reviewStatus;
  if (strategy === "existing") return "existing";
  if (strategy === "copy") return "unreviewed";
  if (strategy === "infer") return "generated";
  return "unknown";
}

function precisionEligible(subject) {
  const strategy = subject.manifest?.strategy || "existing";
  const reviewStatus = manifestReviewStatus(subject);
  return (strategy === "existing" || strategy === "copy") && reviewStatus === "reviewed";
}

function fallbackFingerprint(event) {
  return hashText(JSON.stringify({
    ruleId: event.ruleId || null,
    filePath: event.filePath || null,
    message: event.message || null,
    details: event.details || null,
  }));
}

function findingIdentityParts(rawFinding) {
  const { subject, event } = rawFinding;
  const ruleId = String(event.ruleId || "CELLFENCE_UNKNOWN_RULE");
  const fingerprint = String(event.fingerprint || fallbackFingerprint(event));
  const commit = subject.commit || subject.requestedCommit || null;
  const manifestSha256 = subject.manifest?.sha256 || null;
  return { ruleId, fingerprint, commit, manifestSha256 };
}

function normalizeFinding(studyId, rawFinding, occurrenceIndex = 0) {
  const { subject, event } = rawFinding;
  const { ruleId, fingerprint, commit, manifestSha256 } = findingIdentityParts(rawFinding);
  const stableIdParts = [subject.id, commit || "", manifestSha256 || "", ruleId, fingerprint];
  if (occurrenceIndex > 0) stableIdParts.push(String(occurrenceIndex));
  const findingId = `sha256:${hashText(stableIdParts.join("\0"))}`;
  return {
    schemaVersion: "cellfence.corpus-finding.v1",
    studyId,
    findingId,
    occurrenceIndex,
    subjectId: subject.id,
    repository: subject.repository || null,
    commit,
    gitTree: subject.gitTree || null,
    manifestSha256,
    manifestStrategy: subject.manifest?.strategy || "existing",
    manifestReviewStatus: manifestReviewStatus(subject),
    precisionEligible: precisionEligible(subject),
    ruleId,
    severity: event.severity || null,
    filePath: event.filePath ? posixify(event.filePath) : null,
    line: typeof event.line === "number" ? event.line : null,
    message: event.message || "",
    cellfenceFingerprint: fingerprint,
    cellId: event.cellId || null,
    producerCellId: event.producerCellId || null,
    outcome: event.outcome || null,
  };
}

function normalizeFindings(studyId, rawFindings) {
  const occurrenceCounts = new Map();
  return rawFindings.map((rawFinding) => {
    const { ruleId, fingerprint, commit, manifestSha256 } = findingIdentityParts(rawFinding);
    const occurrenceKey = [rawFinding.subject.id, commit || "", manifestSha256 || "", ruleId, fingerprint].join("\0");
    const occurrenceIndex = occurrenceCounts.get(occurrenceKey) || 0;
    occurrenceCounts.set(occurrenceKey, occurrenceIndex + 1);
    return normalizeFinding(studyId, rawFinding, occurrenceIndex);
  });
}

function findingSortKey(finding) {
  return [
    finding.subjectId || "",
    finding.ruleId || "",
    finding.filePath || "",
    String(finding.line ?? ""),
    finding.cellfenceFingerprint || "",
    finding.findingId || "",
  ].join("\0");
}

function sortFindings(findings) {
  return [...findings].sort((left, right) => findingSortKey(left).localeCompare(findingSortKey(right)));
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

function preLabelArtifactSetSha256(bundleDir) {
  const excluded = new Set(["SHA256SUMS", "labels.jsonl", "study.json"]);
  const artifacts = listFilesRecursive(bundleDir)
    .map((filePath) => posixify(path.relative(bundleDir, filePath)))
    .filter((relativePath) => !excluded.has(relativePath))
    .sort()
    .map((relativePath) => ({
      path: relativePath,
      sha256: hashFile(path.join(bundleDir, relativePath)),
    }));
  return hashText(canonicalJson(artifacts));
}

function collectRawFindings(report, studyId) {
  const rawFindings = [];
  for (const subject of report.subjects || []) {
    const auditLogPath = subject.check?.auditLogPath;
    const expectedFindings = Number.isInteger(subject.check?.findings) ? subject.check.findings : null;
    if (!auditLogPath || !fs.existsSync(auditLogPath)) {
      if ((expectedFindings ?? 0) > 0) {
        throw new Error(`audit log is missing for ${subject.id}; report claims ${expectedFindings} findings`);
      }
      continue;
    }
    if (!subject.check?.auditLogSha256) {
      throw new Error(`audit log SHA-256 is missing for ${subject.id}`);
    }
    if (hashFile(auditLogPath) !== subject.check.auditLogSha256) {
      throw new Error(`audit log hash mismatch for ${subject.id}`);
    }
    let subjectFindings = 0;
    for (const [eventIndex, event] of readJsonl(auditLogPath).entries()) {
      if (event.event !== "finding.detected") continue;
      if (event.outcome !== "rejected") continue;
      subjectFindings += 1;
      rawFindings.push({
        schemaVersion: "cellfence.corpus-raw-finding.v1",
        studyId,
        subjectId: subject.id,
        auditLogPath,
        eventIndex,
        event,
        subject: {
          id: subject.id,
          repository: subject.repository || null,
          requestedCommit: subject.requestedCommit || null,
          commit: subject.commit || null,
          gitTree: subject.gitTree || null,
          manifest: subject.manifest || null,
        },
      });
    }
    if (expectedFindings !== null && subjectFindings !== expectedFindings) {
      throw new Error(`audit log finding count mismatch for ${subject.id}: report=${expectedFindings} audit=${subjectFindings}`);
    }
  }
  if (Number.isInteger(report.summary?.totalFindings) && rawFindings.length !== report.summary.totalFindings) {
    throw new Error(`report.summary.totalFindings mismatch: report=${report.summary.totalFindings} audit=${rawFindings.length}`);
  }
  return rawFindings;
}

function deterministicRank(seed, findingId) {
  return hashText(`${seed}\0${findingId}`);
}

function requiredZeroFalsePositiveSampleSize(minimumPrecision, confidence) {
  return Math.ceil(Math.log(1 - confidence) / Math.log(minimumPrecision));
}

function groupedBy(values, keyFn) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFn(value);
    const existing = groups.get(key) || [];
    existing.push(value);
    groups.set(key, existing);
  }
  return groups;
}

function deterministicSample(findings, corpusSha256, options = {}) {
  const minimumPrecision = options.minimumPrecision || defaultMinimumPrecision;
  const confidence = options.confidence || defaultConfidence;
  const powerBasedPerRuleCap = requiredZeroFalsePositiveSampleSize(minimumPrecision, confidence);
  const perRuleCap = options.perRuleCap || powerBasedPerRuleCap;
  const minPerRepository = options.minPerRepository || defaultMinPerRepository;
  const seed = `sha256:${corpusSha256}`;
  const selectedIds = new Set();
  const byRule = groupedBy(findings, (finding) => finding.ruleId);

  for (const [, ruleFindings] of byRule) {
    const sortedRuleFindings = [...ruleFindings].sort((left, right) => {
      return deterministicRank(seed, left.findingId).localeCompare(deterministicRank(seed, right.findingId));
    });
    for (const finding of sortedRuleFindings.slice(0, Math.min(perRuleCap, sortedRuleFindings.length))) {
      selectedIds.add(finding.findingId);
    }
  }

  const byRepository = groupedBy(findings, (finding) => finding.repository || finding.subjectId);
  for (const [, repositoryFindings] of byRepository) {
    const selectedCount = repositoryFindings.filter((finding) => selectedIds.has(finding.findingId)).length;
    if (selectedCount >= minPerRepository) continue;
    const sortedRepositoryFindings = [...repositoryFindings].sort((left, right) => {
      return deterministicRank(seed, left.findingId).localeCompare(deterministicRank(seed, right.findingId));
    });
    for (const finding of sortedRepositoryFindings) {
      if (selectedIds.has(finding.findingId)) continue;
      selectedIds.add(finding.findingId);
      if (repositoryFindings.filter((candidate) => selectedIds.has(candidate.findingId)).length >= minPerRepository) break;
    }
  }

  const sampledFindings = sortFindings(findings.filter((finding) => selectedIds.has(finding.findingId)));
  const precisionEligibleFindings = findings.filter((finding) => finding.precisionEligible);
  return {
    schemaVersion: "cellfence.corpus-sampling.v1",
    seed,
    method: "all findings when a rule has no more findings than the pre-registered per-rule cap; otherwise deterministic per-rule sampling, then ensure a minimum number of findings per repository when available",
    powerAnalysis: {
      metric: "one-sided exact binomial lower bound",
      zeroFalsePositiveMinimumPrecision: minimumPrecision,
      confidence,
      zeroFalsePositiveSampleSize: powerBasedPerRuleCap,
    },
    perRuleCap,
    minPerRepository,
    population: {
      totalFindings: findings.length,
      sampledFindings: sampledFindings.length,
      precisionEligibleFindings: precisionEligibleFindings.length,
      precisionDenominator: {
        eligibleManifestStrategies: ["existing", "copy:reviewed"],
        excludedManifestStrategies: ["infer", "copy:unreviewed"],
      },
    },
    sampledFindingIds: sampledFindings.map((finding) => finding.findingId),
    sampledByRule: Object.fromEntries([...groupedBy(sampledFindings, (finding) => finding.ruleId)].map(([ruleId, ruleFindings]) => [ruleId, ruleFindings.length]).sort()),
  };
}

function writeSha256Sums(bundleDir) {
  const files = listFilesRecursive(bundleDir)
    .filter((filePath) => path.basename(filePath) !== "SHA256SUMS")
    .map((filePath) => posixify(path.relative(bundleDir, filePath)))
    .sort();
  const lines = files.map((relativePath) => `${hashFile(path.join(bundleDir, relativePath))}  ${relativePath}`);
  fs.writeFileSync(path.join(bundleDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

function readSha256Sums(bundleDir, findings) {
  const sumsPath = path.join(bundleDir, "SHA256SUMS");
  if (!fs.existsSync(sumsPath)) {
    findings.push("SHA256SUMS is missing");
    return new Map();
  }
  const sums = new Map();
  for (const [index, line] of fs.readFileSync(sumsPath, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      findings.push(`SHA256SUMS:${index + 1} is malformed`);
      continue;
    }
    const relativePath = match[2];
    if (sums.has(relativePath)) findings.push(`SHA256SUMS:${index + 1} duplicates ${relativePath}`);
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
      findings.push(`SHA256SUMS:${index + 1} has unsafe path ${relativePath}`);
    }
    sums.set(relativePath, match[1]);
  }
  return sums;
}

function validateSha256Sums(bundleDir, findings) {
  const expected = readSha256Sums(bundleDir, findings);
  const actualFiles = listFilesRecursive(bundleDir, findings)
    .filter((filePath) => path.basename(filePath) !== "SHA256SUMS")
    .map((filePath) => posixify(path.relative(bundleDir, filePath)))
    .sort();
  const expectedFiles = [...expected.keys()].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    findings.push("SHA256SUMS file list does not match bundle contents");
    return;
  }
  for (const relativePath of actualFiles) {
    const actualHash = hashFile(path.join(bundleDir, relativePath));
    if (actualHash !== expected.get(relativePath)) {
      findings.push(`SHA256 mismatch for ${relativePath}`);
    }
  }
}

function validateLabels(bundleDir, normalizedFindings, sampling, findings) {
  const labelsPath = path.join(bundleDir, "labels.jsonl");
  if (!fs.existsSync(labelsPath)) {
    findings.push("labels.jsonl is missing");
    return;
  }
  const study = readJson(path.join(bundleDir, "study.json"));
  const findingIds = new Set(normalizedFindings.map((finding) => finding.findingId));
  const seenRaterFinding = new Set();
  for (const [index, label] of readJsonl(labelsPath).entries()) {
    const lineNumber = index + 1;
    if (!validateLabelShape(label, lineNumber, findings)) continue;
    if (label.schemaVersion !== "cellfence.corpus-label.v1") findings.push(`labels.jsonl:${lineNumber} has unexpected schemaVersion`);
    if (label.studyId !== study.studyId) findings.push(`labels.jsonl:${lineNumber} has unexpected studyId`);
    if (!findingIds.has(label.findingId)) findings.push(`labels.jsonl:${lineNumber} references unknown findingId ${label.findingId}`);
    if (!allowedLabels.has(label.label)) findings.push(`labels.jsonl:${lineNumber} has unknown label '${label.label}'`);
    if (!label.rater || typeof label.rater !== "string") findings.push(`labels.jsonl:${lineNumber} is missing rater`);
    if (!label.rationale || typeof label.rationale !== "string" || label.rationale.trim().length === 0) {
      findings.push(`labels.jsonl:${lineNumber} is missing rationale`);
    }
    validateClaimLabelMetadata(label, lineNumber, findings);
    if (isAdjudication(label)) {
      if (label.round && label.round !== "adjudication") findings.push(`labels.jsonl:${lineNumber} adjudication label must use round=adjudication`);
    } else {
      if (label.round !== "blind_first" && label.round !== "blind_second") {
        findings.push(`labels.jsonl:${lineNumber} independent label must use round=blind_first or round=blind_second`);
      }
      if (label.sawPeerLabels !== false) findings.push(`labels.jsonl:${lineNumber} independent label must declare sawPeerLabels=false`);
    }
    if (!label.assignmentId || typeof label.assignmentId !== "string") findings.push(`labels.jsonl:${lineNumber} is missing assignmentId`);
    if (!label.evidencePackageId || typeof label.evidencePackageId !== "string") findings.push(`labels.jsonl:${lineNumber} is missing evidencePackageId`);
    const duplicateKey = `${label.rater}\0${label.findingId}`;
    if (seenRaterFinding.has(duplicateKey)) findings.push(`labels.jsonl:${lineNumber} duplicates rater/finding label ${label.rater}/${label.findingId}`);
    seenRaterFinding.add(duplicateKey);
  }
  if (!sampling || !Array.isArray(sampling.sampledFindingIds)) findings.push("sampling.json is missing sampledFindingIds");
}

function validateManifestHashes(bundleDir, report, findings) {
  const copiedManifests = new Map();
  for (const filePath of listFilesRecursive(path.join(bundleDir, "manifests"))) {
    copiedManifests.set(path.basename(filePath, ".json"), filePath);
  }
  for (const subject of report.subjects || []) {
    if (!subject.manifest?.sha256) continue;
    const filePath = copiedManifests.get(safeName(subject.id));
    if (!filePath) {
      findings.push(`manifest copy is missing for ${subject.id}`);
    } else if (hashFile(filePath) !== subject.manifest.sha256) {
      findings.push(`manifest hash mismatch for ${subject.id}`);
    }
  }
}

function validateStudyCopies(bundleDir, study, findings) {
  if (!Array.isArray(study.manifestCopies)) {
    findings.push("study.json is missing manifestCopies");
  } else {
    for (const copy of study.manifestCopies) {
      const copyPath = resolveBundleRelativePath(bundleDir, copy?.path, findings, `manifest copy path ${copy?.path || "<unknown>"}`);
      if (!copyPath || !fs.existsSync(copyPath)) findings.push(`manifest copy is missing: ${copy?.path || "<unknown>"}`);
      else if (copy.sha256 && hashFile(copyPath) !== copy.sha256) findings.push(`manifest copy hash mismatch: ${copy.path}`);
    }
  }
  if (!Array.isArray(study.logCopies)) {
    findings.push("study.json is missing logCopies");
  } else {
    for (const copy of study.logCopies) {
      const copyPath = resolveBundleRelativePath(bundleDir, copy?.path, findings, `log copy path ${copy?.path || "<unknown>"}`);
      if (!copyPath || !fs.existsSync(copyPath)) findings.push(`log copy is missing: ${copy?.path || "<unknown>"}`);
    }
  }
}

function validateRawFindingsAgainstLogs(bundleDir, study, report, rawFindings, findings) {
  const logCopies = Array.isArray(study.logCopies) ? study.logCopies : [];
  const rawBySubject = new Map();
  const logEvents = new Map();
  const eventsFor = (copy) => {
    if (!copy?.path) return [];
    if (!logEvents.has(copy.path)) {
      const logPath = resolveBundleRelativePath(bundleDir, copy.path, findings, `log copy path ${copy.path}`);
      logEvents.set(copy.path, logPath && fs.existsSync(logPath) ? readJsonl(logPath) : []);
    }
    return logEvents.get(copy.path) || [];
  };
  const reportLogs = new Map();
  for (const rawFinding of rawFindings) {
    const subjectFindings = rawBySubject.get(rawFinding.subjectId) || [];
    subjectFindings.push(rawFinding);
    rawBySubject.set(rawFinding.subjectId, subjectFindings);
  }

  for (const subject of report.subjects || []) {
    if (!subject.check?.auditLogSha256) continue;
    const basename = path.basename(subject.check.auditLogPath || "check.audit.jsonl");
    const candidates = logCopies.filter((copy) => copy?.subjectId === subject.id && path.basename(copy.path || "") === basename);
    if (candidates.length === 0) {
      findings.push(`report audit log copy is missing for ${subject.id}`);
      continue;
    }
    const matchingCopies = candidates.filter((copy) => {
      const copyPath = resolveBundleRelativePath(bundleDir, copy.path, findings, `log copy path ${copy.path}`);
      return copyPath && fs.existsSync(copyPath) && hashFile(copyPath) === subject.check.auditLogSha256;
    });
    if (matchingCopies.length === 0) {
      findings.push(`report audit log hash does not match copied log for ${subject.id}`);
      continue;
    }
    if (matchingCopies.length > 1) {
      findings.push(`report audit log hash is ambiguous for ${subject.id}`);
      continue;
    }
    reportLogs.set(subject.id, matchingCopies[0]);

    const rejectedEvents = eventsFor(matchingCopies[0])
      .map((event, eventIndex) => ({ event, eventIndex }))
      .filter(({ event }) => event?.event === "finding.detected" && event.outcome === "rejected");
    const subjectRawFindings = rawBySubject.get(subject.id) || [];
    if (Number.isInteger(subject.check?.findings) && subject.check.findings !== rejectedEvents.length) {
      findings.push(`report finding count does not match copied audit log for ${subject.id}`);
    }
    if (subjectRawFindings.length !== rejectedEvents.length) {
      findings.push(`raw finding count does not match copied audit log for ${subject.id}`);
    }
    const expectedIndexes = rejectedEvents.map(({ eventIndex }) => eventIndex).sort((left, right) => left - right);
    const rawIndexes = subjectRawFindings.map((finding) => finding.eventIndex).sort((left, right) => left - right);
    if (rawIndexes.some((eventIndex) => !Number.isInteger(eventIndex) || eventIndex < 0)) {
      findings.push(`raw findings include invalid eventIndex for ${subject.id}`);
    } else if (new Set(rawIndexes).size !== rawIndexes.length) {
      findings.push(`raw findings repeat an audit eventIndex for ${subject.id}`);
    } else if (canonicalJson(rawIndexes) !== canonicalJson(expectedIndexes)) {
      findings.push(`raw finding eventIndex set does not match copied audit log for ${subject.id}`);
    }
  }

  for (const rawFinding of rawFindings) {
    const reportLog = reportLogs.get(rawFinding.subjectId);
    if (!reportLog) {
      findings.push(`raw finding ${rawFinding.subjectId}:${rawFinding.eventIndex} has no verified report audit log`);
      continue;
    }
    const events = eventsFor(reportLog);
    if (canonicalJson(events[rawFinding.eventIndex]) !== canonicalJson(rawFinding.event)) {
      findings.push(`raw finding ${rawFinding.subjectId}:${rawFinding.eventIndex} does not match copied report audit log event`);
    }
  }
}

function validateBundle(bundleDir) {
  const findings = [];
  if (!fs.existsSync(bundleDir)) throw new Error(`bundle not found: ${bundleDir}`);
  const study = readJson(path.join(bundleDir, "study.json"));
  const corpus = readJson(path.join(bundleDir, "corpus.json"));
  const report = readJson(path.join(bundleDir, "report.json"));
  const rawFindings = readJsonl(path.join(bundleDir, "findings.raw.jsonl"));
  const normalizedFindings = readJsonl(path.join(bundleDir, "findings.normalized.jsonl"));
  const sampling = readJson(path.join(bundleDir, "sampling.json"));

  if (study.schemaVersion !== "cellfence.corpus-evidence-bundle.v1") findings.push("study.json has unexpected schemaVersion");
  if (corpus.schemaVersion !== "cellfence.corpus.v1") findings.push("corpus.json has unexpected schemaVersion");
  if (report.schemaVersion !== "cellfence.corpus-study.v1") findings.push("report.json has unexpected schemaVersion");
  if (canonicalJson(study.environment || {}) !== canonicalJson(report.environment || {})) {
    findings.push("study.environment does not match sealed report.environment");
  }
  if (Number.isInteger(study.summary?.rawFindings) && study.summary.rawFindings !== rawFindings.length) {
    findings.push("study.summary.rawFindings does not match findings.raw.jsonl");
  }
  if (Number.isInteger(study.summary?.normalizedFindings) && study.summary.normalizedFindings !== normalizedFindings.length) {
    findings.push("study.summary.normalizedFindings does not match findings.normalized.jsonl");
  }
  if (Number.isInteger(report.summary?.totalFindings) && report.summary.totalFindings !== rawFindings.length) {
    findings.push("report.summary.totalFindings does not match findings.raw.jsonl");
  }
  if (rawFindings.length > 0 && Array.isArray(study.logCopies) && study.logCopies.length === 0) {
    findings.push("study.logCopies is empty despite raw findings");
  }
  const expectedPreLabelArtifactSetSha256 = preLabelArtifactSetSha256(bundleDir);
  if (!study.preregistration?.preLabelArtifactSetSha256) {
    findings.push("study.preregistration.preLabelArtifactSetSha256 is missing");
  } else if (study.preregistration.preLabelArtifactSetSha256 !== expectedPreLabelArtifactSetSha256) {
    findings.push("study.preregistration.preLabelArtifactSetSha256 does not match bundle artifacts");
  }
  const recomputedFindings = sortFindings(normalizeFindings(study.studyId, rawFindings));
  if (canonicalJson(recomputedFindings) !== canonicalJson(normalizedFindings)) {
    findings.push("findings.normalized.jsonl does not match findings.raw.jsonl");
  }

  const sortedFindingIds = sortFindings(normalizedFindings).map((finding) => finding.findingId);
  if (JSON.stringify(sortedFindingIds) !== JSON.stringify(normalizedFindings.map((finding) => finding.findingId))) {
    findings.push("findings.normalized.jsonl is not sorted by stable finding key");
  }
  const uniqueFindingIds = new Set();
  for (const finding of normalizedFindings) {
    if (uniqueFindingIds.has(finding.findingId)) findings.push(`duplicate findingId ${finding.findingId}`);
    uniqueFindingIds.add(finding.findingId);
    if (finding.studyId !== study.studyId) findings.push(`finding ${finding.findingId} has unexpected studyId`);
  }
  for (const findingId of sampling.sampledFindingIds || []) {
    if (!uniqueFindingIds.has(findingId)) findings.push(`sampling.json references unknown findingId ${findingId}`);
  }

  validateLabels(bundleDir, normalizedFindings, sampling, findings);
  validateStudyCopies(bundleDir, study, findings);
  validateRawFindingsAgainstLogs(bundleDir, study, report, rawFindings, findings);
  validateManifestHashes(bundleDir, report, findings);
  validateSha256Sums(bundleDir, findings);

  if (findings.length > 0) {
    throw new Error(findings.join("\n"));
  }
  return {
    studyId: study.studyId,
    findings: normalizedFindings.length,
    sampledFindings: sampling.sampledFindingIds.length,
  };
}

function buildBundle(options) {
  if (fs.existsSync(options.outDir)) {
    if (!options.force) throw new Error(`output directory already exists: ${options.outDir}`);
    fs.rmSync(options.outDir, { recursive: true, force: true });
  }
  const tempDir = `${options.outDir}.tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    const corpus = readJson(options.corpusPath);
    const report = readJson(options.reportPath);
    const rawFindings = collectRawFindings(report, options.studyId);
    const normalizedFindings = sortFindings(normalizeFindings(options.studyId, rawFindings));
    const sampling = deterministicSample(normalizedFindings, report.environment?.corpusSha256 || hashFile(options.corpusPath), {
      minimumPrecision: options.minimumPrecision,
      confidence: options.confidence,
      perRuleCap: options.perRuleCap,
      minPerRepository: options.minPerRepository,
    });
    const sampledFindingSet = new Set(sampling.sampledFindingIds);
    const sampledFindings = normalizedFindings.filter((finding) => sampledFindingSet.has(finding.findingId));

    copyFileEnsuringDirectory(options.corpusPath, path.join(tempDir, "corpus.json"));
    copyFileEnsuringDirectory(options.reportPath, path.join(tempDir, "report.json"));
    if (options.labelsPath) {
      copyFileEnsuringDirectory(options.labelsPath, path.join(tempDir, "labels.jsonl"));
    } else {
      fs.writeFileSync(path.join(tempDir, "labels.jsonl"), "");
    }

    const manifestCopies = [];
    const logCopies = [];
    for (const subject of report.subjects || []) {
      const stem = safeName(subject.id);
      if (subject.manifest?.effectivePath && fs.existsSync(subject.manifest.effectivePath)) {
        const targetPath = path.join(tempDir, "manifests", `${stem}.json`);
        copyFileEnsuringDirectory(subject.manifest.effectivePath, targetPath);
        manifestCopies.push({
          subjectId: subject.id,
          path: posixify(path.relative(tempDir, targetPath)),
          sha256: hashFile(targetPath),
        });
      }
      if (subject.subjectDir) {
        const copiedLogs = copyDirectoryFiles(path.join(subject.subjectDir, "logs"), path.join(tempDir, "logs", stem));
        for (const copiedLog of copiedLogs) {
          logCopies.push({
            subjectId: subject.id,
            path: posixify(path.join("logs", stem, copiedLog)),
          });
        }
      }
    }

    writeJsonl(path.join(tempDir, "findings.raw.jsonl"), rawFindings);
    writeJsonl(path.join(tempDir, "findings.normalized.jsonl"), normalizedFindings);
    writeJsonl(path.join(tempDir, "findings.sampled.jsonl"), sampledFindings);
    writeJson(path.join(tempDir, "sampling.json"), sampling);
    const computedPreLabelArtifactSetSha256 = preLabelArtifactSetSha256(tempDir);
    if (options.preLabelArtifactSetSha256 && options.preLabelArtifactSetSha256 !== computedPreLabelArtifactSetSha256) {
      throw new Error("--prelabel-artifact-set-sha256 does not match the computed pre-label artifact set");
    }

    writeJson(path.join(tempDir, "study.json"), {
      schemaVersion: "cellfence.corpus-evidence-bundle.v1",
      studyId: options.studyId,
      createdAt: new Date().toISOString(),
      createdBy: "scripts/corpus-evidence-bundle.mjs",
      host: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
      },
      source: {
        corpusPath: path.relative(repoRoot, options.corpusPath) || options.corpusPath,
        corpusSha256: hashFile(options.corpusPath),
        reportPath: path.relative(repoRoot, options.reportPath) || options.reportPath,
        reportSha256: hashFile(options.reportPath),
      },
      environment: report.environment || {},
      preregistration: {
        preLabelArtifactSetSha256: computedPreLabelArtifactSetSha256,
      },
      summary: {
        subjects: (report.subjects || []).length,
        rawFindings: rawFindings.length,
        normalizedFindings: normalizedFindings.length,
        sampledFindings: sampledFindings.length,
      },
      manifestCopies,
      logCopies,
      labels: {
        path: "labels.jsonl",
        allowedLabels: [...allowedLabels].sort(),
        requiredFields: ["findingId", "rater", "round", "assignmentId", "evidencePackageId", "sawPeerLabels", "label", "rationale"],
      },
    });
    writeSha256Sums(tempDir);
    validateBundle(tempDir);
    fs.renameSync(tempDir, options.outDir);
    return validateBundle(options.outDir);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    const result = options.validate ? validateBundle(options.bundleDir) : buildBundle(options);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export { validateBundle };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
