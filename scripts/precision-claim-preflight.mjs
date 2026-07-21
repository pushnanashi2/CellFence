#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAdjudication, labelRaterType, posixify, validateClaimLabelMetadata, verifyWorklistLabels } from "./precision-worklist-lib.mjs";

const reportSchemaVersion = "cellfence.precision-claim-preflight.v1";
const protocolSchemaVersion = "cellfence.precision-claim-protocol.v1";
const defaultMinimumPrecision = 0.99;
const defaultConfidence = 0.95;
const defaultMaxRepositoryContribution = 0.1;
const defaultBlockingSeverities = ["error"];
const allowedLabels = new Set(["true_positive", "false_positive", "needs_policy", "needs_review", "invalid_setup", "out_of_scope"]);
const blockingDenominatorLabels = new Set(["true_positive", "false_positive", "needs_policy", "needs_review"]);
const blockingSuccessLabels = new Set(["true_positive"]);
const nonHumanRaterPattern = /\b(agent|codex|llm|bot|automated)\b/i;
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

function usage() {
  console.error(`Usage:
  node scripts/precision-claim-preflight.mjs --bundle reports/corpus/id-bundle --protocol protocol.json [--worklist reports/corpus/id-worklist ...] [--out report.json]

Reports whether a sealed precision bundle has enough sampled, reviewed,
balanced, independently labeled evidence to attempt the requested claim. This is
a preflight: exit 0 means the claim run is worth attempting, exit 1 means the
evidence/protocol is valid but not claim-ready, and exit 2 means inputs are
malformed.`);
}

function parseArgs(argv) {
  const parsed = { bundleDir: "", protocolPath: "", worklistDirs: [], outPath: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--bundle") {
      parsed.bundleDir = path.resolve(requireValue(argv, index, "--bundle"));
      index += 1;
    } else if (argument.startsWith("--bundle=")) {
      parsed.bundleDir = path.resolve(requireInlineValue(argument, "--bundle=", "--bundle"));
    } else if (argument === "--protocol") {
      parsed.protocolPath = path.resolve(requireValue(argv, index, "--protocol"));
      index += 1;
    } else if (argument.startsWith("--protocol=")) {
      parsed.protocolPath = path.resolve(requireInlineValue(argument, "--protocol=", "--protocol"));
    } else if (argument === "--worklist") {
      parsed.worklistDirs.push(path.resolve(requireValue(argv, index, "--worklist")));
      index += 1;
    } else if (argument.startsWith("--worklist=")) {
      parsed.worklistDirs.push(path.resolve(requireInlineValue(argument, "--worklist=", "--worklist")));
    } else if (argument === "--out") {
      parsed.outPath = path.resolve(requireValue(argv, index, "--out"));
      index += 1;
    } else if (argument.startsWith("--out=")) {
      parsed.outPath = path.resolve(requireInlineValue(argument, "--out=", "--out"));
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.bundleDir) throw new Error("--bundle is required");
  if (!parsed.protocolPath) throw new Error("--protocol is required");
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

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const rows = [];
  for (const [index, line] of fs.readFileSync(filePath, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return rows;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function resolveBundleRelativePath(bundleDir, relativePath, issues, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    issues.push(`${label} is missing`);
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

function listFilesRecursive(baseDir, issues = [], rootDir = baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  const entries = [];
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isSymbolicLink()) {
      issues.push(`bundle contains symlink: ${posixify(path.relative(rootDir, fullPath))}`);
    } else if (entry.isDirectory()) {
      entries.push(...listFilesRecursive(fullPath, issues, rootDir));
    } else if (entry.isFile()) {
      entries.push(fullPath);
    }
  }
  return entries.sort((left, right) => posixify(path.relative(rootDir, left)).localeCompare(posixify(path.relative(rootDir, right))));
}

function readSha256Sums(bundleDir, issues) {
  const sumsPath = path.join(bundleDir, "SHA256SUMS");
  if (!fs.existsSync(sumsPath)) {
    issues.push("bundle SHA256SUMS is missing");
    return new Map();
  }
  const sums = new Map();
  for (const [index, line] of fs.readFileSync(sumsPath, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      issues.push(`bundle SHA256SUMS:${index + 1} is malformed`);
      continue;
    }
    const relativePath = match[2];
    if (sums.has(relativePath)) issues.push(`bundle SHA256SUMS:${index + 1} duplicates ${relativePath}`);
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
      issues.push(`bundle SHA256SUMS:${index + 1} has unsafe path ${relativePath}`);
    }
    sums.set(relativePath, match[1]);
  }
  return sums;
}

function validateBundleSha256Sums(bundleDir, issues) {
  const expected = readSha256Sums(bundleDir, issues);
  const actualFiles = listFilesRecursive(bundleDir, issues)
    .filter((filePath) => path.basename(filePath) !== "SHA256SUMS")
    .map((filePath) => posixify(path.relative(bundleDir, filePath)))
    .sort();
  const expectedFiles = [...expected.keys()].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    issues.push("bundle SHA256SUMS file list does not match bundle contents");
    return;
  }
  for (const relativePath of actualFiles) {
    const actualHash = hashFile(path.join(bundleDir, relativePath));
    if (actualHash !== expected.get(relativePath)) {
      issues.push(`bundle SHA256 mismatch for ${relativePath}`);
    }
  }
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


function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateLabelShape(label, line, issues) {
  if (!isRecord(label)) {
    issues.push(`labels.jsonl:${line} must be an object`);
    return false;
  }
  for (const key of Object.keys(label)) {
    if (!labelAllowedKeys.has(key)) issues.push(`labels.jsonl:${line} has unexpected field ${key}`);
  }
  return true;
}

function parseUnitInterval(value, label, issues) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
    issues.push(`${label} must be a number greater than 0 and less than 1`);
    return null;
  }
  return value;
}

