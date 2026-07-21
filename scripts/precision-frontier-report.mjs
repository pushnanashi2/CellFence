#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const schemaVersion = "cellfence.precision-frontier-report.v1";
const defaultMinimumPrecision = 0.99;
const defaultConfidence = 0.95;
const defaultMaxRepositoryContribution = 0.1;

function usage() {
  console.error(`Usage:
  node scripts/precision-frontier-report.mjs --reviewed-claim-report reports/corpus/id-claim-report.json [--candidate-bundle reports/corpus/candidate-bundle] [--include-rules RULE_A,RULE_B] [--top-subjects 25] [--out report.json] [--markdown report.md]

Summarizes why a reviewed precision claim has or has not reached its registered
threshold, then ranks candidate corpus subjects for the next reviewed holdout.
Candidate bundles may contain infer-generated manifests, but those findings are
reported only as review work; they are never counted as claim-ready evidence.`);
}

function parseArgs(argv) {
  const parsed = {
    reviewedClaimReportPath: "",
    candidateBundleDir: "",
    includeRules: [],
    topSubjects: 25,
    outPath: "",
    markdownPath: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--reviewed-claim-report") {
      parsed.reviewedClaimReportPath = path.resolve(requireValue(argv, index, "--reviewed-claim-report"));
      index += 1;
    } else if (argument.startsWith("--reviewed-claim-report=")) {
      parsed.reviewedClaimReportPath = path.resolve(requireInlineValue(argument, "--reviewed-claim-report=", "--reviewed-claim-report"));
    } else if (argument === "--candidate-bundle") {
      parsed.candidateBundleDir = path.resolve(requireValue(argv, index, "--candidate-bundle"));
      index += 1;
    } else if (argument.startsWith("--candidate-bundle=")) {
      parsed.candidateBundleDir = path.resolve(requireInlineValue(argument, "--candidate-bundle=", "--candidate-bundle"));
    } else if (argument === "--include-rules") {
      parsed.includeRules = parseList(requireValue(argv, index, "--include-rules"));
      index += 1;
    } else if (argument.startsWith("--include-rules=")) {
      parsed.includeRules = parseList(requireInlineValue(argument, "--include-rules=", "--include-rules"));
    } else if (argument === "--top-subjects") {
      parsed.topSubjects = parsePositiveInteger(requireValue(argv, index, "--top-subjects"), "--top-subjects");
      index += 1;
    } else if (argument.startsWith("--top-subjects=")) {
      parsed.topSubjects = parsePositiveInteger(requireInlineValue(argument, "--top-subjects=", "--top-subjects"), "--top-subjects");
    } else if (argument === "--out") {
      parsed.outPath = path.resolve(requireValue(argv, index, "--out"));
      index += 1;
    } else if (argument.startsWith("--out=")) {
      parsed.outPath = path.resolve(requireInlineValue(argument, "--out=", "--out"));
    } else if (argument === "--markdown") {
      parsed.markdownPath = path.resolve(requireValue(argv, index, "--markdown"));
      index += 1;
    } else if (argument.startsWith("--markdown=")) {
      parsed.markdownPath = path.resolve(requireInlineValue(argument, "--markdown=", "--markdown"));
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.reviewedClaimReportPath) throw new Error("--reviewed-claim-report is required");
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

function parseList(value) {
  return String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parsePositiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${optionName} must be a positive integer`);
  return parsed;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  return text.split(/\r?\n/).map((line) => JSON.parse(line));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`);
}

function posixify(value) {
  return String(value).replace(/\\/g, "/").split(path.sep).join("/");
}

