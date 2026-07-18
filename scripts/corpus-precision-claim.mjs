#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const protocolSchemaVersion = "cellfence.precision-claim-protocol.v1";
const reportSchemaVersion = "cellfence.precision-claim-report.v1";
const defaultConfidence = 0.95;
const defaultMinimumPrecision = 0.99;
const defaultMaxRepositoryContribution = 0.1;
const defaultBlockingSeverities = ["error"];
const defaultMinimumIndependentRaters = 2;
const allowedLabels = new Set([
  "true_positive",
  "false_positive",
  "needs_policy",
  "needs_review",
  "invalid_setup",
  "out_of_scope",
]);
const blockingDenominatorLabels = new Set([
  "true_positive",
  "false_positive",
  "needs_policy",
  "needs_review",
]);

function usage() {
  console.error(`Usage:
  node scripts/corpus-precision-claim.mjs --bundle reports/corpus/id-bundle --protocol protocol.json [--out report.json]

Evaluates a labeled CellFence evidence bundle against a pre-registered precision
claim protocol. Exit 0 means the claim passes, exit 1 means the evidence is
valid but insufficient for the requested lower bound, and exit 2 means the
protocol, labels, or bundle are invalid.`);
}

function parseArgs(argv) {
  const parsed = {
    bundleDir: "",
    protocolPath: "",
    outPath: "",
  };
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

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hashFile(filePath) {
  return hashBuffer(fs.readFileSync(filePath));
}

function posixify(value) {
  return String(value).replace(/\\/g, "/").split(path.sep).join("/");
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

function normalizeProtocol(protocol, issues) {
  if (protocol.schemaVersion !== protocolSchemaVersion) {
    issues.push(`protocol schemaVersion must be ${protocolSchemaVersion}`);
  }
  const claim = protocolClaim(protocol);
  const includedRules = claim.includedRules || protocol.includedRules;
  if (!protocol.studyId || typeof protocol.studyId !== "string") issues.push("protocol studyId is required");
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
  const labelingPlan = protocol.labelingPlan || {};
  const minimumIndependentRaters = labelingPlan.minimumIndependentRaters ?? defaultMinimumIndependentRaters;
  if (!Number.isInteger(minimumIndependentRaters) || minimumIndependentRaters < 1) {
    issues.push("labelingPlan.minimumIndependentRaters must be a positive integer");
  }
  const samplingPlan = protocol.samplingPlan || {};
  const maxRepositoryContribution = parsePositiveUnitInterval(
    samplingPlan.maxRepositoryContribution ?? defaultMaxRepositoryContribution,
    "samplingPlan.maxRepositoryContribution",
    issues,
  );
  return {
    studyId: protocol.studyId,
    toolCommit: claim.toolCommit || protocol.toolCommit || null,
    artifactSetSha256: claim.artifactSetSha256 || protocol.artifactSetSha256 || null,
    targetPopulation: claim.targetPopulation || protocol.targetPopulation || null,
    supportedSyntaxProfile: claim.supportedSyntaxProfile || protocol.supportedSyntaxProfile || null,
    includedRules: Array.isArray(includedRules) ? includedRules : [],
    primaryMetric,
    minimumPrecision: minimumPrecision ?? defaultMinimumPrecision,
    confidence: confidence ?? defaultConfidence,
    blockingSeverities: Array.isArray(blockingSeverities) ? blockingSeverities : defaultBlockingSeverities,
    minimumIndependentRaters: Number.isInteger(minimumIndependentRaters) ? minimumIndependentRaters : defaultMinimumIndependentRaters,
    requireAdjudicationForDisagreements: labelingPlan.requireAdjudicationForDisagreements !== false,
    maxRepositoryContribution: maxRepositoryContribution ?? defaultMaxRepositoryContribution,
    exclusionRules: Array.isArray(protocol.exclusionRules) ? protocol.exclusionRules : [],
  };
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

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function increment(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function isAdjudication(label) {
  return label.role === "adjudicator" || label.adjudication === true || label.adjudicated === true;
}

function validateLabelRows(labels, knownFindingIds, studyId, issues) {
  const seen = new Set();
  for (const [index, label] of labels.entries()) {
    const lineNumber = index + 1;
    if (label.schemaVersion !== "cellfence.corpus-label.v1") {
      issues.push(`labels.jsonl:${lineNumber} has unexpected schemaVersion`);
    }
    if (label.studyId !== studyId) {
      issues.push(`labels.jsonl:${lineNumber} has unexpected studyId`);
    }
    if (!knownFindingIds.has(label.findingId)) {
      issues.push(`labels.jsonl:${lineNumber} references unknown findingId ${label.findingId}`);
    }
    if (!allowedLabels.has(label.label)) {
      issues.push(`labels.jsonl:${lineNumber} has unknown label ${label.label}`);
    }
    if (!label.rater || typeof label.rater !== "string") {
      issues.push(`labels.jsonl:${lineNumber} is missing rater`);
    }
    if (!label.rationale || typeof label.rationale !== "string" || label.rationale.trim().length === 0) {
      issues.push(`labels.jsonl:${lineNumber} is missing rationale`);
    }
    const duplicateKey = `${label.findingId}\0${label.rater}\0${isAdjudication(label) ? "adjudication" : "independent"}`;
    if (seen.has(duplicateKey)) {
      issues.push(`labels.jsonl:${lineNumber} duplicates finding/rater/role label`);
    }
    seen.add(duplicateKey);
  }
}

function finalLabelForFinding(finding, labels, protocol, issues) {
  const findingLabels = labels.filter((label) => label.findingId === finding.findingId);
  const independentLabels = findingLabels.filter((label) => !isAdjudication(label));
  const adjudicationLabels = findingLabels.filter(isAdjudication);
  const independentRaters = new Set(independentLabels.map((label) => label.rater));
  if (independentRaters.size < protocol.minimumIndependentRaters) {
    issues.push(`${finding.findingId} has ${independentRaters.size} independent labels; ${protocol.minimumIndependentRaters} required`);
    return null;
  }
  if (independentLabels.length !== independentRaters.size) {
    issues.push(`${finding.findingId} has duplicate independent labels from the same rater`);
    return null;
  }
  const distinctIndependentLabels = new Set(independentLabels.map((label) => label.label));
  if (distinctIndependentLabels.size === 1 && adjudicationLabels.length === 0) {
    return {
      finding,
      label: independentLabels[0].label,
      independentRaters: independentRaters.size,
      adjudicated: false,
    };
  }
  if (distinctIndependentLabels.size > 1 && protocol.requireAdjudicationForDisagreements && adjudicationLabels.length === 0) {
    issues.push(`${finding.findingId} has conflicting labels and no adjudication`);
    return null;
  }
  if (adjudicationLabels.length === 0) {
    return {
      finding,
      label: independentLabels[independentLabels.length - 1].label,
      independentRaters: independentRaters.size,
      adjudicated: false,
    };
  }
  const adjudicationRaters = new Set(adjudicationLabels.map((label) => label.rater));
  for (const rater of adjudicationRaters) {
    if (independentRaters.has(rater)) {
      issues.push(`${finding.findingId} adjudicator ${rater} also supplied an independent label`);
    }
  }
  const adjudicatedLabels = new Set(adjudicationLabels.map((label) => label.label));
  if (adjudicatedLabels.size > 1) {
    issues.push(`${finding.findingId} has conflicting adjudication labels`);
    return null;
  }
  return {
    finding,
    label: adjudicationLabels[adjudicationLabels.length - 1].label,
    independentRaters: independentRaters.size,
    adjudicated: true,
  };
}

function logFactorials(n) {
  const values = [0];
  for (let index = 1; index <= n; index += 1) {
    values[index] = values[index - 1] + Math.log(index);
  }
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

function emptyCounts() {
  return {
    true_positive: 0,
    false_positive: 0,
    needs_policy: 0,
    needs_review: 0,
    invalid_setup: 0,
    out_of_scope: 0,
  };
}

function metricFromLabels(finalLabels, confidence) {
  const counts = emptyCounts();
  for (const finalLabel of finalLabels) increment(counts, finalLabel.label);
  const blockingTrials = [...blockingDenominatorLabels].reduce((sum, label) => sum + counts[label], 0);
  const blockingSuccesses = counts.true_positive;
  const semanticSuccesses = counts.true_positive + counts.needs_policy;
  return {
    counts,
    blocking: {
      successes: blockingSuccesses,
      trials: blockingTrials,
      observedPrecision: ratio(blockingSuccesses, blockingTrials),
      oneSidedLowerBound: oneSidedExactLowerBound(blockingSuccesses, blockingTrials, confidence),
    },
    semanticCorrectness: {
      successes: semanticSuccesses,
      trials: blockingTrials,
      observedPrecision: ratio(semanticSuccesses, blockingTrials),
      oneSidedLowerBound: oneSidedExactLowerBound(semanticSuccesses, blockingTrials, confidence),
    },
  };
}

function worstLabel(labels) {
  const priority = [
    "false_positive",
    "needs_review",
    "needs_policy",
    "invalid_setup",
    "out_of_scope",
    "true_positive",
  ];
  for (const label of priority) {
    if (labels.includes(label)) return label;
  }
  return "needs_review";
}

function uniqueFingerprintMetric(finalLabels, confidence) {
  const groups = groupBy(finalLabels, (finalLabel) => [
    finalLabel.finding.subjectId || "",
    finalLabel.finding.ruleId || "",
    finalLabel.finding.cellfenceFingerprint || finalLabel.finding.findingId,
  ].join("\0"));
  const representativeLabels = [...groups.values()].map((group) => ({
    ...group[0],
    label: worstLabel(group.map((entry) => entry.label)),
  }));
  return {
    uniqueFingerprints: representativeLabels.length,
    ...metricFromLabels(representativeLabels, confidence),
  };
}

function perRuleMetrics(finalLabels, confidence) {
  const entries = [];
  for (const [ruleId, ruleLabels] of groupBy(finalLabels, (entry) => entry.finding.ruleId || "CELLFENCE_UNKNOWN_RULE")) {
    entries.push([ruleId, metricFromLabels(ruleLabels, confidence)]);
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function repositoryMetrics(finalLabels, confidence) {
  const repositories = [];
  for (const [repository, repositoryLabels] of groupBy(finalLabels, (entry) => entry.finding.repository || entry.finding.subjectId || "unknown")) {
    const metric = metricFromLabels(repositoryLabels, confidence);
    repositories.push({
      repository,
      trials: metric.blocking.trials,
      observedBlockingPrecision: metric.blocking.observedPrecision,
      oneSidedLowerBound: metric.blocking.oneSidedLowerBound,
    });
  }
  repositories.sort((left, right) => left.repository.localeCompare(right.repository));
  const usableRepositories = repositories.filter((entry) => entry.trials > 0);
  const macroPrecision = usableRepositories.length === 0
    ? null
    : usableRepositories.reduce((sum, entry) => sum + entry.observedBlockingPrecision, 0) / usableRepositories.length;
  const denominator = usableRepositories.reduce((sum, entry) => sum + entry.trials, 0);
  const maxContribution = usableRepositories.length === 0
    ? null
    : Math.max(...usableRepositories.map((entry) => entry.trials / denominator));
  return {
    repositories,
    repositoryMacroPrecision: macroPrecision,
    maxRepositoryContribution: maxContribution,
  };
}

function leaveOneRepositoryOut(finalLabels, confidence) {
  const repositories = [...groupBy(finalLabels, (entry) => entry.finding.repository || entry.finding.subjectId || "unknown").keys()].sort();
  if (repositories.length <= 1) {
    return {
      repositories: repositories.length,
      minimumObservedPrecision: null,
      minimumOneSidedLowerBound: null,
      omittedRepositoryAtMinimumLowerBound: null,
      runs: [],
    };
  }
  const runs = repositories.map((repository) => {
    const labels = finalLabels.filter((entry) => (entry.finding.repository || entry.finding.subjectId || "unknown") !== repository);
    const metric = metricFromLabels(labels, confidence);
    return {
      omittedRepository: repository,
      trials: metric.blocking.trials,
      observedBlockingPrecision: metric.blocking.observedPrecision,
      oneSidedLowerBound: metric.blocking.oneSidedLowerBound,
    };
  });
  runs.sort((left, right) => {
    const lowerDifference = (left.oneSidedLowerBound ?? -1) - (right.oneSidedLowerBound ?? -1);
    return lowerDifference || left.omittedRepository.localeCompare(right.omittedRepository);
  });
  return {
    repositories: repositories.length,
    minimumObservedPrecision: Math.min(...runs.map((entry) => entry.observedBlockingPrecision ?? 0)),
    minimumOneSidedLowerBound: runs[0].oneSidedLowerBound,
    omittedRepositoryAtMinimumLowerBound: runs[0].omittedRepository,
    runs,
  };
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

function validateBundleHashes(bundleDir, protocol, warnings, issues) {
  const sumsPath = path.join(bundleDir, "SHA256SUMS");
  if (!fs.existsSync(sumsPath)) {
    warnings.push("SHA256SUMS is missing; artifactSetSha256 cannot be verified");
    return null;
  }
  const artifactSetSha256 = hashFile(sumsPath);
  if (protocol.artifactSetSha256 && protocol.artifactSetSha256 !== artifactSetSha256) {
    issues.push("protocol artifactSetSha256 does not match bundle SHA256SUMS");
  }
  return artifactSetSha256;
}

function evaluateClaim(options) {
  const issues = [];
  const warnings = [];
  const protocolRaw = readJson(options.protocolPath);
  const protocol = normalizeProtocol(protocolRaw, issues);
  const study = readJson(path.join(options.bundleDir, "study.json"));
  const sampling = readJson(path.join(options.bundleDir, "sampling.json"));
  const findings = readJsonl(path.join(options.bundleDir, "findings.normalized.jsonl"));
  const labels = readJsonl(path.join(options.bundleDir, "labels.jsonl"));
  const knownFindingIds = new Set(findings.map((finding) => finding.findingId));
  const artifactSetSha256 = validateBundleHashes(options.bundleDir, protocol, warnings, issues);

  if (study.studyId !== protocol.studyId) issues.push(`bundle studyId ${study.studyId} does not match protocol studyId ${protocol.studyId}`);
  if (protocol.toolCommit && study.environment?.harnessCommit && protocol.toolCommit !== study.environment.harnessCommit) {
    issues.push("protocol toolCommit does not match bundle environment.harnessCommit");
  }
  validateLabelRows(labels, knownFindingIds, protocol.studyId, issues);

  const includedFindings = selectedFindings(findings, sampling, protocol);
  const finalLabels = [];
  for (const finding of includedFindings) {
    const finalLabel = finalLabelForFinding(finding, labels, protocol, issues);
    if (finalLabel) finalLabels.push(finalLabel);
  }

  const occurrence = metricFromLabels(finalLabels, protocol.confidence);
  const uniqueFingerprint = uniqueFingerprintMetric(finalLabels, protocol.confidence);
  const byRule = perRuleMetrics(finalLabels, protocol.confidence);
  const repositories = repositoryMetrics(finalLabels, protocol.confidence);
  const loo = leaveOneRepositoryOut(finalLabels, protocol.confidence);
  const requiredZeroFp = requiredZeroFalsePositiveSampleSize(protocol.minimumPrecision, protocol.confidence);

  if (includedFindings.length === 0) {
    issues.push("no sampled precision-eligible findings match the included rules and blocking severities");
  }
  if (finalLabels.length !== includedFindings.length) {
    issues.push("not every included finding has a usable final label");
  }
  if (repositories.maxRepositoryContribution !== null && repositories.maxRepositoryContribution > protocol.maxRepositoryContribution) {
    warnings.push(`largest repository contributes ${(repositories.maxRepositoryContribution * 100).toFixed(2)}% of labeled blocking trials; protocol maximum is ${(protocol.maxRepositoryContribution * 100).toFixed(2)}%`);
  }
  if (occurrence.blocking.trials < requiredZeroFp && occurrence.counts.false_positive === 0 && occurrence.counts.needs_policy === 0 && occurrence.counts.needs_review === 0) {
    warnings.push(`zero observed blocking failures still needs at least ${requiredZeroFp} labeled trials for the requested lower bound`);
  }

  const lowerBound = occurrence.blocking.oneSidedLowerBound;
  let status = "insufficient_evidence";
  let reason = "one-sided lower bound is below the requested minimum precision";
  if (issues.length > 0) {
    status = "invalid";
    reason = "protocol, bundle, or labeling requirements failed";
  } else if (lowerBound !== null && lowerBound >= protocol.minimumPrecision && warnings.length === 0) {
    status = "pass";
    reason = "one-sided lower bound meets the pre-registered threshold";
  } else if (lowerBound !== null && lowerBound >= protocol.minimumPrecision) {
    reason = "precision threshold is met, but design warnings prevent an external claim";
  }

  return {
    schemaVersion: reportSchemaVersion,
    generatedAt: new Date().toISOString(),
    protocol: {
      path: posixify(options.protocolPath),
      schemaVersion: protocolSchemaVersion,
      studyId: protocol.studyId,
      targetPopulation: protocol.targetPopulation,
      supportedSyntaxProfile: protocol.supportedSyntaxProfile,
      includedRules: protocol.includedRules,
      primaryMetric: protocol.primaryMetric,
      minimumPrecision: protocol.minimumPrecision,
      confidence: protocol.confidence,
      blockingSeverities: protocol.blockingSeverities,
      minimumIndependentRaters: protocol.minimumIndependentRaters,
      maxRepositoryContribution: protocol.maxRepositoryContribution,
      exclusionRules: protocol.exclusionRules,
    },
    bundle: {
      path: posixify(options.bundleDir),
      studyId: study.studyId,
      artifactSetSha256,
      totalFindings: findings.length,
      sampledFindings: Array.isArray(sampling.sampledFindingIds) ? sampling.sampledFindingIds.length : null,
      precisionEligibleSampledFindings: includedFindings.length,
    },
    labelQuality: {
      labels: labels.length,
      finalLabels: finalLabels.length,
      issues,
      warnings,
    },
    metrics: {
      occurrence,
      uniqueFingerprint,
      byRule,
      repositories,
      leaveOneRepositoryOut: loo,
      powerAnalysis: {
        zeroFalsePositiveRequiredTrials: requiredZeroFp,
        observedTrials: occurrence.blocking.trials,
      },
    },
    decision: {
      status,
      reason,
      observedBlockingPrecision: occurrence.blocking.observedPrecision,
      oneSidedLowerBound: lowerBound,
      target: protocol.minimumPrecision,
      confidence: protocol.confidence,
    },
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
    const result = evaluateClaim(options);
    if (options.outPath) writeJson(options.outPath, result);
    console.log(JSON.stringify(result, null, 2));
    if (result.decision.status === "pass") return 0;
    if (result.decision.status === "insufficient_evidence") return 1;
    return 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

process.exitCode = main();
