#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const reportSchemaVersion = "cellfence.precision-claim-preflight.v1";
const protocolSchemaVersion = "cellfence.precision-claim-protocol.v1";
const defaultMinimumPrecision = 0.99;
const defaultConfidence = 0.95;
const defaultMaxRepositoryContribution = 0.1;
const defaultBlockingSeverities = ["error"];
const blockingDenominatorLabels = new Set(["true_positive", "false_positive", "needs_policy", "needs_review"]);
const blockingSuccessLabels = new Set(["true_positive"]);
const nonHumanRaterPattern = /\b(agent|codex|llm|bot|automated)\b/i;

function usage() {
  console.error(`Usage:
  node scripts/precision-claim-preflight.mjs --bundle reports/corpus/id-bundle --protocol protocol.json [--out report.json]

Reports whether a sealed precision bundle has enough sampled, reviewed,
balanced, independently labeled evidence to attempt the requested claim. This is
a preflight: exit 0 means the claim run is worth attempting, exit 1 means the
evidence/protocol is valid but not claim-ready, and exit 2 means inputs are
malformed.`);
}

function parseArgs(argv) {
  const parsed = { bundleDir: "", protocolPath: "", outPath: "" };
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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (protocol.schemaVersion !== protocolSchemaVersion) issues.push(`protocol schemaVersion must be ${protocolSchemaVersion}`);
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
    requireExternalManifestReview: typeof requireExternalManifestReview === "boolean" ? requireExternalManifestReview : false,
    allowedManifestReviewerTypes: Array.isArray(allowedManifestReviewerTypes) ? allowedManifestReviewerTypes : ["human", "organization"],
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

function isAdjudication(label) {
  return label.role === "adjudicator" || label.adjudication === true || label.adjudicated === true;
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
    existing.nonHuman = existing.nonHuman || nonHumanRaterPattern.test(label.rater || "") || nonHumanRaterPattern.test(label.raterType || label.raterClass || "");
    raters.set(label.rater, existing);
  }
  return {
    totalRaters: raters.size,
    nonHumanRaters: [...raters.values()].filter((entry) => entry.nonHuman).length,
    missingRaterClassLabels: labels.filter((label) => !label.raterType && !label.raterClass).length,
    raters: Object.fromEntries([...raters.entries()].sort(([left], [right]) => left.localeCompare(right))),
  };
}

function raterType(label) {
  return label.raterType || label.raterClass || "";
}

function validateLabelRaterProvenance(labels, protocol, issues) {
  const allowed = new Set(protocol.allowedRaterTypes);
  const missingType = labels.filter((label) => !raterType(label)).length;
  if ((protocol.requireKnownRaterType || allowed.size > 0) && missingType > 0) {
    issues.push(`${missingType} labels are missing raterType/raterClass required by the protocol`);
  }
  if (allowed.size > 0) {
    const disallowed = labels.filter((label) => {
      const type = raterType(label);
      return type && !allowed.has(type);
    });
    if (disallowed.length > 0) {
      issues.push(`${disallowed.length} labels use raterType/raterClass outside the protocol allow-list`);
    }
  }
  if (!protocol.allowNonHumanRaters) {
    const nonHumanLabels = labels.filter((label) => {
      const type = raterType(label);
      return nonHumanRaterPattern.test(label.rater || "") || nonHumanRaterPattern.test(type);
    });
    if (nonHumanLabels.length > 0) issues.push(`${nonHumanLabels.length} labels appear to be non-human but protocol disallows non-human raters`);
  }
}

function reviewAttestations(manifest) {
  if (Array.isArray(manifest?.review?.reviewerAttestations)) return manifest.review.reviewerAttestations;
  if (Array.isArray(manifest?.review?.reviewers) && manifest.review.reviewers.every((reviewer) => isRecord(reviewer))) {
    return manifest.review.reviewers;
  }
  return [];
}

function manifestCopiesBySubject(study, bundleDir) {
  const copies = new Map();
  for (const copy of study.manifestCopies || []) {
    if (!copy?.subjectId || !copy?.path) continue;
    const absolutePath = path.join(bundleDir, copy.path);
    copies.set(copy.subjectId, {
      ...copy,
      actualSha256: fs.existsSync(absolutePath) ? hashFile(absolutePath) : null,
    });
  }
  return copies;
}

function validateManifestReviewProvenance(corpus, study, bundleDir, protocol, issues) {
  if (!protocol.requireExternalManifestReview) return;
  const allowedReviewerTypes = new Set(protocol.allowedManifestReviewerTypes);
  const manifestCopies = manifestCopiesBySubject(study, bundleDir);
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
  const study = readJson(path.join(options.bundleDir, "study.json"));
  const corpus = readJson(path.join(options.bundleDir, "corpus.json"));
  const sampling = readJson(path.join(options.bundleDir, "sampling.json"));
  const findings = readJsonl(path.join(options.bundleDir, "findings.normalized.jsonl"));
  const labels = readJsonl(path.join(options.bundleDir, "labels.jsonl"));

  if (study.schemaVersion !== "cellfence.corpus-evidence-bundle.v1") issues.push("study.json has unexpected schemaVersion");
  if (sampling.schemaVersion !== "cellfence.corpus-sampling.v1") issues.push("sampling.json has unexpected schemaVersion");
  if (study.studyId !== protocol.studyId) issues.push(`bundle studyId ${study.studyId} does not match protocol studyId ${protocol.studyId}`);
  if (study.environment?.harnessDirty === true) gateFailures.push("bundle was produced from a dirty CellFence worktree");
  if (study.environment && study.environment.harnessDirty !== false) warnings.push("study.environment.harnessDirty is not explicitly false");
  validateLabelRaterProvenance(labels, protocol, issues);
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
      requireExternalManifestReview: protocol.requireExternalManifestReview,
      allowedManifestReviewerTypes: protocol.allowedManifestReviewerTypes,
    },
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