function parsePositiveUnitInterval(value, label, issues) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    issues.push(`${label} must be a number greater than 0 and less than or equal to 1`);
    return null;
  }
  return value;
}

function protocolClaim(protocol) {
  return protocol.claim && typeof protocol.claim === "object" ? protocol.claim : protocol;
}

function normalizeWorklistArtifactSetSha256s(protocol, claim, labelingPlan, issues) {
  const plural = claim.worklistArtifactSetSha256s
    ?? labelingPlan.worklistArtifactSetSha256s
    ?? protocol.worklistArtifactSetSha256s
    ?? null;
  const singular = claim.worklistArtifactSetSha256 || labelingPlan.worklistArtifactSetSha256 || protocol.worklistArtifactSetSha256 || null;
  const digests = plural !== null ? plural : singular !== null ? [singular] : [];
  if (!Array.isArray(digests)) {
    issues.push("claim.worklistArtifactSetSha256s must be a string array when present");
    return [];
  }
  for (const [index, digest] of digests.entries()) {
    if (!/^[a-f0-9]{64}$/.test(String(digest))) {
      issues.push(`claim.worklistArtifactSetSha256s[${index}] must be a lowercase 64-hex SHA-256 digest`);
    }
  }
  return digests.map(String);
}

function normalizeProtocol(protocol, issues) {
  if (protocol.schemaVersion !== protocolSchemaVersion) issues.push(`protocol schemaVersion must be ${protocolSchemaVersion}`);
  const claim = protocolClaim(protocol);
  const includedRules = claim.includedRules || protocol.includedRules;
  const toolCommit = claim.toolCommit || protocol.toolCommit || null;
  const artifactSetSha256 = claim.artifactSetSha256 || protocol.artifactSetSha256 || null;
  const preLabelArtifactSetSha256 = claim.preLabelArtifactSetSha256 || protocol.preLabelArtifactSetSha256 || null;
  if (!protocol.studyId || typeof protocol.studyId !== "string") issues.push("protocol studyId is required");
  if (toolCommit !== null && !/^[a-f0-9]{40}$/.test(String(toolCommit))) {
    issues.push("claim.toolCommit must be a lowercase 40-hex commit when present");
  }
  if (artifactSetSha256 !== null && !/^[a-f0-9]{64}$/.test(String(artifactSetSha256))) {
    issues.push("claim.artifactSetSha256 must be a lowercase 64-hex SHA-256 digest when present");
  }
  if (preLabelArtifactSetSha256 !== null && !/^[a-f0-9]{64}$/.test(String(preLabelArtifactSetSha256))) {
    issues.push("claim.preLabelArtifactSetSha256 must be a lowercase 64-hex SHA-256 digest when present");
  }
  if (!Array.isArray(includedRules) || includedRules.length === 0 || includedRules.some((ruleId) => typeof ruleId !== "string" || ruleId.length === 0)) {
    issues.push("protocol claim.includedRules must be a non-empty string array");
  }
  const primaryMetric = claim.primaryMetric || protocol.primaryMetric || "blocking_precision";
  if (primaryMetric !== "blocking_precision") issues.push("only primaryMetric=blocking_precision is supported");
  const minimumPrecision = parseUnitInterval(claim.minimumPrecision ?? protocol.minimumPrecision ?? defaultMinimumPrecision, "minimumPrecision", issues);
  const confidence = parseUnitInterval(claim.confidence ?? protocol.confidence ?? defaultConfidence, "confidence", issues);
  const blockingSeverities = claim.blockingSeverities || protocol.blockingSeverities || defaultBlockingSeverities;
  if (!Array.isArray(blockingSeverities) || blockingSeverities.some((severity) => typeof severity !== "string" || severity.length === 0)) {
    issues.push("blockingSeverities must be a string array");
  }
  const maxRepositoryContribution = parsePositiveUnitInterval(
    protocol.samplingPlan?.maxRepositoryContribution ?? defaultMaxRepositoryContribution,
    "samplingPlan.maxRepositoryContribution",
    issues,
  );
  const labelingPlan = protocol.labelingPlan || {};
  const allowedRaterTypes = labelingPlan.allowedRaterTypes || labelingPlan.allowedRaterClasses || [];
  if (!Array.isArray(allowedRaterTypes) || allowedRaterTypes.some((raterType) => typeof raterType !== "string" || raterType.length === 0)) {
    issues.push("labelingPlan.allowedRaterTypes must be a string array when present");
  }
  const allowNonHumanRaters = labelingPlan.allowNonHumanRaters ?? true;
  if (typeof allowNonHumanRaters !== "boolean") issues.push("labelingPlan.allowNonHumanRaters must be a boolean when present");
  const requireKnownRaterType = labelingPlan.requireKnownRaterType ?? false;
  if (typeof requireKnownRaterType !== "boolean") issues.push("labelingPlan.requireKnownRaterType must be a boolean when present");
  const worklistArtifactSetSha256s = normalizeWorklistArtifactSetSha256s(protocol, claim, labelingPlan, issues);
  const worklistArtifactSetSha256 = worklistArtifactSetSha256s.length === 1 ? worklistArtifactSetSha256s[0] : null;
  const manifestReviewPlan = protocol.manifestReviewPlan || {};
  const requireExternalManifestReview = manifestReviewPlan.requireExternalAttestations ?? false;
  if (typeof requireExternalManifestReview !== "boolean") {
    issues.push("manifestReviewPlan.requireExternalAttestations must be a boolean when present");
  }
  const allowedManifestReviewerTypes = manifestReviewPlan.allowedReviewerTypes || manifestReviewPlan.allowedReviewerClasses || ["human", "organization"];
  if (!Array.isArray(allowedManifestReviewerTypes) || allowedManifestReviewerTypes.some((reviewerType) => typeof reviewerType !== "string" || reviewerType.length === 0)) {
    issues.push("manifestReviewPlan.allowedReviewerTypes must be a string array when present");
  }
  return {
    studyId: protocol.studyId,
    includedRules: Array.isArray(includedRules) ? includedRules : [],
    primaryMetric,
    minimumPrecision: minimumPrecision ?? defaultMinimumPrecision,
    confidence: confidence ?? defaultConfidence,
    blockingSeverities: Array.isArray(blockingSeverities) ? blockingSeverities : defaultBlockingSeverities,
    maxRepositoryContribution: maxRepositoryContribution ?? defaultMaxRepositoryContribution,
    allowedRaterTypes: Array.isArray(allowedRaterTypes) ? allowedRaterTypes : [],
    allowNonHumanRaters: typeof allowNonHumanRaters === "boolean" ? allowNonHumanRaters : true,
    requireKnownRaterType: typeof requireKnownRaterType === "boolean" ? requireKnownRaterType : false,
    worklistArtifactSetSha256,
    worklistArtifactSetSha256s,
    toolCommit,
    artifactSetSha256,
    preLabelArtifactSetSha256,
    requireExternalManifestReview: typeof requireExternalManifestReview === "boolean" ? requireExternalManifestReview : false,
    allowedManifestReviewerTypes: Array.isArray(allowedManifestReviewerTypes) ? allowedManifestReviewerTypes : ["human", "organization"],
  };
}

