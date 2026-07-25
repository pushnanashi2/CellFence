#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const schemaVersion = "cellfence.precision-round-handoff.v1";

function usage() {
  console.error(`Usage:
  node scripts/precision-round-handoff.mjs --claim-report reports/corpus/round17-claim-report.json --from-round 18 --to-round 100 --out-json docs/research/round18-100.json --out-md docs/research/round18-100.md [--preflight reports/corpus/round17-claim-preflight.json]

Creates a reproducible per-round handoff ledger from a sealed precision claim
report. The runner does not synthesize labels, reviewed repositories, external
review, or claim progress; it only carries the remaining evidence deficits into
each requested round until new evidence is supplied.`);
}

function parseArgs(argv) {
  const parsed = {
    claimReportPath: "",
    preflightPath: "",
    fromRound: null,
    toRound: null,
    outJsonPath: "",
    outMarkdownPath: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--claim-report") {
      parsed.claimReportPath = path.resolve(requireValue(argv, index, "--claim-report"));
      index += 1;
    } else if (argument.startsWith("--claim-report=")) {
      parsed.claimReportPath = path.resolve(requireInlineValue(argument, "--claim-report=", "--claim-report"));
    } else if (argument === "--preflight") {
      parsed.preflightPath = path.resolve(requireValue(argv, index, "--preflight"));
      index += 1;
    } else if (argument.startsWith("--preflight=")) {
      parsed.preflightPath = path.resolve(requireInlineValue(argument, "--preflight=", "--preflight"));
    } else if (argument === "--from-round") {
      parsed.fromRound = parsePositiveInteger(requireValue(argv, index, "--from-round"), "--from-round");
      index += 1;
    } else if (argument.startsWith("--from-round=")) {
      parsed.fromRound = parsePositiveInteger(requireInlineValue(argument, "--from-round=", "--from-round"), "--from-round");
    } else if (argument === "--to-round") {
      parsed.toRound = parsePositiveInteger(requireValue(argv, index, "--to-round"), "--to-round");
      index += 1;
    } else if (argument.startsWith("--to-round=")) {
      parsed.toRound = parsePositiveInteger(requireInlineValue(argument, "--to-round=", "--to-round"), "--to-round");
    } else if (argument === "--out-json") {
      parsed.outJsonPath = path.resolve(requireValue(argv, index, "--out-json"));
      index += 1;
    } else if (argument.startsWith("--out-json=")) {
      parsed.outJsonPath = path.resolve(requireInlineValue(argument, "--out-json=", "--out-json"));
    } else if (argument === "--out-md") {
      parsed.outMarkdownPath = path.resolve(requireValue(argv, index, "--out-md"));
      index += 1;
    } else if (argument.startsWith("--out-md=")) {
      parsed.outMarkdownPath = path.resolve(requireInlineValue(argument, "--out-md=", "--out-md"));
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.claimReportPath) throw new Error("--claim-report is required");
  if (!parsed.fromRound) throw new Error("--from-round is required");
  if (!parsed.toRound) throw new Error("--to-round is required");
  if (parsed.toRound < parsed.fromRound) throw new Error("--to-round must be greater than or equal to --from-round");
  if (!parsed.outJsonPath && !parsed.outMarkdownPath) throw new Error("at least one of --out-json or --out-md is required");
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

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function portablePath(filePath) {
  const relativePath = path.relative(process.cwd(), filePath);
  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.split(path.sep).join("/");
  }
  return path.basename(filePath);
}

