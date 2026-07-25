#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const defaultMinimumPrecision = 0.99;
const defaultConfidence = 0.95;
const defaultMaxRepositoryContribution = 0.1;
const defaultIncludedRules = [
  "CELLFENCE_PRIVATE_IMPORT",
  "CELLFENCE_UNDECLARED_CONSUMER",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
  "CELLFENCE_UNRESOLVED_IMPORT",
  "CELLFENCE_UNDECLARED_RESOURCE_ACCESS",
  "CELLFENCE_UNRESOLVED_RESOURCE_ACCESS",
  "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
];

function usage() {
  console.error(`Usage:
  node scripts/precision-corpus-expansion-plan.mjs --current-bundle reports/corpus/current-cycle/bundle-unlabeled --candidate-corpus docs/research/corpora/oss-ts-js-200.json --candidate-bundle reports/corpus/oss-ts-js-200-bundle [--out report.json] [--markdown report.md]

Ranks diagnostic candidate subjects for the next reviewed precision corpus. The
candidate bundle may be infer-generated; this script does not mark candidates as
reviewed, does not create labels, and does not make infer findings claim-ready.`);
}

function parseArgs(argv) {
  const parsed = {
    currentBundleDir: "",
    currentCorpusPath: "",
    candidateCorpusPath: "",
    candidateBundleDir: "",
    includeRules: [],
    top: 25,
    minAddedSampled: null,
    minimumPrecision: defaultMinimumPrecision,
    confidence: defaultConfidence,
    maxRepositoryContribution: defaultMaxRepositoryContribution,
    outPath: "",
    markdownPath: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--current-bundle") {
      parsed.currentBundleDir = path.resolve(requireValue(argv, index, "--current-bundle"));
      index += 1;
    } else if (argument.startsWith("--current-bundle=")) {
      parsed.currentBundleDir = path.resolve(requireInlineValue(argument, "--current-bundle=", "--current-bundle"));
    } else if (argument === "--current-corpus") {
      parsed.currentCorpusPath = path.resolve(requireValue(argv, index, "--current-corpus"));
      index += 1;
    } else if (argument.startsWith("--current-corpus=")) {
      parsed.currentCorpusPath = path.resolve(requireInlineValue(argument, "--current-corpus=", "--current-corpus"));
    } else if (argument === "--candidate-corpus") {
      parsed.candidateCorpusPath = path.resolve(requireValue(argv, index, "--candidate-corpus"));
      index += 1;
    } else if (argument.startsWith("--candidate-corpus=")) {
      parsed.candidateCorpusPath = path.resolve(requireInlineValue(argument, "--candidate-corpus=", "--candidate-corpus"));
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
    } else if (argument === "--top") {
      parsed.top = parsePositiveInteger(requireValue(argv, index, "--top"), "--top");
      index += 1;
    } else if (argument.startsWith("--top=")) {
      parsed.top = parsePositiveInteger(requireInlineValue(argument, "--top=", "--top"), "--top");
    } else if (argument === "--min-added-sampled") {
      parsed.minAddedSampled = parsePositiveInteger(requireValue(argv, index, "--min-added-sampled"), "--min-added-sampled");
      index += 1;
    } else if (argument.startsWith("--min-added-sampled=")) {
      parsed.minAddedSampled = parsePositiveInteger(requireInlineValue(argument, "--min-added-sampled=", "--min-added-sampled"), "--min-added-sampled");
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
    } else if (argument === "--max-repository-contribution") {
      parsed.maxRepositoryContribution = parseUnitInterval(requireValue(argv, index, "--max-repository-contribution"), "--max-repository-contribution");
      index += 1;
    } else if (argument.startsWith("--max-repository-contribution=")) {
      parsed.maxRepositoryContribution = parseUnitInterval(requireInlineValue(argument, "--max-repository-contribution=", "--max-repository-contribution"), "--max-repository-contribution");
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
  if (!parsed.currentBundleDir) throw new Error("--current-bundle is required");
  if (!parsed.candidateCorpusPath) throw new Error("--candidate-corpus is required");
  if (!parsed.candidateBundleDir) throw new Error("--candidate-bundle is required");
  if (parsed.includeRules.length === 0) parsed.includeRules = defaultIncludedRules;
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

function parseUnitInterval(value, optionName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) throw new Error(`${optionName} must be greater than 0 and less than 1`);
  return parsed;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonl(filePath) {
  const text = fs.readFileSync(filePath, "utf8").trim();
  return text ? text.split(/\r?\n/).map((line) => JSON.parse(line)) : [];
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

function requiredZeroFalsePositiveSampleSize(minimumPrecision, confidence) {
  return Math.ceil(Math.log(1 - confidence) / Math.log(minimumPrecision));
}

function includedFinding(finding, rules) {
  return rules.has(finding.ruleId) && (finding.severity || "error") === "error";
}

function normalizedRepositoryKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

function selectedCurrentFindings(bundleDir, rules) {
  const findings = readJsonl(path.join(bundleDir, "findings.normalized.jsonl"));
  const sampling = readJson(path.join(bundleDir, "sampling.json"));
  const sampledIds = new Set(sampling.sampledFindingIds || findings.map((finding) => finding.findingId));
  return findings.filter((finding) => {
    return sampledIds.has(finding.findingId)
      && finding.precisionEligible === true
      && includedFinding(finding, rules);
  });
}

function summarizeByRule(findings) {
  const byRule = {};
  for (const finding of findings) increment(byRule, finding.ruleId);
  return Object.fromEntries(Object.entries(byRule).sort());
}

function summarizeByRepository(findings) {
  const byRepository = {};
  for (const finding of findings) increment(byRepository, finding.repository || finding.subjectId || "unknown");
  return Object.entries(byRepository)
    .map(([repository, selectedFindings]) => ({ repository, selectedFindings }))
    .sort((left, right) => (right.selectedFindings - left.selectedFindings) || left.repository.localeCompare(right.repository));
}

function readCandidateSubjects(candidateCorpusPath) {
  const corpus = readJson(candidateCorpusPath);
  const subjects = new Map();
  for (const subject of corpus.subjects || []) subjects.set(subject.id, subject);
  return subjects;
}

function readManifestCopies(candidateBundleDir) {
  const study = readJson(path.join(candidateBundleDir, "study.json"));
  const copies = new Map();
  for (const copy of study.manifestCopies || []) copies.set(copy.subjectId, copy);
  return copies;
}

function currentCorpusIdentity(currentCorpusPath) {
  const subjectIds = new Set();
  const repositories = new Set();
  if (!currentCorpusPath) return { subjectIds, repositories };
  const corpus = readJson(currentCorpusPath);
  for (const subject of corpus.subjects || []) {
    if (subject.id) subjectIds.add(subject.id);
    const repositoryKey = normalizedRepositoryKey(subject.repository);
    if (repositoryKey) repositories.add(repositoryKey);
  }
  return { subjectIds, repositories };
}

function resolvedCurrentCorpusPath(options) {
  if (options.currentCorpusPath) return { path: options.currentCorpusPath, source: "explicit" };
  const bundledCorpusPath = path.join(options.currentBundleDir, "corpus.json");
  if (fs.existsSync(bundledCorpusPath)) return { path: bundledCorpusPath, source: "current-bundle" };
  return { path: "", source: "none" };
}

function candidateRows(options, currentRepositories, currentSubjectIds, rules, deficits) {
  const candidateFindings = readJsonl(path.join(options.candidateBundleDir, "findings.normalized.jsonl"));
  const candidateSampling = readJson(path.join(options.candidateBundleDir, "sampling.json"));
  const candidateSampledIds = new Set(candidateSampling.sampledFindingIds || []);
  const candidateSubjects = readCandidateSubjects(options.candidateCorpusPath);
  const manifestCopies = readManifestCopies(options.candidateBundleDir);
  const grouped = new Map();

  for (const finding of candidateFindings) {
    if (!includedFinding(finding, rules)) continue;
    if (!manifestCopies.has(finding.subjectId)) continue;
    if (currentSubjectIds.has(finding.subjectId)) continue;
    if (currentRepositories.has(normalizedRepositoryKey(finding.repository))) continue;
    const group = grouped.get(finding.subjectId) || [];
    group.push(finding);
    grouped.set(finding.subjectId, group);
  }

  const rows = [];
  for (const [subjectId, findings] of grouped.entries()) {
    const representative = findings[0] || {};
    const totalCountsByRule = summarizeByRule(findings);
    const sampledFindings = findings.filter((finding) => candidateSampledIds.has(finding.findingId));
    const sampledCountsByRule = summarizeByRule(sampledFindings);
    let sampledDeficitCoverageScore = 0;
    let rawDeficitCoverageScore = 0;
    let sampledRareRuleScore = 0;
    for (const [ruleId, count] of Object.entries(sampledCountsByRule)) {
      sampledDeficitCoverageScore += Math.min(deficits[ruleId] || 0, count);
      if ((deficits[ruleId] || 0) > 0) sampledRareRuleScore += count / Math.max(1, deficits[ruleId]);
    }
    for (const [ruleId, count] of Object.entries(totalCountsByRule)) {
      rawDeficitCoverageScore += Math.min(deficits[ruleId] || 0, count);
    }
    const subject = candidateSubjects.get(subjectId) || {};
    rows.push({
      subjectId,
      repository: representative.repository || subject.repository || null,
      commit: representative.commit || subject.commit || null,
      stars: subject.metadata?.stars ?? null,
      diskUsageKb: subject.metadata?.diskUsageKb ?? null,
      reviewWorkloadFindings: findings.length,
      diagnosticSampledFindings: sampledFindings.length,
      projectedSelectedFindings: sampledFindings.length,
      projectionReliability: "diagnostic_candidate_sampling_only_recompute_after_promotion",
      totalCountsByRule,
      sampledCountsByRule,
      manifestCopy: manifestCopies.get(subjectId)?.path || null,
      manifestStrategy: representative.manifestStrategy || subject.manifest?.strategy || "unknown",
      nextAction: "copy_manifest_then_agent_review_before_claim_use",
      riskNotes: riskNotesForCandidate(findings.length, totalCountsByRule, sampledFindings.length),
      sampledDeficitCoverageScore,
      rawDeficitCoverageScore,
      sampledRareRuleScore,
    });
  }

  rows.sort((left, right) => {
    return (right.sampledDeficitCoverageScore - left.sampledDeficitCoverageScore)
      || (right.sampledRareRuleScore - left.sampledRareRuleScore)
      || (right.projectedSelectedFindings - left.projectedSelectedFindings)
      || (right.rawDeficitCoverageScore - left.rawDeficitCoverageScore)
      || (right.reviewWorkloadFindings - left.reviewWorkloadFindings)
      || left.subjectId.localeCompare(right.subjectId);
  });
  return rows;
}

function riskNotesForCandidate(total, countsByRule, projectedSelectedFindings) {
  const notes = [];
  notes.push("diagnostic candidate sampling must be recomputed after promotion and repository-cap pruning");
  if (projectedSelectedFindings === 0) notes.push("no sampled findings in the diagnostic candidate bundle; rerun before expecting dilution progress");
  if (total > 1_000) notes.push("large finding volume; review sampling and repository concentration before promotion");
  if ((countsByRule.CELLFENCE_PRIVATE_IMPORT || 0) > 1_000) notes.push("private-import-heavy candidate may dominate raw findings");
  if ((countsByRule.CELLFENCE_PUBLIC_SYMBOL_MISMATCH || 0) === 0) notes.push("does not help public-symbol-mismatch evidence");
  return notes;
}

function greedyResidual(topCandidates, deficits) {
  const residual = { ...deficits };
  const selected = [];
  for (const candidate of topCandidates) {
    const before = Object.values(residual).reduce((sum, value) => sum + value, 0);
    for (const [ruleId, count] of Object.entries(candidate.sampledCountsByRule)) {
      residual[ruleId] = Math.max(0, (residual[ruleId] || 0) - count);
    }
    const after = Object.values(residual).reduce((sum, value) => sum + value, 0);
    if (after < before) selected.push(candidate.subjectId);
  }
  return { selectedSubjects: selected, residualDeficits: Object.fromEntries(Object.entries(residual).sort()) };
}

function greedyDilutionTranche(candidates, minAddedSampled) {
  const selectedSubjects = [];
  let projectedAddedSampledFindings = 0;
  if (minAddedSampled <= 0) {
    return {
      minAddedSampled,
      projectedAddedSampledFindings,
      selectedSubjects,
    };
  }
  for (const candidate of candidates) {
    if (candidate.projectedSelectedFindings <= 0) continue;
    selectedSubjects.push(candidate.subjectId);
    projectedAddedSampledFindings += candidate.projectedSelectedFindings;
    if (projectedAddedSampledFindings >= minAddedSampled) break;
  }
  return {
    minAddedSampled,
    projectedAddedSampledFindings,
    selectedSubjects,
  };
}

function buildReport(options) {
  const rules = new Set(options.includeRules);
  const requiredPerRule = requiredZeroFalsePositiveSampleSize(options.minimumPrecision, options.confidence);
  const currentFindings = selectedCurrentFindings(options.currentBundleDir, rules);
  const currentByRule = summarizeByRule(currentFindings);
  const deficits = {};
  for (const ruleId of options.includeRules) deficits[ruleId] = Math.max(0, requiredPerRule - (currentByRule[ruleId] || 0));
  const currentRepositories = new Set(currentFindings.map((finding) => normalizedRepositoryKey(finding.repository)).filter(Boolean));
  const currentSubjectIds = new Set(currentFindings.map((finding) => finding.subjectId).filter(Boolean));
  const currentCorpusInput = resolvedCurrentCorpusPath(options);
  const currentCorpus = currentCorpusIdentity(currentCorpusInput.path);
  for (const subjectId of currentCorpus.subjectIds) currentSubjectIds.add(subjectId);
  for (const repository of currentCorpus.repositories) currentRepositories.add(repository);
  const repositoryRows = summarizeByRepository(currentFindings);
  const maxRepository = repositoryRows[0] || null;
  const additionalOtherFindingsForRepositoryCap = maxRepository && currentFindings.length > 0
    ? Math.max(0, Math.ceil(maxRepository.selectedFindings / options.maxRepositoryContribution) - currentFindings.length)
    : 0;
  const candidates = candidateRows(options, currentRepositories, currentSubjectIds, rules, deficits);
  const topCandidates = candidates.slice(0, options.top);
  const residual = greedyResidual(topCandidates, deficits);
  const candidateSampledCoverageByRule = {};
  const candidateRawCoverageByRule = {};
  for (const candidate of candidates) {
    for (const [ruleId, count] of Object.entries(candidate.sampledCountsByRule)) increment(candidateSampledCoverageByRule, ruleId, count);
    for (const [ruleId, count] of Object.entries(candidate.totalCountsByRule)) increment(candidateRawCoverageByRule, ruleId, count);
  }
  const minAddedSampled = options.minAddedSampled || additionalOtherFindingsForRepositoryCap;
  const dilutionTranche = greedyDilutionTranche(candidates, minAddedSampled);
  const blockers = [
    "candidate manifests are diagnostic/infer-derived until copied into docs and reviewed; this script does not create reviewed evidence",
    "external human/organization labels and external manifest attestations remain required for a public 99% claim",
  ];
  for (const [ruleId, deficit] of Object.entries(deficits)) {
    if (deficit > 0 && (candidateSampledCoverageByRule[ruleId] || 0) === 0) {
      blockers.push(`${ruleId} has a ${deficit} sampled-finding deficit and no sampled candidate findings in the candidate bundle`);
    }
  }
  if (additionalOtherFindingsForRepositoryCap > 0) {
    blockers.push(`${maxRepository.repository} still exceeds the repository cap in the current bundle; add at least ${additionalOtherFindingsForRepositoryCap} selected findings from other repositories or reduce its sampled findings`);
  }
  return {
    schemaVersion: "cellfence.precision-corpus-expansion-plan.v1",
    generatedAt: new Date().toISOString(),
    inputs: {
      currentBundle: posixify(options.currentBundleDir),
      currentCorpus: currentCorpusInput.path ? posixify(currentCorpusInput.path) : null,
      currentCorpusSource: currentCorpusInput.source,
      candidateCorpus: posixify(options.candidateCorpusPath),
      candidateBundle: posixify(options.candidateBundleDir),
    },
    claimTarget: {
      minimumPrecision: options.minimumPrecision,
      confidence: options.confidence,
      requiredZeroFalsePositiveFindingsPerRule: requiredPerRule,
      maxRepositoryContribution: options.maxRepositoryContribution,
      includedRules: options.includeRules,
    },
    current: {
      sampledPrecisionEligibleFindings: currentFindings.length,
      byRule: currentByRule,
      deficits: Object.fromEntries(Object.entries(deficits).sort()),
      topRepositories: repositoryRows.slice(0, 10),
      maxRepositoryContribution: maxRepository && currentFindings.length > 0 ? maxRepository.selectedFindings / currentFindings.length : null,
      additionalOtherFindingsForRepositoryCap,
    },
    candidatePool: {
      subjects: candidates.length,
      sampledCandidateFindingsByRule: Object.fromEntries(Object.entries(candidateSampledCoverageByRule).sort()),
      rawCandidateFindingsByRule: Object.fromEntries(Object.entries(candidateRawCoverageByRule).sort()),
      topCandidates,
      topCandidateResidual: residual,
      dilutionTranche,
    },
    blockers,
    nextActions: [
      "Copy selected candidate manifest files from the diagnostic bundle into docs/research/corpora/manifests/ and review them before marking a new corpus as reviewed.",
      "Freeze a new reviewed corpus JSON before running checks; do not cherry-pick subjects after seeing new labels.",
      "Rerun corpus evidence bundling and repository-cap sampling after promotion; diagnostic sampled counts are not claim-ready projections.",
      "Run research:corpus, precision:next-cycle, and claim preflight on the new reviewed corpus.",
      "Collect external human/organization labels and manifest attestations outside Codex before any public 99% claim.",
    ],
  };
}

function percent(value) {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function renderMarkdown(report) {
  const lines = [
    "# Precision Corpus Expansion Plan",
    "",
    `Generated: \`${report.generatedAt}\``,
    "",
    "## Current Bundle",
    "",
    `- Sampled precision-eligible findings: ${report.current.sampledPrecisionEligibleFindings}`,
    `- Required zero-false-positive findings per rule: ${report.claimTarget.requiredZeroFalsePositiveFindingsPerRule}`,
    `- Max repository contribution: ${percent(report.current.maxRepositoryContribution)} (limit ${percent(report.claimTarget.maxRepositoryContribution)})`,
    "",
    "| Rule | Current | Deficit | Sampled candidate pool | Raw candidate pool |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const ruleId of report.claimTarget.includedRules) {
    lines.push(`| \`${ruleId}\` | ${report.current.byRule[ruleId] || 0} | ${report.current.deficits[ruleId] || 0} | ${report.candidatePool.sampledCandidateFindingsByRule[ruleId] || 0} | ${report.candidatePool.rawCandidateFindingsByRule[ruleId] || 0} |`);
  }
  lines.push("", "## Top Candidate Subjects", "");
  lines.push("| Subject | Review workload | Diagnostic sampled | Sampled score | Sampled rules | Next action |");
  lines.push("| --- | ---: | ---: | ---: | --- | --- |");
  for (const candidate of report.candidatePool.topCandidates) {
    lines.push(`| \`${candidate.subjectId}\` | ${candidate.reviewWorkloadFindings} | ${candidate.diagnosticSampledFindings} | ${candidate.sampledDeficitCoverageScore} | \`${JSON.stringify(candidate.sampledCountsByRule)}\` | ${candidate.nextAction} |`);
  }
  lines.push("", "## Dilution Tranche", "");
  lines.push(`Target added sampled findings: ${report.candidatePool.dilutionTranche.minAddedSampled}`);
  lines.push(`Projected added sampled findings: ${report.candidatePool.dilutionTranche.projectedAddedSampledFindings}`);
  lines.push(`Selected subjects: \`${JSON.stringify(report.candidatePool.dilutionTranche.selectedSubjects)}\``);
  lines.push("", "## Residual After Top Candidates", "");
  lines.push(`Selected by greedy residual model: \`${JSON.stringify(report.candidatePool.topCandidateResidual.selectedSubjects)}\``);
  lines.push("");
  lines.push("| Rule | Residual deficit |");
  lines.push("| --- | ---: |");
  for (const [ruleId, deficit] of Object.entries(report.candidatePool.topCandidateResidual.residualDeficits)) {
    lines.push(`| \`${ruleId}\` | ${deficit} |`);
  }
  lines.push("", "## Blockers", "");
  for (const blocker of report.blockers) lines.push(`- ${blocker}`);
  lines.push("", "## Next Actions", "");
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
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = main();