function validateClaimBinding(bundleDir, study, protocol, issues) {
  if (!protocol.toolCommit) issues.push("protocol claim.toolCommit is required");
  if (!protocol.artifactSetSha256) issues.push("protocol claim.artifactSetSha256 is required");
  if (!protocol.preLabelArtifactSetSha256) issues.push("protocol claim.preLabelArtifactSetSha256 is required");
  const computedPreLabelArtifactSetSha256 = preLabelArtifactSetSha256(bundleDir);
  if (!study.preregistration?.preLabelArtifactSetSha256) {
    issues.push("study.preregistration.preLabelArtifactSetSha256 is required");
  } else if (study.preregistration.preLabelArtifactSetSha256 !== computedPreLabelArtifactSetSha256) {
    issues.push("study.preregistration.preLabelArtifactSetSha256 does not match bundle artifacts");
  }
  const sumsPath = path.join(bundleDir, "SHA256SUMS");
  if (fs.existsSync(sumsPath) && protocol.artifactSetSha256 && protocol.artifactSetSha256 !== hashFile(sumsPath)) {
    issues.push("protocol artifactSetSha256 does not match bundle SHA256SUMS");
  }
  if (protocol.preLabelArtifactSetSha256 && study.preregistration?.preLabelArtifactSetSha256 !== protocol.preLabelArtifactSetSha256) {
    issues.push("protocol preLabelArtifactSetSha256 does not match bundle preregistration.preLabelArtifactSetSha256");
  }
  if (!study.environment?.harnessCommit) {
    issues.push("bundle study.environment.harnessCommit is required");
  } else if (!/^[a-f0-9]{40}$/.test(String(study.environment.harnessCommit))) {
    issues.push("bundle study.environment.harnessCommit must be a lowercase 40-hex commit");
  } else if (protocol.toolCommit && protocol.toolCommit !== study.environment.harnessCommit) {
    issues.push("protocol toolCommit does not match bundle environment.harnessCommit");
  }
}