function percent(value, digits = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(digits)}%`;
}

function roundNumber(value, digits = 3) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function extractClaimSnapshot(claimReport, preflight) {
  const protocol = claimReport.protocol || {};
  const occurrence = claimReport.metrics?.occurrence || {};
  const blocking = occurrence.blocking || {};
  const semantic = occurrence.semanticCorrectness || {};
  const counts = occurrence.counts || {};
  const external = claimReport.labelQuality?.externalRaterCoverage || preflight?.externalRaterCoverage || {};
  const repositorySelection = claimReport.metrics?.repositorySelection || preflight?.repositoryContribution || {};
  const repositories = Array.isArray(repositorySelection.repositories) ? repositorySelection.repositories : [];
  const byRule = claimReport.metrics?.byRule || {};
  const selectedByRule = preflight?.selectedByRule || {};
  const ruleDeficits = Object.entries(byRule).map(([ruleId, metric]) => {
    const selected = selectedByRule[ruleId]?.selectedFindings;
    const trials = metric.blocking?.trials ?? 0;
    const lowerBound = metric.blocking?.oneSidedLowerBound ?? null;
    return {
      ruleId,
      selectedFindings: typeof selected === "number" ? selected : undefined,
      blockingTrials: trials,
      truePositives: metric.blocking?.successes ?? 0,
      oneSidedLowerBound: lowerBound,
      belowTarget: lowerBound === null || lowerBound < (protocol.minimumPrecision ?? 0.99),
    };
  }).sort((left, right) => {
    const leftTrials = left.blockingTrials ?? 0;
    const rightTrials = right.blockingTrials ?? 0;
    if (leftTrials !== rightTrials) return leftTrials - rightTrials;
    return left.ruleId.localeCompare(right.ruleId);
  });
  return {
    decision: {
      status: claimReport.decision?.status || "unknown",
      reason: claimReport.decision?.reason || "",
    },
    target: {
      minimumPrecision: protocol.minimumPrecision ?? claimReport.decision?.target ?? 0.99,
      confidence: protocol.confidence ?? claimReport.decision?.confidence ?? 0.95,
      maxRepositoryContribution: protocol.maxRepositoryContribution ?? repositorySelection.limit ?? 0.1,
    },
    counts: {
      true_positive: counts.true_positive || 0,
      false_positive: counts.false_positive || 0,
      needs_policy: counts.needs_policy || 0,
      needs_review: counts.needs_review || 0,
      invalid_setup: counts.invalid_setup || 0,
      out_of_scope: counts.out_of_scope || 0,
    },
    blocking: {
      successes: blocking.successes ?? preflight?.summary?.successes ?? 0,
      trials: blocking.trials ?? preflight?.summary?.trials ?? 0,
      observedPrecision: blocking.observedPrecision ?? preflight?.summary?.observedPrecision ?? null,
      oneSidedLowerBound: blocking.oneSidedLowerBound ?? preflight?.summary?.oneSidedLowerBound ?? null,
      additionalTruePositiveTrialsNeeded: preflight?.summary?.additionalTruePositiveTrialsNeeded ?? null,
    },
    semanticCorrectness: {
      successes: semantic.successes ?? 0,
      trials: semantic.trials ?? 0,
      observedPrecision: semantic.observedPrecision ?? null,
      oneSidedLowerBound: semantic.oneSidedLowerBound ?? null,
    },
    externalRaterCoverage: {
      required: external.required ?? 0,
      externalRaterTypes: external.externalRaterTypes || [],
      selectedFindings: external.selectedFindings ?? preflight?.summary?.selectedFindings ?? 0,
      coveredFindings: external.coveredFindings ?? 0,
      findingsMissingExternalIndependentLabels: external.findingsMissingExternalIndependentLabels ?? 0,
      totalExternalIndependentLabels: external.totalExternalIndependentLabels ?? 0,
    },
    repositorySelection: {
      maxRepositoryContribution: repositorySelection.maxRepositoryContribution ?? null,
      limit: repositorySelection.limit ?? protocol.maxRepositoryContribution ?? 0.1,
      repositoriesWithSelectedFindings: repositorySelection.repositoriesWithSelectedFindings ?? 0,
      minimumRepositoriesWithSelectedFindings: repositorySelection.minimumRepositoriesWithSelectedFindings ?? null,
      feasibleWithCurrentRepositoryCount: repositorySelection.feasibleWithCurrentRepositoryCount ?? null,
      overLimitRepositories: repositories.filter((repository) => repository.overLimit),
    },
    ruleDeficits,
    powerAnalysis: {
      zeroFalsePositiveRequiredTrials: claimReport.metrics?.powerAnalysis?.zeroFalsePositiveRequiredTrials ?? requiredZeroFalsePositiveSampleSize(protocol.minimumPrecision ?? 0.99, protocol.confidence ?? 0.95),
    },
    gateFailures: claimReport.claimGates?.failures || preflight?.gateFailures || [],
  };
}

function requiredZeroFalsePositiveSampleSize(minimumPrecision, confidence) {
  return Math.ceil(Math.log(1 - confidence) / Math.log(minimumPrecision));
}

function taskPacket(snapshot) {
  const tasks = [];
  const externalMissing = snapshot.externalRaterCoverage.findingsMissingExternalIndependentLabels || 0;
  if (externalMissing > 0) {
    tasks.push({
      id: "external-labels",
      status: "blocked",
      required: `${externalMissing} selected findings need ${snapshot.externalRaterCoverage.required} external human/organization independent label(s)`,
      next: "Generate a sealed external worklist and collect labels from non-agent human or organization raters; do not relabel them as agent output.",
    });
  }
  const overLimit = snapshot.repositorySelection.overLimitRepositories || [];
  if (overLimit.length > 0 || snapshot.repositorySelection.feasibleWithCurrentRepositoryCount === false) {
    tasks.push({
      id: "repo-balance",
      status: "open",
      required: `${snapshot.repositorySelection.repositoriesWithSelectedFindings} repositories represented; max contribution ${percent(snapshot.repositorySelection.maxRepositoryContribution)} with limit ${percent(snapshot.repositorySelection.limit)}`,
      next: "Add reviewed repositories with small/medium finding counts before sampling more from already-heavy subjects.",
      overLimitRepositories: overLimit.map((repository) => ({
        repository: repository.repository,
        selectedFindings: repository.selectedFindings,
        contribution: repository.contribution,
        additionalOtherFindingsNeeded: repository.additionalOtherFindingsNeeded || 0,
      })),
    });
  }
  const additional = snapshot.blocking.additionalTruePositiveTrialsNeeded;
  if (typeof additional === "number" && additional > 0) {
    tasks.push({
      id: "sample-size",
      status: "open",
      required: `${additional} additional true-positive blocking trials are needed if no new failures occur`,
      next: "Increase balanced reviewed corpus coverage; keep failures in the denominator instead of reclassifying them away.",
    });
  }
  const needsPolicy = snapshot.counts.needs_policy || 0;
  if (needsPolicy > 0) {
    tasks.push({
      id: "policy-decisions",
      status: "open",
      required: `${needsPolicy} needs_policy findings block the strict precision denominator`,
      next: "Resolve each as explicit policy, waiver, manifest correction, or retained blocking failure before making a public claim.",
    });
  }
  const weakRules = snapshot.ruleDeficits.filter((rule) => rule.belowTarget);
  if (weakRules.length > 0) {
    tasks.push({
      id: "rule-coverage",
      status: "open",
      required: `${weakRules.length} included rules are below the registered lower-bound target or have no blocking trials`,
      next: "Balance sampling by rule, especially rules with zero or tiny blocking denominators.",
      rules: weakRules,
    });
  }
  return tasks;
}

function buildRoundLedger(options, snapshot, claimReportPath, preflightPath) {
  const rounds = [];
  const tasks = taskPacket(snapshot);
  const taskIds = tasks.map((task) => task.id);
  const status = snapshot.decision.status === "claim_ready" || snapshot.decision.status === "pass"
    ? "claim-ready"
    : "insufficient-evidence";
  for (let round = options.fromRound; round <= options.toRound; round += 1) {
    rounds.push({
      round,
      status,
      handoffOnly: true,
      evidenceProgress: false,
      doesNotSatisfyEvidenceGate: true,
      sourceEvidenceChanged: false,
      noSyntheticEvidence: true,
      inputClaimReportSha256: hashFile(claimReportPath),
      inputPreflightSha256: preflightPath ? hashFile(preflightPath) : null,
      decision: snapshot.decision,
      metrics: {
        blockingPrecision: roundNumber(snapshot.blocking.observedPrecision),
        blockingLowerBound: roundNumber(snapshot.blocking.oneSidedLowerBound),
        semanticCorrectness: roundNumber(snapshot.semanticCorrectness.observedPrecision),
        semanticLowerBound: roundNumber(snapshot.semanticCorrectness.oneSidedLowerBound),
        truePositive: snapshot.counts.true_positive,
        falsePositive: snapshot.counts.false_positive,
        needsPolicy: snapshot.counts.needs_policy,
        invalidSetup: snapshot.counts.invalid_setup,
        outOfScope: snapshot.counts.out_of_scope,
      },
      carryForwardTaskIds: taskIds,
      carryForwardTaskRef: "#/residuals/carryForwardTasks",
      handoffToRound: round < options.toRound ? round + 1 : null,
    });
  }
  return rounds;
}

function buildReport(options, claimReport, preflight) {
  validateInputCompatibility(claimReport, preflight);
  const snapshot = extractClaimSnapshot(claimReport, preflight);
  const rounds = buildRoundLedger(options, snapshot, options.claimReportPath, options.preflightPath);
  return {
    schemaVersion,
    generatedAt: new Date().toISOString(),
    handoffOnly: true,
    evidenceProgress: false,
    decision: {
      status: "planning_only",
      reason: "This handoff ledger schedules residual evidence tasks from the source reports; it is not itself precision evidence.",
    },
    sourceDecision: snapshot.decision,
    sourceGateFailures: snapshot.gateFailures,
    source: {
      claimReportPath: portablePath(options.claimReportPath),
      claimReportSha256: hashFile(options.claimReportPath),
      preflightPath: options.preflightPath ? portablePath(options.preflightPath) : null,
      preflightSha256: options.preflightPath ? hashFile(options.preflightPath) : null,
    },
    range: {
      fromRound: options.fromRound,
      toRound: options.toRound,
      rounds: rounds.length,
    },
    invariant: "No round in this ledger fabricates labels, external review, reviewed repositories, or claim progress. New evidence must be supplied by separate sealed artifacts.",
    currentSnapshot: snapshot,
    residuals: {
      externalRaterCoverage: snapshot.externalRaterCoverage,
      repositoryBalance: snapshot.repositorySelection,
      sampleSize: {
        successes: snapshot.blocking.successes,
        trials: snapshot.blocking.trials,
        additionalTruePositiveTrialsNeeded: snapshot.blocking.additionalTruePositiveTrialsNeeded,
        zeroFalsePositiveRequiredTrials: snapshot.powerAnalysis.zeroFalsePositiveRequiredTrials,
      },
      byRule: snapshot.ruleDeficits,
      carryForwardTasks: taskPacket(snapshot),
    },
    rounds,
  };
}

function validateInputCompatibility(claimReport, preflight) {
  if (!preflight) return;
  const claimStudyId = claimReport.protocol?.studyId || claimReport.studyId || "";
  const preflightStudyId = preflight.studyId || "";
  if (claimStudyId && preflightStudyId && claimStudyId !== preflightStudyId) {
    throw new Error(`claim report and preflight studyId mismatch: ${claimStudyId} !== ${preflightStudyId}`);
  }
  const claimProtocol = claimReport.protocol || {};
  const preflightProtocol = preflight.protocol || {};
  for (const key of ["minimumPrecision", "confidence", "maxRepositoryContribution"]) {
    if (claimProtocol[key] !== undefined && preflightProtocol[key] !== undefined && claimProtocol[key] !== preflightProtocol[key]) {
      throw new Error(`claim report and preflight protocol.${key} mismatch: ${claimProtocol[key]} !== ${preflightProtocol[key]}`);
    }
  }
}

function taskSummary(taskIds) {
  return taskIds.join(", ");
}

function renderMarkdown(report) {
  const snapshot = report.currentSnapshot;
  const lines = [
    "# Precision Rounds 18-100 Handoff",
    "",
    "This ledger carries the round17 precision deficits through the requested",
    "round range. It is not new evidence and it does not create external labels,",
    "reviewed repositories, or a public 99% claim.",
    "",
    "**Status: handoff only. Evidence progress: false.**",
    "",
    "## Source",
    "",
    `- Claim report SHA-256: \`${report.source.claimReportSha256}\``,
    `- Preflight SHA-256: ${report.source.preflightSha256 ? `\`${report.source.preflightSha256}\`` : "`not provided`"}`,
    `- Rounds: ${report.range.fromRound}-${report.range.toRound} (${report.range.rounds})`,
    "",
    "## Current Numeric State",
    "",
    "| metric | value |",
    "|---|---:|",
    `| decision | ${snapshot.decision.status} |`,
    `| blocking precision | ${snapshot.blocking.successes} / ${snapshot.blocking.trials} = ${percent(snapshot.blocking.observedPrecision)} |`,
    `| blocking 95% one-sided lower bound | ${percent(snapshot.blocking.oneSidedLowerBound)} |`,
    `| semantic correctness | ${snapshot.semanticCorrectness.successes} / ${snapshot.semanticCorrectness.trials} = ${percent(snapshot.semanticCorrectness.observedPrecision)} |`,
    `| semantic 95% one-sided lower bound | ${percent(snapshot.semanticCorrectness.oneSidedLowerBound)} |`,
    `| external human/org label coverage | ${snapshot.externalRaterCoverage.coveredFindings} / ${snapshot.externalRaterCoverage.selectedFindings} |`,
    `| missing external labels | ${snapshot.externalRaterCoverage.findingsMissingExternalIndependentLabels} |`,
    `| additional TP trials needed | ${snapshot.blocking.additionalTruePositiveTrialsNeeded ?? "unknown"} |`,
    `| zero-failure target per included rule | ${snapshot.powerAnalysis.zeroFalsePositiveRequiredTrials} |`,
    `| max repository contribution | ${percent(snapshot.repositorySelection.maxRepositoryContribution)} (limit ${percent(snapshot.repositorySelection.limit)}) |`,
    "",
    "## Carry-Forward Task Packet",
    "",
  ];
  for (const task of taskPacket(snapshot)) {
    lines.push(`- \`${task.id}\` (${task.status}): ${task.required}. ${task.next}`);
    if (task.overLimitRepositories) {
      for (const repository of task.overLimitRepositories) {
        lines.push(`  - ${repository.repository}: ${repository.selectedFindings} findings, ${percent(repository.contribution)}, add ${repository.additionalOtherFindingsNeeded} other findings or reduce this subject.`);
      }
    }
  }
  lines.push(
    "",
    "## Round Ledger",
    "",
    "| round | status | blocking precision | lower bound | external labels | max repo contribution | carry-forward | handoff |",
    "|---:|---|---:|---:|---:|---:|---|---:|",
  );
  for (const round of report.rounds) {
    lines.push(`| ${round.round} | ${round.status} | ${percent(round.metrics.blockingPrecision)} | ${percent(round.metrics.blockingLowerBound)} | ${snapshot.externalRaterCoverage.coveredFindings}/${snapshot.externalRaterCoverage.selectedFindings} | ${percent(snapshot.repositorySelection.maxRepositoryContribution)} | ${taskSummary(round.carryForwardTaskIds)} | ${round.handoffToRound ?? ""} |`);
  }
  lines.push(
    "",
    "## Non-Negotiable Gate",
    "",
    "Agent-only relabeling can improve diagnostics, but it cannot satisfy the",
    "registered external human/organization label gate. Until sealed external",
    "labels and a larger balanced reviewed corpus are supplied, every round in",
    "this ledger remains `insufficient-evidence` for a public 99% precision claim.",
    "",
  );
  return lines.join("\n");
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const claimReport = readJson(options.claimReportPath);
    const preflight = options.preflightPath ? readJson(options.preflightPath) : null;
    const report = buildReport(options, claimReport, preflight);
    if (options.outJsonPath) writeJson(options.outJsonPath, report);
    if (options.outMarkdownPath) writeText(options.outMarkdownPath, renderMarkdown(report));
    console.log(JSON.stringify({
      ok: true,
      schemaVersion,
      handoffOnly: true,
      evidenceProgress: false,
      rounds: report.range.rounds,
      status: report.rounds[0]?.status || "unknown",
      missingExternalLabels: report.currentSnapshot.externalRaterCoverage.findingsMissingExternalIndependentLabels,
      additionalTruePositiveTrialsNeeded: report.currentSnapshot.blocking.additionalTruePositiveTrialsNeeded,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
