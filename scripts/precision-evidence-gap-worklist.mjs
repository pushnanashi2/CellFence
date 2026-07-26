#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const schemaVersion = "cellfence.precision-evidence-gap-worklist.v1";
const defaultMaxExamples = 20;

function usage() {
  console.error(`Usage:
  node scripts/precision-evidence-gap-worklist.mjs --preflight claim-preflight.json [--bundle evidence-bundle-dir] [--next-cycle summary.json] [--expansion-plan plan.json ...] [--out gaps.json] [--markdown gaps.md]

Turns a precision claim preflight and optional expansion plans into an explicit
remaining-evidence worklist. It never creates labels, external attestations, or
claim-ready evidence; it only preserves the blockers that must be resolved.`);
}

function parseArgs(argv) {
  const parsed = {
    preflightPath: "",
    bundleDir: "",
    nextCyclePath: "",
    expansionPlanPaths: [],
    outPath: "",
    markdownPath: "",
    maxExamples: defaultMaxExamples,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--preflight") {
      parsed.preflightPath = path.resolve(requireValue(argv, index, "--preflight"));
      index += 1;
    } else if (argument.startsWith("--preflight=")) {
      parsed.preflightPath = path.resolve(requireInlineValue(argument, "--preflight=", "--preflight"));
    } else if (argument === "--bundle") {
      parsed.bundleDir = path.resolve(requireValue(argv, index, "--bundle"));
      index += 1;
    } else if (argument.startsWith("--bundle=")) {
      parsed.bundleDir = path.resolve(requireInlineValue(argument, "--bundle=", "--bundle"));
    } else if (argument === "--next-cycle") {
      parsed.nextCyclePath = path.resolve(requireValue(argv, index, "--next-cycle"));
      index += 1;
    } else if (argument.startsWith("--next-cycle=")) {
      parsed.nextCyclePath = path.resolve(requireInlineValue(argument, "--next-cycle=", "--next-cycle"));
    } else if (argument === "--expansion-plan") {
      parsed.expansionPlanPaths.push(path.resolve(requireValue(argv, index, "--expansion-plan")));
      index += 1;
    } else if (argument.startsWith("--expansion-plan=")) {
      parsed.expansionPlanPaths.push(path.resolve(requireInlineValue(argument, "--expansion-plan=", "--expansion-plan")));
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
    } else if (argument === "--max-examples") {
      parsed.maxExamples = parsePositiveInteger(requireValue(argv, index, "--max-examples"), "--max-examples");
      index += 1;
    } else if (argument.startsWith("--max-examples=")) {
      parsed.maxExamples = parsePositiveInteger(requireInlineValue(argument, "--max-examples=", "--max-examples"), "--max-examples");
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.preflightPath) throw new Error("--preflight is required");
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

function parsePositiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${optionName} must be a positive integer`);
  return parsed;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

function optionalJson(filePath) {
  return filePath ? readJson(filePath) : null;
}

function bundleContext(bundleDir) {
  if (!bundleDir) return null;
  const study = readJson(path.join(bundleDir, "study.json"));
  const corpus = readJson(path.join(bundleDir, "corpus.json"));
  return {
    bundleDir,
    study,
    corpus,
    subjects: new Map((corpus.subjects || []).map((subject) => [subject.id, subject])),
    manifestCopies: new Map((study.manifestCopies || []).map((copy) => [copy.phase ? `${copy.subjectId}\0${copy.phase}` : copy.subjectId, copy])),
  };
}

function claimProtocol(preflight) {
  const protocol = preflight.protocol || {};
  return {
    studyId: preflight.studyId || protocol.studyId || null,
    minimumPrecision: protocol.minimumPrecision ?? null,
    confidence: protocol.confidence ?? null,
    includedRules: Array.isArray(protocol.includedRules) ? protocol.includedRules : Object.keys(preflight.selectedByRule || {}),
    blockingSeverities: Array.isArray(protocol.blockingSeverities) ? protocol.blockingSeverities : ["error"],
    maxRepositoryContribution: protocol.maxRepositoryContribution ?? preflight.repositoryContribution?.limit ?? null,
    requireExternalIndependentLabels: protocol.requireExternalIndependentLabels ?? true,
    requireExternalManifestReview: protocol.requireExternalManifestReview ?? true,
  };
}

function externalManifestAttestationGaps(preflight) {
  const subjects = new Map();
  const messages = [
    ...(Array.isArray(preflight.issues) ? preflight.issues : []),
    ...(Array.isArray(preflight.gateFailures) ? preflight.gateFailures : []),
  ];
  for (const message of messages) {
    const match = /^(.*) external manifest review requires (.+)$/.exec(message);
    if (!match) continue;
    const subjectId = match[1];
    const requirement = match[2];
    let field = "";
    if (requirement === "manifest.strategy=copy") field = "manifest.strategy";
    else if (requirement === "reviewStatus=reviewed") field = "reviewStatus";
    else if (requirement === "a sealed manifest copy") field = "sealedManifestCopy";
    else {
      const reviewMatch = /^review\.([a-zA-Z0-9_.-]+)$/.exec(requirement);
      if (reviewMatch) field = `review.${reviewMatch[1]}`;
    }
    if (!field) continue;
    const existing = subjects.get(subjectId) || new Set();
    existing.add(field);
    subjects.set(subjectId, existing);
  }
  return [...subjects.entries()]
    .map(([subjectId, missingFields]) => ({ subjectId, missingFields: [...missingFields].sort() }))
    .sort((left, right) => left.subjectId.localeCompare(right.subjectId));
}

function subjectManifest(subject, corpus) {
  if (corpus?.schemaVersion === "cellfence.history-replay.v1") return subject?.before?.manifest || {};
  return subject?.manifest || {};
}

function subjectCommit(subject, corpus) {
  if (corpus?.schemaVersion === "cellfence.history-replay.v1") return subject?.before?.commit || subject?.beforeCommit || null;
  return subject?.commit || null;
}

function manifestCopyFor(context, subjectId) {
  if (!context) return null;
  return context.manifestCopies.get(subjectId) || context.manifestCopies.get(`${subjectId}\0before`) || null;
}

function enrichManifestGaps(manifestGaps, context) {
  if (!context) return manifestGaps;
  return manifestGaps.map((gap) => {
    const subject = context.subjects.get(gap.subjectId) || {};
    const manifest = subjectManifest(subject, context.corpus);
    const copy = manifestCopyFor(context, gap.subjectId);
    const copyPath = copy?.path || null;
    const copySha256 = copy?.sha256 || copy?.actualSha256 || null;
    return {
      ...gap,
      repository: subject.repository || null,
      commit: subjectCommit(subject, context.corpus),
      manifestStrategy: manifest.strategy || "existing",
      manifestSource: manifest.source || null,
      manifestReviewStatus: manifest.reviewStatus || (manifest.reviewed === true ? "reviewed" : "unreviewed"),
      manifestCopy: copy ? {
        path: copyPath,
        sha256: copySha256,
      } : null,
      attestationTemplate: copySha256 ? {
        reviewStatus: "reviewed",
        review: {
          reviewedAt: "YYYY-MM-DD",
          scope: "package/workspace boundary manifest review",
          reviewedManifestSha256: copySha256,
          reviewerAttestations: [
            {
              id: "external-reviewer-id",
              reviewerType: "human",
              independent: true,
            },
          ],
        },
      } : null,
    };
  });
}

function preflightWorklists(preflight) {
  if (Array.isArray(preflight.worklist?.paths)) return preflight.worklist.paths.map(posixify);
  if (typeof preflight.worklist?.path === "string") return [posixify(preflight.worklist.path)];
  return [];
}

function exampleExternalLabelFindings(preflight, maxExamples) {
  const findings = preflight.externalRaterCoverage?.findings || [];
  return findings
    .filter((finding) => finding.ok === false)
    .slice(0, maxExamples)
    .map((finding) => ({
      findingId: finding.findingId,
      subjectId: finding.subjectId,
      ruleId: finding.ruleId,
      externalIndependentRaters: finding.externalIndependentRaters ?? 0,
      requiredExternalIndependentRaters: finding.requiredExternalIndependentRaters ?? preflight.externalRaterCoverage?.required ?? 1,
    }));
}

function expansionCoverage(expansionPlans) {
  const sampled = {};
  const raw = {};
  const residuals = {};
  const candidateSubjects = new Set();
  for (const plan of expansionPlans) {
    for (const [ruleId, count] of Object.entries(plan.candidatePool?.sampledCandidateFindingsByRule || {})) {
      sampled[ruleId] = (sampled[ruleId] || 0) + count;
    }
    for (const [ruleId, count] of Object.entries(plan.candidatePool?.rawCandidateFindingsByRule || {})) {
      raw[ruleId] = (raw[ruleId] || 0) + count;
    }
    for (const [ruleId, count] of Object.entries(plan.candidatePool?.topCandidateResidual?.residualDeficits || {})) {
      residuals[ruleId] = Math.max(residuals[ruleId] || 0, count);
    }
    for (const candidate of plan.candidatePool?.topCandidates || []) {
      if (candidate.subjectId) candidateSubjects.add(candidate.subjectId);
    }
  }
  return { sampled, raw, residuals, candidateSubjects: [...candidateSubjects].sort() };
}

function selectedRuleRows(preflight, protocol) {
  const selectedByRule = preflight.selectedByRule || {};
  return protocol.includedRules.map((ruleId) => {
    const metric = selectedByRule[ruleId] || {};
    const required = metric.requiredZeroFalsePositiveFindings ?? null;
    const selected = metric.selectedFindings || 0;
    return {
      ruleId,
      selectedFindings: selected,
      requiredZeroFalsePositiveFindings: required,
      sampleDeficitBeforeLabeling: metric.sampleDeficitBeforeLabeling ?? (required === null ? null : Math.max(0, required - selected)),
      unlabeled: metric.counts?.unlabeled || 0,
      successes: metric.successes || 0,
      trials: metric.trials || 0,
      oneSidedLowerBound: metric.oneSidedLowerBound ?? null,
      additionalTruePositiveTrialsNeeded: metric.additionalTruePositiveTrialsNeeded ?? null,
    };
  });
}

function task(type, phaseOrder, summary, details) {
  return {
    type,
    phaseOrder,
    blocking: true,
    summary,
    ...details,
  };
}

function buildReport(options) {
  const preflight = readJson(options.preflightPath);
  const context = bundleContext(options.bundleDir);
  const nextCycle = optionalJson(options.nextCyclePath);
  const expansionPlans = options.expansionPlanPaths.map(readJson);
  const protocol = claimProtocol(preflight);
  const ruleRows = selectedRuleRows(preflight, protocol);
  const coverage = expansionCoverage(expansionPlans);
  const sealedWorklists = preflightWorklists(preflight);
  const blindWorklist = nextCycle?.artifacts?.blindWorklist || sealedWorklists[0] || null;
  const tasks = [];

  const manifestGaps = enrichManifestGaps(externalManifestAttestationGaps(preflight), context);
  if (manifestGaps.length > 0) {
    tasks.push(task(
      "external_manifest_attestation",
      10,
      `${manifestGaps.length} copied manifests need external review attestations`,
      {
        subjects: manifestGaps,
        requiredFields: [...new Set(manifestGaps.flatMap((gap) => gap.missingFields))].sort(),
        action: "collect non-agent reviewer attestations bound to review.reviewedManifestSha256 before external claim use",
      },
    ));
  }

  if ((preflight.summary?.missingLabels || 0) > 0) {
    tasks.push(task(
      "manual_label",
      20,
      `${preflight.summary.missingLabels} selected findings need independent manual labels`,
      {
        missingLabels: preflight.summary.missingLabels,
        selectedFindings: preflight.summary.selectedFindings,
        worklist: blindWorklist,
        worklists: sealedWorklists,
        action: "complete first-pass labels without seeing peer labels or outcome metrics",
      },
    ));
  }

  const externalMissing = preflight.externalRaterCoverage?.findingsMissingExternalIndependentLabels || 0;
  if (externalMissing > 0) {
    tasks.push(task(
      "external_independent_label",
      30,
      `${externalMissing} selected findings need external human/organization labels`,
      {
        missingExternalIndependentLabels: externalMissing,
        requiredExternalIndependentRaters: preflight.externalRaterCoverage?.required ?? 1,
        acceptedExternalRaterTypes: preflight.externalRaterCoverage?.externalRaterTypes || [],
        examples: exampleExternalLabelFindings(preflight, options.maxExamples),
        action: "collect labels from non-agent human or organization reviewers; Codex labels do not satisfy this task",
      },
    ));
  }

  const repositoryContribution = preflight.repositoryContribution || {};
  const overLimitRepositories = (repositoryContribution.repositories || []).filter((repository) => repository.overLimit);
  if (overLimitRepositories.length > 0 || repositoryContribution.feasibleWithCurrentRepositoryCount === false) {
    tasks.push(task(
      "repository_balance",
      40,
      "selected findings do not satisfy the repository contribution cap",
      {
        maxRepositoryContribution: repositoryContribution.maxRepositoryContribution ?? null,
        limit: repositoryContribution.limit ?? protocol.maxRepositoryContribution,
        overLimitRepositories,
        action: "add selected findings from other repositories or reduce deterministic sampled findings from overrepresented repositories",
      },
    ));
  }

  for (const row of ruleRows) {
    if ((row.sampleDeficitBeforeLabeling || 0) <= 0) continue;
    const sampledCandidateFindings = coverage.sampled[row.ruleId] || 0;
    const rawCandidateFindings = coverage.raw[row.ruleId] || 0;
    const remainingAfterKnownPlans = Math.max(0, row.sampleDeficitBeforeLabeling - sampledCandidateFindings);
    tasks.push(task(
      "rule_sample_deficit",
      50,
      `${row.ruleId} needs ${row.sampleDeficitBeforeLabeling} more selected zero-false-positive findings before labeling can prove the requested bound`,
      {
        ruleId: row.ruleId,
        selectedFindings: row.selectedFindings,
        requiredZeroFalsePositiveFindings: row.requiredZeroFalsePositiveFindings,
        sampleDeficitBeforeLabeling: row.sampleDeficitBeforeLabeling,
        sampledCandidateFindings,
        rawCandidateFindings,
        remainingAfterKnownExpansionPlans: remainingAfterKnownPlans,
        action: sampledCandidateFindings > 0
          ? "promote candidate subjects only after manifest copy review and corpus freeze"
          : "pre-register a rule-specific reviewed holdout or mutation/conformance source; current candidate plans do not power this rule",
      },
    ));
  }

  tasks.sort((left, right) => (left.phaseOrder - right.phaseOrder) || left.type.localeCompare(right.type) || String(left.ruleId || "").localeCompare(String(right.ruleId || "")));
  return {
    schemaVersion,
    generatedAt: new Date().toISOString(),
    inputs: {
      preflight: posixify(options.preflightPath),
      bundle: options.bundleDir ? posixify(options.bundleDir) : null,
      nextCycle: options.nextCyclePath ? posixify(options.nextCyclePath) : null,
      expansionPlans: options.expansionPlanPaths.map(posixify),
    },
    claimStatus: {
      preflightClaimReady: preflight.claimReady === true,
      claimAllowedByThisWorklist: tasks.length === 0 && preflight.claimReady === true,
      taskCount: tasks.length,
      gateFailures: preflight.gateFailures || [],
    },
    protocol,
    totals: {
      selectedFindings: preflight.summary?.selectedFindings ?? null,
      missingLabels: preflight.summary?.missingLabels ?? null,
      missingExternalIndependentLabels: externalMissing,
      externalManifestAttestationSubjects: manifestGaps.length,
      repositoryMaxContribution: repositoryContribution.maxRepositoryContribution ?? null,
    },
    ruleEvidence: ruleRows,
    expansionCoverage: {
      sampledCandidateFindingsByRule: Object.fromEntries(Object.entries(coverage.sampled).sort()),
      rawCandidateFindingsByRule: Object.fromEntries(Object.entries(coverage.raw).sort()),
      candidateSubjects: coverage.candidateSubjects,
    },
    tasks,
    invariants: [
      "This worklist does not create or infer labels.",
      "External human/organization labels cannot be satisfied by Codex or another agent.",
      "Diagnostic or infer-derived candidate manifests remain non-claim-ready until copied, reviewed, and frozen in a reviewed corpus.",
      "Rule-specific synthetic evidence can validate mechanism behavior, but it is not public-OSS precision evidence unless the protocol says so before inspection.",
    ],
  };
}

function renderMarkdown(report) {
  const lines = [
    "# Precision Evidence Gap Worklist",
    "",
    `Generated: \`${report.generatedAt}\``,
    "",
    `Claim ready: \`${report.claimStatus.claimAllowedByThisWorklist}\``,
    `Tasks: ${report.claimStatus.taskCount}`,
    "",
    "## Totals",
    "",
    `- Selected findings: ${report.totals.selectedFindings ?? "n/a"}`,
    `- Missing labels: ${report.totals.missingLabels ?? "n/a"}`,
    `- Missing external labels: ${report.totals.missingExternalIndependentLabels}`,
    `- Manifests lacking external attestation: ${report.totals.externalManifestAttestationSubjects}`,
    `- Max repository contribution: ${report.totals.repositoryMaxContribution === null ? "n/a" : `${(report.totals.repositoryMaxContribution * 100).toFixed(2)}%`}`,
    "",
    "## Rule Evidence",
    "",
    "| Rule | Selected | Required | Deficit | Sampled candidates | Raw candidates |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of report.ruleEvidence) {
    lines.push(`| \`${row.ruleId}\` | ${row.selectedFindings} | ${row.requiredZeroFalsePositiveFindings ?? "n/a"} | ${row.sampleDeficitBeforeLabeling ?? "n/a"} | ${report.expansionCoverage.sampledCandidateFindingsByRule[row.ruleId] || 0} | ${report.expansionCoverage.rawCandidateFindingsByRule[row.ruleId] || 0} |`);
  }
  lines.push("", "## Tasks", "");
  for (const currentTask of report.tasks) {
    lines.push(`- ${currentTask.phaseOrder}. \`${currentTask.type}\`: ${currentTask.summary}`);
  }
  lines.push("", "## Invariants", "");
  for (const invariant of report.invariants) lines.push(`- ${invariant}`);
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
    return report.claimStatus.claimAllowedByThisWorklist ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

process.exitCode = main();