function increment(counts, key, amount = 1) {
  counts[key] = (counts[key] || 0) + amount;
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

function additionalSuccessesNeeded(successes, trials, minimumPrecision, confidence) {
  const lowerBound = oneSidedExactLowerBound(successes, trials, confidence);
  if (lowerBound !== null && lowerBound >= minimumPrecision) return 0;
  let high = 1;
  while (high <= 1_000_000) {
    const nextLower = oneSidedExactLowerBound(successes + high, trials + high, confidence);
    if (nextLower !== null && nextLower >= minimumPrecision) break;
    high *= 2;
  }
  if (high > 1_000_000) return null;
  let low = 0;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    const nextLower = oneSidedExactLowerBound(successes + mid, trials + mid, confidence);
    if (nextLower !== null && nextLower >= minimumPrecision) high = mid;
    else low = mid;
  }
  return high;
}

function claimProtocol(report) {
  const protocol = report.protocol || {};
  const blockingSeverities = Array.isArray(protocol.blockingSeverities) && protocol.blockingSeverities.length > 0
    ? protocol.blockingSeverities
    : ["error"];
  return {
    studyId: protocol.studyId || null,
    includedRules: Array.isArray(protocol.includedRules) ? protocol.includedRules : [],
    minimumPrecision: protocol.minimumPrecision || report.decision?.target || defaultMinimumPrecision,
    confidence: protocol.confidence || report.decision?.confidence || defaultConfidence,
    blockingSeverities,
    maxRepositoryContribution: protocol.maxRepositoryContribution || defaultMaxRepositoryContribution,
    requireExternalManifestReview: protocol.requireExternalManifestReview === true,
    targetPopulation: protocol.targetPopulation || null,
  };
}

function ruleGap(ruleId, metric, protocol) {
  const blocking = metric?.blocking || {};
  const successes = blocking.successes || 0;
  const trials = blocking.trials || 0;
  const lowerBound = blocking.oneSidedLowerBound ?? null;
  const observedPrecision = blocking.observedPrecision ?? null;
  const failures = Math.max(0, trials - successes);
  const additionalTrialsForLowerBound = additionalSuccessesNeeded(
    successes,
    trials,
    protocol.minimumPrecision,
    protocol.confidence,
  );
  return {
    ruleId,
    successes,
    trials,
    failures,
    observedPrecision,
    oneSidedLowerBound: lowerBound,
    additionalZeroFailureTrialsForLowerBound: additionalTrialsForLowerBound,
    status: lowerBound !== null && lowerBound >= protocol.minimumPrecision ? "satisfied" : "insufficient_evidence",
  };
}

function repositoryDilution(report, protocol) {
  const repositories = report.metrics?.repositories?.repositories || [];
  const totalTrials = repositories.reduce((sum, repository) => sum + (repository.trials || 0), 0);
  const rows = repositories
    .filter((repository) => (repository.trials || 0) > 0)
    .map((repository) => {
      const trials = repository.trials || 0;
      const contribution = totalTrials === 0 ? null : trials / totalTrials;
      const additionalOutsideRepositoryForCap = contribution !== null && contribution > protocol.maxRepositoryContribution
        ? Math.ceil((trials / protocol.maxRepositoryContribution) - totalTrials)
        : 0;
      return {
        repository: repository.repository,
        trials,
        contribution,
        observedBlockingPrecision: repository.observedBlockingPrecision ?? null,
        oneSidedLowerBound: repository.oneSidedLowerBound ?? null,
        additionalOutsideRepositoryForCap,
      };
    });
  rows.sort((left, right) => {
    return (right.additionalOutsideRepositoryForCap - left.additionalOutsideRepositoryForCap)
      || (right.trials - left.trials)
      || String(left.repository).localeCompare(String(right.repository));
  });
  return {
    totalTrials,
    maxRepositoryContribution: report.metrics?.repositories?.maxRepositoryContribution ?? null,
    maxAllowedRepositoryContribution: protocol.maxRepositoryContribution,
    repositoriesOverCap: rows.filter((row) => row.additionalOutsideRepositoryForCap > 0),
  };
}

function manifestRequirementFor(finding) {
  const strategy = finding.manifestStrategy || "existing";
  const reviewStatus = finding.manifestReviewStatus || "unknown";
  if (strategy === "infer") return "reviewed_manifest_required";
  if (strategy === "copy" && reviewStatus !== "reviewed") return "manifest_review_required";
  if (finding.precisionEligible === true) return "claim_ready";
  return "precision_eligibility_required";
}

