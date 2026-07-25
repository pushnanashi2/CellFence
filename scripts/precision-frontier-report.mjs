#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const schemaVersion = "cellfence.precision-frontier-report.v1";
const defaultMinimumPrecision = 0.99;
const defaultConfidence = 0.95;
const defaultMaxRepositoryContribution = 0.1;
const defaultExternalRaterTypes = ["human", "organization"];
const defaultMinimumIndependentRaters = 2;
const nonHumanRaterPattern = /\b(agent|codex|llm|bot|automated)\b/i;

function usage() {
  console.error(`Usage:
  node scripts/precision-frontier-report.mjs --reviewed-claim-report reports/corpus/id-claim-report.json [--candidate-bundle reports/corpus/candidate-bundle] [--include-rules RULE_A,RULE_B] [--top-subjects 25] [--out report.json] [--markdown report.md]

Summarizes why a reviewed precision claim has or has not reached its registered
threshold, then ranks candidate corpus subjects for the next reviewed holdout.
Candidate bundles may contain infer-generated manifests or agent-only labels,
but those findings are reported only as review work; they are never counted as
claim evidence.`);
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
    studyId: protocol.studyId || report.studyId || null,
    includedRules: Array.isArray(protocol.includedRules) ? protocol.includedRules : [],
    minimumPrecision: protocol.minimumPrecision || report.decision?.target || defaultMinimumPrecision,
    confidence: protocol.confidence || report.decision?.confidence || defaultConfidence,
    blockingSeverities,
    maxRepositoryContribution: protocol.maxRepositoryContribution || defaultMaxRepositoryContribution,
    requireExternalManifestReview: protocol.requireExternalManifestReview === true,
    allowedManifestReviewerTypes: Array.isArray(protocol.allowedManifestReviewerTypes) && protocol.allowedManifestReviewerTypes.length > 0
      ? protocol.allowedManifestReviewerTypes
      : defaultExternalRaterTypes,
    minimumIndependentRaters: Number.isInteger(protocol.minimumIndependentRaters) && protocol.minimumIndependentRaters > 0
      ? protocol.minimumIndependentRaters
      : defaultMinimumIndependentRaters,
    requireExternalIndependentRaters: protocol.requireExternalIndependentRaters ?? protocol.requireExternalIndependentLabels ?? true,
    externalRaterTypes: Array.isArray(protocol.externalRaterTypes) && protocol.externalRaterTypes.length > 0
      ? protocol.externalRaterTypes
      : defaultExternalRaterTypes,
    minimumExternalIndependentRaters: Number.isInteger(protocol.minimumExternalIndependentRaters) && protocol.minimumExternalIndependentRaters > 0
      ? protocol.minimumExternalIndependentRaters
      : 1,
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
  const requiredZeroFalsePositiveFindings = metric?.requiredZeroFalsePositiveFindings ?? requiredZeroFalsePositiveSampleSize(protocol.minimumPrecision, protocol.confidence);
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
    requiredZeroFalsePositiveFindings,
    selectedFindings: metric?.selectedFindings ?? null,
    unlabeled: metric?.counts?.unlabeled ?? null,
    sampleDeficitBeforeLabeling: metric?.sampleDeficitBeforeLabeling ?? null,
    status: lowerBound !== null && lowerBound >= protocol.minimumPrecision ? "satisfied" : "insufficient_evidence",
  };
}

function ruleGapBlocker(gap) {
  if ((gap.sampleDeficitBeforeLabeling || 0) > 0) {
    return `${gap.ruleId} has ${gap.selectedFindings ?? 0} selected finding(s) and needs ${gap.sampleDeficitBeforeLabeling} more selected finding(s) before labeling can meet the per-rule zero-failure requirement`;
  }
  if ((gap.unlabeled || 0) > 0) {
    return `${gap.ruleId} has ${gap.selectedFindings ?? 0} selected finding(s), but ${gap.unlabeled} remain unlabeled; label at least ${gap.requiredZeroFalsePositiveFindings} zero-failure finding(s) for the requested bound`;
  }
  return `${gap.ruleId} needs ${gap.additionalZeroFailureTrialsForLowerBound ?? "more than 1000000"} additional zero-failure labeled trial(s)`;
}