function validateStudyEnvironmentBinding(study, report, issues) {
  if (!report) {
    issues.push("bundle report.json is required to verify sealed study.environment");
    return;
  }
  if (canonicalJson(study.environment || {}) !== canonicalJson(report.environment || {})) {
    issues.push("study.environment does not match sealed report.environment");
  }
}

function groupBy(values, keyFn) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFn(value);
    const existing = groups.get(key) || [];
    existing.push(value);
    groups.set(key, existing);
  }
  return groups;
}

function increment(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function logFactorials(n) {
  const values = [0];
  for (let index = 1; index <= n; index += 1) values[index] = values[index - 1] + Math.log(index);
  return values;
}

function logSumExp(values) {
  const max = Math.max(...values);
  if (max === -Infinity) return -Infinity;
  let sum = 0;
  for (const value of values) sum += Math.exp(value - max);
  return max + Math.log(sum);
}

function binomialUpperTail(trials, successes, probability) {
  if (probability <= 0) return successes <= 0 ? 1 : 0;
  if (probability >= 1) return 1;
  const logP = Math.log(probability);
  const logQ = Math.log1p(-probability);
  const logs = [];
  const factorials = logFactorials(trials);
  for (let index = successes; index <= trials; index += 1) {
    const logChoose = factorials[trials] - factorials[index] - factorials[trials - index];
    logs.push(logChoose + (index * logP) + ((trials - index) * logQ));
  }
  return Math.exp(logSumExp(logs));
}

function oneSidedExactLowerBound(successes, trials, confidence) {
  if (trials === 0) return null;
  if (successes === 0) return 0;
  const alpha = 1 - confidence;
  let low = 0;
  let high = successes / trials;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const mid = (low + high) / 2;
    if (binomialUpperTail(trials, successes, mid) >= alpha) high = mid;
    else low = mid;
  }
  return high;
}

function requiredZeroFalsePositiveSampleSize(minimumPrecision, confidence) {
  return Math.ceil(Math.log(1 - confidence) / Math.log(minimumPrecision));
}

function additionalTruePositiveTrialsNeeded(successes, trials, minimumPrecision, confidence) {
  if (oneSidedExactLowerBound(successes, trials, confidence) >= minimumPrecision) return 0;
  for (let extra = 1; extra <= 100000; extra += 1) {
    if (oneSidedExactLowerBound(successes + extra, trials + extra, confidence) >= minimumPrecision) return extra;
  }
  return null;
}

function finalLabelForFinding(finding, labels) {
  const independent = labels.filter((label) => !isAdjudication(label));
  const adjudications = labels.filter(isAdjudication);
  const independentValues = new Set(independent.map((label) => label.label));
  if (independentValues.size === 1 && adjudications.length === 0) return independent[0]?.label || null;
  if (independentValues.size > 1 && adjudications.length > 0) return adjudications.at(-1)?.label || null;
  return null;
}

function selectedFindings(findings, sampling, protocol) {
  const sampledFindingIds = new Set(sampling.sampledFindingIds || findings.map((finding) => finding.findingId));
  const includedRules = new Set(protocol.includedRules);
  const blockingSeverities = new Set(protocol.blockingSeverities);
  return findings.filter((finding) => {
    return sampledFindingIds.has(finding.findingId)
      && finding.precisionEligible === true
      && includedRules.has(finding.ruleId)
      && blockingSeverities.has(finding.severity || "error");
  });
}

function labelReadiness(selected, labelsByFinding) {
  let fullyLabeled = 0;
  let missingLabels = 0;
  let disagreements = 0;
  let adjudicated = 0;
  for (const finding of selected) {
    const labels = labelsByFinding.get(finding.findingId) || [];
    const independent = labels.filter((label) => !isAdjudication(label));
    const adjudications = labels.filter(isAdjudication);
    const independentRaters = new Set(independent.map((label) => label.rater));
    const blindFirst = new Set(independent.filter((label) => label.round === "blind_first").map((label) => label.rater));
    const blindSecond = new Set(independent.filter((label) => label.round === "blind_second").map((label) => label.rater));
    const independentValues = new Set(independent.map((label) => label.label));
    if (independentRaters.size < 2 || blindFirst.size !== 1 || blindSecond.size !== 1) {
      missingLabels += 1;
      continue;
    }
    if (independentValues.size > 1) {
      disagreements += 1;
      if (adjudications.length === 0) continue;
      adjudicated += 1;
    }
    fullyLabeled += 1;
  }
  return { fullyLabeled, missingLabels, disagreements, adjudicated };
}