function summarizeCandidateBundle(bundleDir, includeRules, blockingSeverities, topSubjects) {
  if (!bundleDir) return null;
  const study = readJson(path.join(bundleDir, "study.json"));
  const sampling = readJson(path.join(bundleDir, "sampling.json"));
  const findings = readJsonl(path.join(bundleDir, "findings.normalized.jsonl"));
  const sampledIds = new Set(sampling.sampledFindingIds || []);
  const included = includeRules.length > 0 ? new Set(includeRules) : null;
  const includedSeverities = new Set(blockingSeverities);
  const candidateFindings = findings.filter((finding) => {
    return (!included || included.has(finding.ruleId))
      && includedSeverities.has(finding.severity || "error");
  });
  const sampledCandidateFindings = candidateFindings.filter((finding) => sampledIds.has(finding.findingId));
  const byRule = {};
  const sampledByRule = {};
  const byRuleRequirement = {};
  const byRequirement = {};
  for (const finding of candidateFindings) {
    increment(byRule, finding.ruleId);
    const requirement = manifestRequirementFor(finding);
    increment(byRequirement, requirement);
    byRuleRequirement[finding.ruleId] ||= {};
    increment(byRuleRequirement[finding.ruleId], requirement);
  }
  for (const finding of sampledCandidateFindings) increment(sampledByRule, finding.ruleId);

  const manifestCopies = new Map((study.manifestCopies || []).map((copy) => [copy.subjectId, copy]));
  const subjectRows = [];
  for (const [subjectId, subjectFindings] of groupBy(candidateFindings, (finding) => finding.subjectId || "unknown")) {
    const representative = subjectFindings[0] || {};
    const countsByRule = {};
    const countsByRequirement = {};
    for (const finding of subjectFindings) {
      increment(countsByRule, finding.ruleId);
      increment(countsByRequirement, manifestRequirementFor(finding));
    }
    subjectRows.push({
      subjectId,
      repository: representative.repository || null,
      commit: representative.commit || null,
      manifestStrategy: representative.manifestStrategy || null,
      manifestReviewStatus: representative.manifestReviewStatus || null,
      manifestCopy: manifestCopies.get(subjectId)?.path || null,
      totalIncludedFindings: subjectFindings.length,
      sampledIncludedFindings: subjectFindings.filter((finding) => sampledIds.has(finding.findingId)).length,
      countsByRule,
      countsByRequirement,
      nextAction: countsByRequirement.claim_ready > 0 ? "label_or_adjudicate" : "review_manifest_before_claim",
    });
  }
  subjectRows.sort((left, right) => {
    return (right.sampledIncludedFindings - left.sampledIncludedFindings)
      || (right.totalIncludedFindings - left.totalIncludedFindings)
      || left.subjectId.localeCompare(right.subjectId);
  });

  return {
    path: posixify(bundleDir),
    studyId: study.studyId || null,
    harnessCommit: study.environment?.harnessCommit || null,
    harnessDirty: study.environment?.harnessDirty ?? null,
    totalFindings: findings.length,
    sampledFindings: sampledIds.size,
    includedSeverities: [...includedSeverities].sort(),
    includedFindings: candidateFindings.length,
    sampledIncludedFindings: sampledCandidateFindings.length,
    claimReadyIncludedFindings: candidateFindings.filter((finding) => manifestRequirementFor(finding) === "claim_ready").length,
    rawPrecisionEligibleIncludedFindings: candidateFindings.filter((finding) => finding.precisionEligible === true).length,
    byRule: Object.fromEntries(Object.entries(byRule).sort()),
    sampledByRule: Object.fromEntries(Object.entries(sampledByRule).sort()),
    byRequirement: Object.fromEntries(Object.entries(byRequirement).sort()),
    byRuleRequirement: Object.fromEntries(Object.entries(byRuleRequirement).sort()),
    topSubjects: subjectRows.slice(0, topSubjects),
  };
}