function metricByRule(report, ruleId) {
  return report.metrics?.byRule?.[ruleId] || report.selectedByRule?.[ruleId] || null;
}

function reportDecision(report) {
  if (report.schemaVersion === "cellfence.precision-claim-preflight.v1") {
    return {
      status: report.claimReady === true ? "preflight_ready" : "preflight_not_ready",
      reason: (report.gateFailures || [])[0] || (report.issues || [])[0] || null,
      observedBlockingPrecision: report.summary?.observedPrecision ?? null,
      oneSidedLowerBound: report.summary?.oneSidedLowerBound ?? null,
    };
  }
  return {
    status: report.decision?.status || null,
    reason: report.decision?.reason || null,
    observedBlockingPrecision: report.decision?.observedBlockingPrecision ?? null,
    oneSidedLowerBound: report.decision?.oneSidedLowerBound ?? null,
  };
}

function repositoryDilution(report, protocol) {
  if (report.repositoryContribution) {
    const contribution = report.repositoryContribution;
    const repositorySelectedFindings = (contribution.repositories || []).reduce((sum, repository) => {
      return sum + (repository.selectedFindings || repository.trials || 0);
    }, 0);
    const totalSelectedFindings = contribution.totalSelectedFindings
      ?? report.summary?.selectedFindings
      ?? repositorySelectedFindings;
    const rows = (contribution.repositories || [])
      .filter((repository) => (repository.selectedFindings || repository.trials || 0) > 0)
      .map((repository) => {
        const selectedFindings = repository.selectedFindings || repository.trials || 0;
        const rowContribution = repository.contribution ?? (totalSelectedFindings === 0 ? null : selectedFindings / totalSelectedFindings);
        const additionalOutsideRepositoryForCap = repository.additionalOtherFindingsNeeded
          ?? (rowContribution !== null && rowContribution > protocol.maxRepositoryContribution
            ? Math.ceil((selectedFindings / protocol.maxRepositoryContribution) - totalSelectedFindings)
            : 0);
        return {
          repository: repository.repository,
          selectedFindings,
          contribution: rowContribution,
          observedBlockingPrecision: repository.observedBlockingPrecision ?? null,
          oneSidedLowerBound: repository.oneSidedLowerBound ?? null,
          additionalOutsideRepositoryForCap,
          overLimit: repository.overLimit === true || additionalOutsideRepositoryForCap > 0,
        };
      });
    rows.sort((left, right) => {
      return (right.additionalOutsideRepositoryForCap - left.additionalOutsideRepositoryForCap)
        || (right.selectedFindings - left.selectedFindings)
        || String(left.repository).localeCompare(String(right.repository));
    });
    return {
      countKind: "selected_findings",
      totalSelectedFindings,
      maxRepositoryContribution: contribution.maxRepositoryContribution ?? null,
      maxAllowedRepositoryContribution: contribution.limit ?? protocol.maxRepositoryContribution,
      repositoriesOverCap: rows.filter((row) => row.overLimit),
    };
  }
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
    countKind: "labeled_trials",
    totalTrials,
    maxRepositoryContribution: report.metrics?.repositories?.maxRepositoryContribution ?? null,
    maxAllowedRepositoryContribution: protocol.maxRepositoryContribution,
    repositoriesOverCap: rows.filter((row) => row.additionalOutsideRepositoryForCap > 0),
  };
}

function repositoryCountFor(row, countKind) {
  if (countKind === "selected_findings") return row.selectedFindings ?? 0;
  return row.trials ?? 0;
}

function repositoryCountLabel(countKind) {
  return countKind === "selected_findings" ? "Selected findings" : "Trials";
}

function repositoryAdditionalLabel(countKind) {
  return countKind === "selected_findings" ? "Additional outside selected findings" : "Additional outside trials";
}