function raterSummary(labels) {
  const raters = new Map();
  for (const label of labels) {
    const existing = raters.get(label.rater) || { labels: 0, nonHuman: false };
    existing.labels += 1;
    existing.nonHuman = existing.nonHuman || nonHumanRaterPattern.test(label.rater || "") || nonHumanRaterPattern.test(labelRaterType(label));
    raters.set(label.rater, existing);
  }
  return {
    totalRaters: raters.size,
    nonHumanRaters: [...raters.values()].filter((entry) => entry.nonHuman).length,
    missingRaterClassLabels: labels.filter((label) => !labelRaterType(label)).length,
    raters: Object.fromEntries([...raters.entries()].sort(([left], [right]) => left.localeCompare(right))),
  };
}

function validateLabelRaterProvenance(labels, protocol, issues) {
  const allowed = new Set(protocol.allowedRaterTypes);
  const missingType = labels.filter((label) => !labelRaterType(label)).length;
  if ((protocol.requireKnownRaterType || allowed.size > 0) && missingType > 0) {
    issues.push(`${missingType} labels are missing raterType/raterClass required by the protocol`);
  }
  if (allowed.size > 0) {
    const disallowed = labels.filter((label) => {
      const type = labelRaterType(label);
      return type && !allowed.has(type);
    });
    if (disallowed.length > 0) {
      issues.push(`${disallowed.length} labels use raterType/raterClass outside the protocol allow-list`);
    }
  }
  if (!protocol.allowNonHumanRaters) {
    const nonHumanLabels = labels.filter((label) => {
      const type = labelRaterType(label);
      return nonHumanRaterPattern.test(label.rater || "") || nonHumanRaterPattern.test(type);
    });
    if (nonHumanLabels.length > 0) issues.push(`${nonHumanLabels.length} labels appear to be non-human but protocol disallows non-human raters`);
  }
}

function validateLabelClaimUse(labels, issues) {
  for (const [index, label] of labels.entries()) {
    if (isAdjudication(label)) continue;
    const line = index + 1;
    if (label.claimUse && label.claimUse !== "blind_labeling") {
      issues.push(`labels.jsonl:${line} is marked ${label.claimUse} and cannot support a claim`);
    }
    if (label.sourceBundleContainsLabels === true) {
      issues.push(`labels.jsonl:${line} came from a diagnostic label-bearing source bundle`);
    }
  }
}

function validateLabelRows(labels, studyId, knownFindingIds, issues) {
  const seen = new Set();
  for (const [index, label] of labels.entries()) {
    const line = index + 1;
    if (!validateLabelShape(label, line, issues)) continue;
    validateClaimLabelMetadata(label, line, issues);
    if (label.schemaVersion !== "cellfence.corpus-label.v1") issues.push(`labels.jsonl:${line} has unexpected schemaVersion`);
    if (label.studyId !== studyId) issues.push(`labels.jsonl:${line} has unexpected studyId`);
    if (!knownFindingIds.has(label.findingId)) issues.push(`labels.jsonl:${line} references unknown findingId ${label.findingId}`);
    if (!allowedLabels.has(label.label)) issues.push(`labels.jsonl:${line} has unknown label ${label.label}`);
    if (!label.rater || typeof label.rater !== "string") issues.push(`labels.jsonl:${line} is missing rater`);
    if (!label.rationale || typeof label.rationale !== "string" || label.rationale.trim().length === 0) {
      issues.push(`labels.jsonl:${line} is missing rationale`);
    }
    if (!label.assignmentId || typeof label.assignmentId !== "string") issues.push(`labels.jsonl:${line} is missing assignmentId`);
    if (!label.evidencePackageId || typeof label.evidencePackageId !== "string") issues.push(`labels.jsonl:${line} is missing evidencePackageId`);
    if (isAdjudication(label)) {
      if (label.round && label.round !== "adjudication") issues.push(`labels.jsonl:${line} adjudication label must use round=adjudication`);
    } else {
      if (label.round !== "blind_first" && label.round !== "blind_second") {
        issues.push(`labels.jsonl:${line} independent label must use round=blind_first or round=blind_second`);
      }
      if (label.sawPeerLabels !== false) issues.push(`labels.jsonl:${line} independent label must declare sawPeerLabels=false`);
    }
    const duplicateKey = `${label.findingId}\0${label.rater}\0${isAdjudication(label) ? "adjudication" : "independent"}`;
    if (seen.has(duplicateKey)) issues.push(`labels.jsonl:${line} duplicates finding/rater/role label`);
    seen.add(duplicateKey);
  }
}

function reviewAttestations(manifest) {
  if (Array.isArray(manifest?.review?.reviewerAttestations)) return manifest.review.reviewerAttestations;
  if (Array.isArray(manifest?.review?.reviewers) && manifest.review.reviewers.every((reviewer) => isRecord(reviewer))) {
    return manifest.review.reviewers;
  }
  return [];
}