function buildReport(options) {
  const reviewedClaimReport = readJson(options.reviewedClaimReportPath);
  const protocol = claimProtocol(reviewedClaimReport);
  const includeRules = options.includeRules.length > 0 ? options.includeRules : protocol.includedRules;
  const zeroFalsePositiveRequiredTrials = requiredZeroFalsePositiveSampleSize(protocol.minimumPrecision, protocol.confidence);
  const ruleGaps = includeRules.map((ruleId) => ruleGap(ruleId, reviewedClaimReport.metrics?.byRule?.[ruleId], protocol));
  const candidate = summarizeCandidateBundle(options.candidateBundleDir, includeRules, protocol.blockingSeverities, options.topSubjects);
  const blockers = [];
  if (reviewedClaimReport.decision?.status !== "pass") blockers.push(`reviewed claim status is ${reviewedClaimReport.decision?.status || "unknown"}`);
  for (const gap of ruleGaps) {
    if (gap.status !== "satisfied") blockers.push(`${gap.ruleId} needs ${gap.additionalZeroFailureTrialsForLowerBound ?? "more than 1000000"} additional zero-failure labeled trial(s)`);
  }
  const dilution = repositoryDilution(reviewedClaimReport, protocol);
  for (const repository of dilution.repositoriesOverCap) {
    blockers.push(`${repository.repository} exceeds repository contribution cap; add ${repository.additionalOutsideRepositoryForCap} outside-repository trial(s)`);
  }
  if (candidate && candidate.claimReadyIncludedFindings === 0 && candidate.includedFindings > 0) {
    blockers.push("candidate bundle has included findings but none are claim-ready; reviewed manifests are required before claim use");
  }
  return {
    schemaVersion,
    generatedAt: new Date().toISOString(),
    inputs: {
      reviewedClaimReport: posixify(options.reviewedClaimReportPath),
      candidateBundle: options.candidateBundleDir ? posixify(options.candidateBundleDir) : null,
    },
    protocol: {
      ...protocol,
      includedRules: includeRules,
      zeroFalsePositiveRequiredTrials,
    },
    currentReviewedClaim: {
      status: reviewedClaimReport.decision?.status || null,
      reason: reviewedClaimReport.decision?.reason || null,
      observedBlockingPrecision: reviewedClaimReport.decision?.observedBlockingPrecision ?? null,
      oneSidedLowerBound: reviewedClaimReport.decision?.oneSidedLowerBound ?? null,
      occurrenceTrials: reviewedClaimReport.metrics?.occurrence?.blocking?.trials ?? null,
      occurrenceSuccesses: reviewedClaimReport.metrics?.occurrence?.blocking?.successes ?? null,
      uniqueFingerprintTrials: reviewedClaimReport.metrics?.uniqueFingerprint?.blocking?.trials ?? null,
      uniqueFingerprintSuccesses: reviewedClaimReport.metrics?.uniqueFingerprint?.blocking?.successes ?? null,
      repositoryMacroPrecision: reviewedClaimReport.metrics?.repositories?.repositoryMacroPrecision ?? null,
      claimGateFailures: reviewedClaimReport.claimGates?.failures || [],
    },
    ruleGaps,
    repositoryDilution: dilution,
    candidatePool: candidate,
    decision: {
      status: blockers.length === 0 ? "ready_for_claim_attempt" : "not_ready",
      blockers,
    },
    nextActions: [
      "Freeze a separate holdout corpus before using candidate findings for a public claim.",
      "Promote candidate subjects only after manifest review; infer-generated manifests remain diagnostic-only.",
      "Generate a sealed blind worklist from the reviewed holdout bundle and collect two independent labels per finding.",
      "Generate a sealed adjudication worklist for disagreements before running claim preflight.",
      "Keep resource and generated-artifact policy questions out of a 99% blocking claim until their contracts are reviewed.",
    ],
  };
}