function repositoryBlockerUnit(countKind) {
  return countKind === "selected_findings" ? "outside-repository selected finding(s)" : "outside-repository trial(s)";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reviewAttestations(manifest) {
  if (Array.isArray(manifest?.review?.reviewerAttestations)) return manifest.review.reviewerAttestations;
  if (Array.isArray(manifest?.review?.reviewers) && manifest.review.reviewers.every((reviewer) => isRecord(reviewer))) {
    return manifest.review.reviewers;
  }
  return [];
}

function manifestReviewStatus(manifest) {
  if (manifest?.reviewStatus) return manifest.reviewStatus;
  if (manifest?.reviewed === true) return "reviewed";
  return "unreviewed";
}

function subjectManifestForFinding(corpus, subject) {
  if (corpus?.schemaVersion === "cellfence.history-replay.v1") return subject?.before?.manifest || {};
  return subject?.manifest || {};
}

function manifestCopyKeyFor(corpus, subjectId) {
  return corpus?.schemaVersion === "cellfence.history-replay.v1" ? `${subjectId}\0before` : subjectId;
}

function historyReplayHasCandidateProvenance(context, finding) {
  if (context.corpus?.schemaVersion !== "cellfence.history-replay.v1") return true;
  const subject = context.subjects.get(finding.subjectId);
  const beforeManifest = subject?.before?.manifest || {};
  const afterManifest = subject?.after?.manifest || {};
  return beforeManifest.strategy === "copy"
    && afterManifest.strategy === "reuse-before"
    && finding.manifestStrategy === "reuse-before"
    && finding.manifestReviewStatus === "reviewed"
    && finding.replay?.proofEligibility === "counterfactual_candidate_requires_manual_label"
    && finding.replay?.replayKind === "single_commit_intro"
    && finding.replay?.introducedChangedFile === true;
}

function subjectHasExternalManifestAttestation(context, finding) {
  const subject = context.subjects.get(finding.subjectId);
  if (!subject) return false;
  const manifest = subjectManifestForFinding(context.corpus, subject);
  if ((manifest.strategy || "existing") !== "copy") return false;
  if (manifestReviewStatus(manifest) !== "reviewed") return false;
  const review = manifest.review || {};
  if (typeof review.reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(review.reviewedAt)) return false;
  if (typeof review.scope !== "string" || review.scope.length === 0) return false;
  if (!/^[a-f0-9]{64}$/.test(String(review.reviewedManifestSha256 || ""))) return false;
  const copy = context.manifestCopies.get(manifestCopyKeyFor(context.corpus, finding.subjectId));
  const copySha256 = copy?.sha256 || copy?.actualSha256 || null;
  if (copySha256 && review.reviewedManifestSha256 !== copySha256) return false;
  const allowedTypes = new Set(context.protocol.allowedManifestReviewerTypes);
  return reviewAttestations(manifest).some((attestation) => {
    const reviewerType = attestation.reviewerType || attestation.raterType || attestation.reviewerClass;
    return typeof attestation.id === "string"
      && attestation.id.length > 0
      && !nonHumanRaterPattern.test(attestation.id)
      && allowedTypes.has(reviewerType)
      && attestation.independent === true;
  });
}

function isAdjudicationLabel(label) {
  return label?.role === "adjudication"
    || label?.round === "adjudication"
    || label?.adjudication === true
    || label?.adjudicated === true;
}

function labelRaterType(label) {
  if (typeof label?.raterType === "string") return label.raterType;
  if (typeof label?.raterClass === "string") return label.raterClass;
  return "";
}

function independentLabelsForFinding(context, findingId) {
  return (context.labelsByFinding.get(findingId) || []).filter((label) => {
    return !isAdjudicationLabel(label) && label.sawPeerLabels === false;
  });
}

function externalIndependentLabelsForFinding(context, findingId) {
  const allowedTypes = new Set(context.protocol.externalRaterTypes);
  return independentLabelsForFinding(context, findingId).filter((label) => {
    const rater = String(label.rater || "");
    return allowedTypes.has(labelRaterType(label)) && !nonHumanRaterPattern.test(rater);
  });
}

function externalIndependentRaterCountForFinding(context, findingId) {
  return new Set(externalIndependentLabelsForFinding(context, findingId).map((label) => label.rater).filter(Boolean)).size;
}

function independentRaterCountForFinding(context, findingId) {
  return new Set(independentLabelsForFinding(context, findingId).map((label) => label.rater).filter(Boolean)).size;
}

function manifestRequirementFor(finding, context = null) {
  const strategy = finding.manifestStrategy || "existing";
  const reviewStatus = finding.manifestReviewStatus || "unknown";
  if (strategy === "infer") return "reviewed_manifest_required";
  if (strategy === "copy" && reviewStatus !== "reviewed") return "manifest_review_required";
  if (finding.precisionEligible !== true) return "precision_eligibility_required";
  if (context && !historyReplayHasCandidateProvenance(context, finding)) return "history_replay_provenance_required";
  if (context?.protocol?.requireExternalManifestReview === true && !subjectHasExternalManifestAttestation(context, finding)) {
    return "external_manifest_attestation_required";
  }
  if (!context || independentRaterCountForFinding(context, finding.findingId) < context.protocol.minimumIndependentRaters) return "blind_label_required";
  if (
    context.protocol.requireExternalIndependentRaters === true
    && externalIndependentRaterCountForFinding(context, finding.findingId) < context.protocol.minimumExternalIndependentRaters
  ) {
    return "external_independent_label_required";
  }
  return "claim_preflight_required";
}

function nextActionForRequirements(countsByRequirement) {
  if (countsByRequirement.reviewed_manifest_required || countsByRequirement.manifest_review_required) return "review_manifest_before_claim";
  if (countsByRequirement.external_manifest_attestation_required) return "collect_external_manifest_attestation";
  if (countsByRequirement.history_replay_provenance_required) return "fix_history_replay_provenance";
  if (countsByRequirement.blind_label_required) return "complete_blind_labels";
  if (countsByRequirement.external_independent_label_required) return "collect_external_independent_label";
  if (countsByRequirement.precision_eligibility_required) return "fix_precision_eligibility";
  if (countsByRequirement.claim_preflight_required) return "run_claim_preflight";
  return "inspect_candidate";
}

function summarizeCandidateBundle(bundleDir, includeRules, blockingSeverities, topSubjects, protocol) {
  if (!bundleDir) return null;
  const study = readJson(path.join(bundleDir, "study.json"));
  const corpus = readJson(path.join(bundleDir, "corpus.json"));
  const sampling = readJson(path.join(bundleDir, "sampling.json"));
  const findings = readJsonl(path.join(bundleDir, "findings.normalized.jsonl"));
  const labels = readJsonl(path.join(bundleDir, "labels.jsonl"));
  const labelsByFinding = groupBy(labels, (label) => label.findingId || "");
  const sampledIds = new Set(sampling.sampledFindingIds || []);
  const included = includeRules.length > 0 ? new Set(includeRules) : null;
  const includedSeverities = new Set(blockingSeverities);
  const subjects = new Map((corpus.subjects || []).map((subject) => [subject.id, subject]));
  const manifestCopies = new Map((study.manifestCopies || []).map((copy) => [copy.phase ? `${copy.subjectId}\0${copy.phase}` : copy.subjectId, copy]));
  const requirementContext = {
    corpus,
    labelsByFinding,
    manifestCopies,
    protocol,
    subjects,
  };
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
    const requirement = manifestRequirementFor(finding, requirementContext);
    increment(byRequirement, requirement);
    byRuleRequirement[finding.ruleId] ||= {};
    increment(byRuleRequirement[finding.ruleId], requirement);
  }
  for (const finding of sampledCandidateFindings) increment(sampledByRule, finding.ruleId);

  const subjectRows = [];
  for (const [subjectId, subjectFindings] of groupBy(candidateFindings, (finding) => finding.subjectId || "unknown")) {
    const representative = subjectFindings[0] || {};
    const countsByRule = {};
    const countsByRequirement = {};
    for (const finding of subjectFindings) {
      increment(countsByRule, finding.ruleId);
      increment(countsByRequirement, manifestRequirementFor(finding, requirementContext));
    }
    subjectRows.push({
      subjectId,
      repository: representative.repository || null,
      commit: representative.commit || null,
      manifestStrategy: representative.manifestStrategy || null,
      manifestReviewStatus: representative.manifestReviewStatus || null,
      manifestCopy: manifestCopies.get(manifestCopyKeyFor(corpus, subjectId))?.path || null,
      totalIncludedFindings: subjectFindings.length,
      sampledIncludedFindings: subjectFindings.filter((finding) => sampledIds.has(finding.findingId)).length,
      countsByRule,
      countsByRequirement,
      nextAction: nextActionForRequirements(countsByRequirement),
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
    claimPreflightRequiredIncludedFindings: candidateFindings.filter((finding) => manifestRequirementFor(finding, requirementContext) === "claim_preflight_required").length,
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
  const ruleGaps = includeRules.map((ruleId) => ruleGap(ruleId, metricByRule(reviewedClaimReport, ruleId), protocol));
  const candidate = summarizeCandidateBundle(options.candidateBundleDir, includeRules, protocol.blockingSeverities, options.topSubjects, protocol);
  const blockers = [];
  const currentDecision = reportDecision(reviewedClaimReport);
  if (currentDecision.status !== "pass" && currentDecision.status !== "preflight_ready") blockers.push(`reviewed claim status is ${currentDecision.status || "unknown"}`);
  for (const gap of ruleGaps) {
    if (gap.status !== "satisfied") blockers.push(ruleGapBlocker(gap));
  }
  const dilution = repositoryDilution(reviewedClaimReport, protocol);
  for (const repository of dilution.repositoriesOverCap) {
    blockers.push(`${repository.repository} exceeds repository contribution cap; add ${repository.additionalOutsideRepositoryForCap} ${repositoryBlockerUnit(dilution.countKind)}`);
  }
  if (candidate && candidate.claimPreflightRequiredIncludedFindings === 0 && candidate.includedFindings > 0) {
    blockers.push("candidate bundle has included findings but none have reached the claim-preflight-required state; external manifest attestations, blind labels, and claim preflight are required before claim use");
  }
  const workPlan = buildWorkPlan({
    ruleGaps,
    dilution,
    candidate,
    protocol,
    currentDecision,
    reviewedClaimReport,
  });
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
      status: currentDecision.status,
      reason: currentDecision.reason,
      observedBlockingPrecision: currentDecision.observedBlockingPrecision,
      oneSidedLowerBound: currentDecision.oneSidedLowerBound,
      occurrenceTrials: reviewedClaimReport.metrics?.occurrence?.blocking?.trials ?? null,
      occurrenceSuccesses: reviewedClaimReport.metrics?.occurrence?.blocking?.successes ?? null,
      uniqueFingerprintTrials: reviewedClaimReport.metrics?.uniqueFingerprint?.blocking?.trials ?? null,
      uniqueFingerprintSuccesses: reviewedClaimReport.metrics?.uniqueFingerprint?.blocking?.successes ?? null,
      repositoryMacroPrecision: reviewedClaimReport.metrics?.repositories?.repositoryMacroPrecision ?? null,
      claimGateFailures: reviewedClaimReport.claimGates?.failures || [],
      selectedFindings: reviewedClaimReport.summary?.selectedFindings ?? null,
      missingLabels: reviewedClaimReport.summary?.missingLabels ?? null,
      gateFailures: reviewedClaimReport.gateFailures || [],
    },
    ruleGaps,
    repositoryDilution: dilution,
    candidatePool: candidate,
    workPlan,
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

function maxValue(values) {
  return values.length === 0 ? 0 : Math.max(...values);
}

function ruleWorkPlan(ruleGaps) {
  return ruleGaps.map((gap) => {
    const sampleDeficit = Math.max(0, gap.sampleDeficitBeforeLabeling ?? 0);
    const unlabeled = Math.max(0, gap.unlabeled ?? 0);
    const lowerBoundDeficit = typeof gap.additionalZeroFailureTrialsForLowerBound === "number"
      ? Math.max(0, gap.additionalZeroFailureTrialsForLowerBound)
      : null;
    return {
      ruleId: gap.ruleId,
      status: gap.status,
      selectedFindings: gap.selectedFindings,
      requiredZeroFalsePositiveFindings: gap.requiredZeroFalsePositiveFindings,
      existingSelectedFindingsNeedingLabels: unlabeled,
      additionalSelectedFindingsNeededBeforeLabeling: sampleDeficit,
      additionalZeroFailureTrialsForLowerBound: lowerBoundDeficit,
      minimumAdditionalZeroFailureFindings: lowerBoundDeficit === null
        ? null
        : Math.max(sampleDeficit, lowerBoundDeficit),
    };
  });
}

function buildWorkPlan({ ruleGaps, dilution, candidate, protocol, currentDecision, reviewedClaimReport }) {
  const ruleCoverage = ruleWorkPlan(ruleGaps);
  const repositoryAdditions = (dilution.repositoriesOverCap || [])
    .map((repository) => repository.additionalOutsideRepositoryForCap || 0);
  const candidateRequirements = candidate?.byRequirement || {};
  const reviewedExternalCoverage = reviewedClaimReport.labelQuality?.externalRaterCoverage || null;
  const reviewedFindingsMissingExternalIndependentLabels = reviewedExternalCoverage?.findingsMissingExternalIndependentLabels ?? null;
  const candidateFindingsNeedingExternalIndependentLabels = candidateRequirements.external_independent_label_required || 0;
  const minimumExternalIndependentLabelRows = (
    (reviewedFindingsMissingExternalIndependentLabels ?? 0)
    + candidateFindingsNeedingExternalIndependentLabels
  ) * Math.max(1, protocol.minimumExternalIndependentRaters || 1);
  const blockers = [];
  if (currentDecision.status !== "pass" && currentDecision.status !== "preflight_ready") {
    blockers.push("reviewed_claim_not_ready");
  }
  if (ruleCoverage.some((rule) => rule.status !== "satisfied")) blockers.push("rule_level_sample_or_lower_bound_gap");
  if ((dilution.repositoriesOverCap || []).length > 0) blockers.push("repository_contribution_over_cap");
  if ((reviewedFindingsMissingExternalIndependentLabels || 0) > 0 || candidateFindingsNeedingExternalIndependentLabels > 0) {
    blockers.push("external_independent_labels_missing");
  }
  if ((candidateRequirements.external_manifest_attestation_required || 0) > 0) blockers.push("external_manifest_attestations_missing");
  if ((candidateRequirements.reviewed_manifest_required || 0) > 0 || (candidateRequirements.manifest_review_required || 0) > 0) {
    blockers.push("candidate_manifest_review_missing");
  }
  if ((candidateRequirements.blind_label_required || 0) > 0) blockers.push("blind_labels_missing");
  return {
    status: blockers.length === 0 ? "ready_for_claim_attempt" : "not_ready",
    blockers,
    ruleCoverage,
    repositoryBalance: {
      countKind: dilution.countKind,
      maxAllowedRepositoryContribution: dilution.maxAllowedRepositoryContribution,
      repositoriesOverCap: (dilution.repositoriesOverCap || []).length,
      minimumAdditionalOutsideFindings: maxValue(repositoryAdditions),
    },
    externalEvidence: {
      requireExternalIndependentRaters: protocol.requireExternalIndependentRaters,
      minimumExternalIndependentRaters: protocol.minimumExternalIndependentRaters,
      reviewedFindingsMissingExternalIndependentLabels,
      candidateFindingsNeedingExternalIndependentLabels,
      minimumExternalIndependentLabelRows,
      candidateFindingsNeedingExternalManifestAttestation: candidateRequirements.external_manifest_attestation_required || 0,
    },
    candidatePromotion: candidate ? {
      includedFindings: candidate.includedFindings,
      claimPreflightRequiredIncludedFindings: candidate.claimPreflightRequiredIncludedFindings,
      findingsNeedingReviewedManifest: (candidateRequirements.reviewed_manifest_required || 0) + (candidateRequirements.manifest_review_required || 0),
      findingsNeedingBlindLabels: candidateRequirements.blind_label_required || 0,
      findingsNeedingExternalIndependentLabels: candidateFindingsNeedingExternalIndependentLabels,
      findingsNeedingExternalManifestAttestation: candidateRequirements.external_manifest_attestation_required || 0,
    } : null,
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
  if (report.currentReviewedClaim.selectedFindings !== null || report.currentReviewedClaim.missingLabels !== null) {
    lines.push(`- Selected findings: ${report.currentReviewedClaim.selectedFindings ?? "n/a"}`);
    lines.push(`- Missing labels: ${report.currentReviewedClaim.missingLabels ?? "n/a"}`);
  }
  lines.push("");
  lines.push(`## Rule Gaps`);
  lines.push("");
  lines.push(`| Rule | Selected | Required | Sample deficit | Unlabeled | Successes | Trials | Failures | Lower bound | Additional zero-failure trials |`);
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const gap of report.ruleGaps) {
    lines.push(`| \`${gap.ruleId}\` | ${gap.selectedFindings ?? "n/a"} | ${gap.requiredZeroFalsePositiveFindings ?? "n/a"} | ${gap.sampleDeficitBeforeLabeling ?? "n/a"} | ${gap.unlabeled ?? "n/a"} | ${gap.successes} | ${gap.trials} | ${gap.failures} | ${percent(gap.oneSidedLowerBound)} | ${gap.additionalZeroFailureTrialsForLowerBound ?? ">" + 1_000_000} |`);
  }
  lines.push("");
  lines.push(`## Repository Balance`);
  lines.push("");
  if (report.repositoryDilution.repositoriesOverCap.length === 0) {
    lines.push("No repository exceeds the configured contribution cap.");
  } else {
    lines.push(`| Repository | ${repositoryCountLabel(report.repositoryDilution.countKind)} | Contribution | ${repositoryAdditionalLabel(report.repositoryDilution.countKind)} |`);
    lines.push(`| --- | ---: | ---: | ---: |`);
    for (const repository of report.repositoryDilution.repositoriesOverCap) {
      lines.push(`| ${repository.repository} | ${repositoryCountFor(repository, report.repositoryDilution.countKind)} | ${percent(repository.contribution)} | ${repository.additionalOutsideRepositoryForCap} |`);
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
    lines.push(`- Findings requiring claim preflight: ${report.candidatePool.claimPreflightRequiredIncludedFindings}`);
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
  lines.push(`## Work Plan`);
  lines.push("");
  lines.push(`- Status: \`${report.workPlan.status}\``);
  lines.push(`- Minimum outside findings for repository balance: ${report.workPlan.repositoryBalance.minimumAdditionalOutsideFindings}`);
  lines.push(`- Minimum external independent label rows still needed: ${report.workPlan.externalEvidence.minimumExternalIndependentLabelRows}`);
  lines.push("");
  lines.push(`| Rule | Status | Need selected | Need labels | Need zero-failure trials |`);
  lines.push(`| --- | --- | ---: | ---: | ---: |`);
  for (const rule of report.workPlan.ruleCoverage) {
    lines.push(`| \`${rule.ruleId}\` | \`${rule.status}\` | ${rule.additionalSelectedFindingsNeededBeforeLabeling} | ${rule.existingSelectedFindingsNeedingLabels} | ${rule.minimumAdditionalZeroFailureFindings ?? ">" + 1_000_000} |`);
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