function manifestCopiesBySubject(study, bundleDir, issues) {
  const copies = new Map();
  for (const copy of study.manifestCopies || []) {
    if (!copy?.subjectId || !copy?.path) continue;
    const absolutePath = resolveBundleRelativePath(bundleDir, copy.path, issues, `manifest copy path ${copy.path}`);
    copies.set(copy.subjectId, {
      ...copy,
      actualSha256: absolutePath && fs.existsSync(absolutePath) ? hashFile(absolutePath) : null,
    });
  }
  return copies;
}

function validateManifestReviewProvenance(corpus, study, bundleDir, protocol, issues) {
  if (!protocol.requireExternalManifestReview) return;
  const allowedReviewerTypes = new Set(protocol.allowedManifestReviewerTypes);
  const manifestCopies = manifestCopiesBySubject(study, bundleDir, issues);
  for (const subject of corpus.subjects || []) {
    const id = subject?.id || "subject";
    const manifest = subject?.manifest || {};
    const strategy = manifest.strategy || "existing";
    const review = manifest.review || {};
    if (strategy !== "copy") {
      issues.push(`${id} external manifest review requires manifest.strategy=copy`);
    }
    if (manifest.reviewStatus !== "reviewed") {
      issues.push(`${id} external manifest review requires reviewStatus=reviewed`);
    }
    const attestations = reviewAttestations(manifest);
    if (attestations.length === 0) {
      issues.push(`${id} external manifest review requires review.reviewerAttestations`);
    }
    for (const [index, attestation] of attestations.entries()) {
      const label = `${id} review.reviewerAttestations[${index}]`;
      const reviewerType = attestation.reviewerType || attestation.raterType || attestation.reviewerClass;
      if (typeof attestation.id !== "string" || attestation.id.length === 0) issues.push(`${label}.id is required`);
      if (typeof reviewerType !== "string" || !allowedReviewerTypes.has(reviewerType)) {
        issues.push(`${label}.reviewerType must be one of ${[...allowedReviewerTypes].join(", ")}`);
      }
      if (attestation.independent !== true) issues.push(`${label}.independent must be true`);
    }
    if (typeof review.reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(review.reviewedAt)) {
      issues.push(`${id} external manifest review requires review.reviewedAt`);
    }
    if (typeof review.scope !== "string" || review.scope.length === 0) {
      issues.push(`${id} external manifest review requires review.scope`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(review.reviewedManifestSha256 || ""))) {
      issues.push(`${id} external manifest review requires review.reviewedManifestSha256`);
      continue;
    }
    const copy = manifestCopies.get(id);
    if (!copy || !copy.actualSha256) {
      issues.push(`${id} external manifest review requires a sealed manifest copy`);
    } else if (review.reviewedManifestSha256 !== copy.actualSha256) {
      issues.push(`${id} review.reviewedManifestSha256 does not match sealed manifest copy`);
    }
  }
}

function metricFor(findings, labelsByFinding, protocol) {
  const counts = {
    true_positive: 0,
    false_positive: 0,
    needs_policy: 0,
    needs_review: 0,
    invalid_setup: 0,
    out_of_scope: 0,
    unlabeled: 0,
  };
  for (const finding of findings) {
    const label = finalLabelForFinding(finding, labelsByFinding.get(finding.findingId) || []);
    if (!label) {
      counts.unlabeled += 1;
      continue;
    }
    increment(counts, label);
  }
  const trials = [...blockingDenominatorLabels].reduce((sum, label) => sum + (counts[label] || 0), 0);
  const successes = [...blockingSuccessLabels].reduce((sum, label) => sum + (counts[label] || 0), 0);
  return {
    counts,
    successes,
    trials,
    observedPrecision: trials === 0 ? null : successes / trials,
    oneSidedLowerBound: oneSidedExactLowerBound(successes, trials, protocol.confidence),
    additionalTruePositiveTrialsNeeded: additionalTruePositiveTrialsNeeded(successes, trials, protocol.minimumPrecision, protocol.confidence),
  };
}

function repositoryContribution(selected, protocol) {
  const denominator = selected.length;
  const repositories = [...groupBy(selected, (finding) => finding.repository || finding.subjectId || "unknown").entries()]
    .map(([repository, findings]) => ({
      repository,
      selectedFindings: findings.length,
      contribution: denominator === 0 ? null : findings.length / denominator,
      overLimit: denominator > 0 && findings.length / denominator > protocol.maxRepositoryContribution,
      additionalOtherFindingsNeeded: denominator === 0
        ? 0
        : Math.max(0, Math.ceil(findings.length / protocol.maxRepositoryContribution) - denominator),
    }))
    .sort((left, right) => (right.contribution ?? 0) - (left.contribution ?? 0) || left.repository.localeCompare(right.repository));
  return {
    maxRepositoryContribution: repositories[0]?.contribution ?? null,
    limit: protocol.maxRepositoryContribution,
    repositoriesWithSelectedFindings: repositories.length,
    minimumRepositoriesWithSelectedFindings: Math.ceil(1 / protocol.maxRepositoryContribution),
    feasibleWithCurrentRepositoryCount: repositories.length >= Math.ceil(1 / protocol.maxRepositoryContribution),
    repositories,
  };
}