function percent(value) {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Precision Claim Frontier`);
  lines.push("");
  lines.push(`Generated: \`${report.generatedAt}\``);
  lines.push("");
  lines.push(`## Current Reviewed Claim`);
  lines.push("");
  lines.push(`- Status: \`${report.currentReviewedClaim.status}\``);
  lines.push(`- Reason: ${report.currentReviewedClaim.reason || "n/a"}`);
  lines.push(`- Blocking precision: ${percent(report.currentReviewedClaim.observedBlockingPrecision)}`);
  lines.push(`- One-sided lower bound: ${percent(report.currentReviewedClaim.oneSidedLowerBound)}`);
  lines.push(`- Target: ${percent(report.protocol.minimumPrecision)} at ${percent(report.protocol.confidence)} confidence`);
  lines.push(`- Zero-failure trial requirement: ${report.protocol.zeroFalsePositiveRequiredTrials}`);
  lines.push("");
  lines.push(`## Rule Gaps`);
  lines.push("");
  lines.push(`| Rule | Successes | Trials | Failures | Lower bound | Additional zero-failure trials |`);
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: |`);
  for (const gap of report.ruleGaps) {
    lines.push(`| \`${gap.ruleId}\` | ${gap.successes} | ${gap.trials} | ${gap.failures} | ${percent(gap.oneSidedLowerBound)} | ${gap.additionalZeroFailureTrialsForLowerBound ?? ">" + 1_000_000} |`);
  }
  lines.push("");
  lines.push(`## Repository Balance`);
  lines.push("");
  if (report.repositoryDilution.repositoriesOverCap.length === 0) {
    lines.push("No repository exceeds the configured contribution cap.");
  } else {
    lines.push(`| Repository | Trials | Contribution | Additional outside trials |`);
    lines.push(`| --- | ---: | ---: | ---: |`);
    for (const repository of report.repositoryDilution.repositoriesOverCap) {
      lines.push(`| ${repository.repository} | ${repository.trials} | ${percent(repository.contribution)} | ${repository.additionalOutsideRepositoryForCap} |`);
    }
  }
  if (report.candidatePool) {
    lines.push("");
    lines.push(`## Candidate Pool`);
    lines.push("");
    lines.push(`- Bundle: \`${report.candidatePool.path}\``);
    lines.push(`- Included severities: \`${JSON.stringify(report.candidatePool.includedSeverities)}\``);
    lines.push(`- Included findings: ${report.candidatePool.includedFindings}`);
    lines.push(`- Sampled included findings: ${report.candidatePool.sampledIncludedFindings}`);
    lines.push(`- Claim-ready included findings: ${report.candidatePool.claimReadyIncludedFindings}`);
    lines.push(`- Raw precision-eligible included findings: ${report.candidatePool.rawPrecisionEligibleIncludedFindings}`);
    lines.push(`- Requirement counts: \`${JSON.stringify(report.candidatePool.byRequirement)}\``);
    lines.push("");
    lines.push(`| Subject | Sampled | Total | Next action | Rules |`);
    lines.push(`| --- | ---: | ---: | --- | --- |`);
    for (const subject of report.candidatePool.topSubjects.slice(0, 15)) {
      lines.push(`| \`${subject.subjectId}\` | ${subject.sampledIncludedFindings} | ${subject.totalIncludedFindings} | ${subject.nextAction} | \`${JSON.stringify(subject.countsByRule)}\` |`);
    }
  }
  lines.push("");
  lines.push(`## Decision`);
  lines.push("");
  lines.push(`Status: \`${report.decision.status}\``);
  for (const blocker of report.decision.blockers) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push(`## Next Actions`);
  lines.push("");
  for (const action of report.nextActions) lines.push(`- ${action}`);
  return `${lines.join("\n")}\n`;
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
    const report = buildReport(options);
    if (options.outPath) writeJson(options.outPath, report);
    if (options.markdownPath) writeText(options.markdownPath, renderMarkdown(report));
    console.log(JSON.stringify(report, null, 2));
    return report.decision.status === "ready_for_claim_attempt" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

process.exitCode = main();