function evaluatePreflight(options) {
  const issues = [];
  const gateFailures = [];
  const warnings = [];
  const protocolRaw = readJson(options.protocolPath);
  const protocol = normalizeProtocol(protocolRaw, issues);
  validateBundleSha256Sums(options.bundleDir, issues);
  const study = readJson(path.join(options.bundleDir, "study.json"));
  const reportPath = path.join(options.bundleDir, "report.json");
  const report = fs.existsSync(reportPath) ? readJson(reportPath) : null;
  const corpus = readJson(path.join(options.bundleDir, "corpus.json"));
  const sampling = readJson(path.join(options.bundleDir, "sampling.json"));
  const findings = readJsonl(path.join(options.bundleDir, "findings.normalized.jsonl"));
  const labels = readJsonl(path.join(options.bundleDir, "labels.jsonl"));
  const worklistVerifications = [];
  const sealedRounds = new Set();

  if (study.schemaVersion !== "cellfence.corpus-evidence-bundle.v1") issues.push("study.json has unexpected schemaVersion");
  if (sampling.schemaVersion !== "cellfence.corpus-sampling.v1") issues.push("sampling.json has unexpected schemaVersion");
  if (report && report.schemaVersion !== "cellfence.corpus-study.v1") issues.push("report.json has unexpected schemaVersion");
  if (study.studyId !== protocol.studyId) issues.push(`bundle studyId ${study.studyId} does not match protocol studyId ${protocol.studyId}`);
  validateStudyEnvironmentBinding(study, report, issues);
  validateClaimBinding(options.bundleDir, study, protocol, issues);
  if (study.environment?.harnessDirty === true) {
    gateFailures.push("bundle was produced from a dirty CellFence worktree");
  } else if (study.environment?.harnessDirty !== false) {
    gateFailures.push("bundle must declare study.environment.harnessDirty=false");
  }
  validateLabelRows(labels, protocol.studyId, new Set(findings.map((finding) => finding.findingId)), issues);
  validateLabelRaterProvenance(labels, protocol, issues);
  validateLabelClaimUse(labels, issues);
  if (options.worklistDirs.length > 0 || protocol.worklistArtifactSetSha256s.length > 0) {
    if (options.worklistDirs.length === 0) {
      issues.push("protocol claim.worklistArtifactSetSha256s requires --worklist");
    } else if (protocol.worklistArtifactSetSha256s.length === 0) {
      issues.push("--worklist requires protocol claim.worklistArtifactSetSha256s");
    } else if (options.worklistDirs.length !== protocol.worklistArtifactSetSha256s.length) {
      issues.push("--worklist count must match claim.worklistArtifactSetSha256s count");
    }
    const count = Math.min(options.worklistDirs.length, protocol.worklistArtifactSetSha256s.length);
    for (let index = 0; index < count; index += 1) {
      const worklistVerification = verifyWorklistLabels(options.worklistDirs[index], labels, {
        bundleDir: options.bundleDir,
        findings,
        studyId: protocol.studyId,
        expectedArtifactSetSha256: protocol.worklistArtifactSetSha256s[index],
        preLabelArtifactSetSha256: study.preregistration?.preLabelArtifactSetSha256,
      });
      worklistVerifications.push(worklistVerification);
      worklistVerification.rounds.forEach((round) => {
        if (sealedRounds.has(round)) issues.push(`duplicate sealed worklist round ${round}`);
        sealedRounds.add(round);
      });
      issues.push(...worklistVerification.issues.map((issue) => `worklist: ${issue}`));
    }
  }
  if (worklistVerifications.length === 0) {
    gateFailures.push("sealed worklist binding is required for pass-eligible precision claims");
  } else {
    for (const round of ["blind_first", "blind_second"]) {
      if (!sealedRounds.has(round)) gateFailures.push(`sealed ${round} worklist binding is required for pass-eligible precision claims`);
    }
    if (labels.some(isAdjudication) && !sealedRounds.has("adjudication")) {
      issues.push("worklist-bound adjudication labels require a sealed adjudication worklist");
    }
  }
  validateManifestReviewProvenance(corpus, study, options.bundleDir, protocol, issues);

  const selected = selectedFindings(findings, sampling, protocol);
  if (selected.length === 0) gateFailures.push("no sampled precision-eligible findings match protocol rules and blocking severities");
  const labelsByFinding = groupBy(labels, (label) => label.findingId);
  const readiness = labelReadiness(selected, labelsByFinding);
  if (readiness.fullyLabeled < selected.length) gateFailures.push(`${selected.length - readiness.fullyLabeled} selected findings are not fully independently labeled`);

  const requiredZeroFp = requiredZeroFalsePositiveSampleSize(protocol.minimumPrecision, protocol.confidence);
  const selectedByRule = {};
  for (const ruleId of protocol.includedRules) {
    const ruleFindings = selected.filter((finding) => finding.ruleId === ruleId);
    const metric = metricFor(ruleFindings, labelsByFinding, protocol);
    selectedByRule[ruleId] = {
      selectedFindings: ruleFindings.length,
      requiredZeroFalsePositiveFindings: requiredZeroFp,
      sampleDeficitBeforeLabeling: Math.max(0, requiredZeroFp - ruleFindings.length),
      ...metric,
    };
    if (ruleFindings.length < requiredZeroFp) {
      gateFailures.push(`${ruleId} has ${ruleFindings.length} selected findings; ${requiredZeroFp} zero-false-positive findings are required for the requested bound`);
    }
    if (metric.trials > 0 && (metric.oneSidedLowerBound ?? 0) < protocol.minimumPrecision) {
      gateFailures.push(`${ruleId} labeled lower bound is below ${protocol.minimumPrecision}`);
    }
  }

  const contribution = repositoryContribution(selected, protocol);
  if (selected.length > 0 && !contribution.feasibleWithCurrentRepositoryCount) {
    gateFailures.push(`selected findings span ${contribution.repositoriesWithSelectedFindings} repositories; at least ${contribution.minimumRepositoriesWithSelectedFindings} are required for a ${(protocol.maxRepositoryContribution * 100).toFixed(1)}% repository contribution limit`);
  }
  for (const repository of contribution.repositories) {
    if (repository.overLimit) {
      gateFailures.push(`${repository.repository} contributes ${(repository.contribution * 100).toFixed(1)}% of selected findings; limit is ${(protocol.maxRepositoryContribution * 100).toFixed(1)}%; add at least ${repository.additionalOtherFindingsNeeded} sampled findings from other repositories or reduce this repository's sampled findings`);
    }
  }

  const summaryMetric = metricFor(selected, labelsByFinding, protocol);
  return {
    schemaVersion: reportSchemaVersion,
    generatedAt: new Date().toISOString(),
    bundleDir: options.bundleDir,
    protocolPath: options.protocolPath,
    studyId: protocol.studyId,
    ok: issues.length === 0 && gateFailures.length === 0,
    valid: issues.length === 0,
    claimReady: issues.length === 0 && gateFailures.length === 0,
    protocol: {
      includedRules: protocol.includedRules,
      minimumPrecision: protocol.minimumPrecision,
      confidence: protocol.confidence,
      blockingSeverities: protocol.blockingSeverities,
      maxRepositoryContribution: protocol.maxRepositoryContribution,
      requiredZeroFalsePositiveFindingsPerRule: requiredZeroFp,
      allowedRaterTypes: protocol.allowedRaterTypes,
      allowNonHumanRaters: protocol.allowNonHumanRaters,
      requireKnownRaterType: protocol.requireKnownRaterType,
      worklistArtifactSetSha256: protocol.worklistArtifactSetSha256,
      worklistArtifactSetSha256s: protocol.worklistArtifactSetSha256s,
      toolCommit: protocol.toolCommit,
      artifactSetSha256: protocol.artifactSetSha256,
      preLabelArtifactSetSha256: protocol.preLabelArtifactSetSha256,
      requireExternalManifestReview: protocol.requireExternalManifestReview,
      allowedManifestReviewerTypes: protocol.allowedManifestReviewerTypes,
    },
    worklist: worklistVerifications.length > 0 ? {
      paths: options.worklistDirs.map(posixify),
      artifactSetSha256: worklistVerifications.length === 1 ? worklistVerifications[0].artifactSetSha256 : null,
      artifactSetSha256s: worklistVerifications.map((worklist) => worklist.artifactSetSha256),
      assignments: worklistVerifications.reduce((total, worklist) => total + worklist.assignments, 0),
      rounds: [...sealedRounds].sort(),
      issues: worklistVerifications.reduce((total, worklist) => total + worklist.issues.length, 0),
    } : null,
    summary: {
      totalFindings: findings.length,
      sampledFindings: sampling.sampledFindingIds?.length ?? null,
      selectedFindings: selected.length,
      labels: labels.length,
      ...readiness,
      ...summaryMetric,
    },
    selectedByRule,
    repositoryContribution: contribution,
    raterSummary: raterSummary(labels),
    warnings,
    gateFailures: [...new Set(gateFailures)],
    issues,
  };
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
    const report = evaluatePreflight(options);
    if (options.outPath) writeJson(options.outPath, report);
    console.log(JSON.stringify(report, null, 2));
    if (report.issues.length > 0) return 2;
    return report.claimReady ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
