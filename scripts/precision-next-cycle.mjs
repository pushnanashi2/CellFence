#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const markerFileName = ".cellfence-precision-next-cycle";
const defaultStepTimeoutMs = 120_000;
const largeArtifactStepTimeoutMs = 1_800_000;
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
const claimProfiles = {
  "ts-js-boundary-core-v1": {
    description: "Reviewed TS/JS boundary-core blocking precision: private imports and undeclared cell consumers only.",
    targetPopulation: "reviewed TS/JS workspace repositories, boundary-core rules only",
    includedRules: [
      "CELLFENCE_PRIVATE_IMPORT",
      "CELLFENCE_UNDECLARED_CONSUMER",
    ],
  },
  "ts-js-loader-safety-v1": {
    description: "Reviewed TS/JS loader-safety blocking precision: unsupported or unresolved dynamic module loading only.",
    targetPopulation: "reviewed TS/JS workspace repositories, dynamic loader safety rules only",
    includedRules: [
      "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
      "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
      "CELLFENCE_UNRESOLVED_IMPORT",
    ],
  },
  "ts-js-static-resource-v1": {
    description: "Reviewed TS/JS static-resource blocking precision: selected static resource access detectors only.",
    targetPopulation: "reviewed TS/JS workspace repositories, selected static resource access rules only",
    includedRules: [
      "CELLFENCE_UNDECLARED_RESOURCE_ACCESS",
      "CELLFENCE_UNRESOLVED_RESOURCE_ACCESS",
    ],
  },
};

function usage() {
  console.error(`Usage:
  node scripts/precision-next-cycle.mjs --study-id id --corpus corpus.json --report corpus-report.json --out-dir reports/corpus/id-cycle --raters reviewer-a,reviewer-b --rater-types human,organization [--claim-profile ts-js-boundary-core-v1 | --include-rules rule-a,rule-b] [--force]

Builds the next precision-study cycle from an already executed reviewed corpus
report. It validates the reviewed corpus, freezes an unlabeled evidence bundle,
creates a sealed blind-label worklist, runs claim preflight against the unlabeled
bundle, and writes a summary with the remaining blockers. It never creates
labels and therefore cannot satisfy the external human/org label gate by itself.
--claim-profile applies a named finite claim scope with a fixed rule set.
--include-rules narrows the claim protocol and worklist filters to a rule-scoped
supplemental cycle while preserving the full sealed bundle.`);
}

function parseArgs(argv) {
  const parsed = {
    studyId: "",
    corpusPath: "",
    reportPath: "",
    outDir: "",
    raters: [],
    raterTypes: [],
    targetPopulation: "",
    maxRepositoryContribution: null,
    includeRules: [...defaultIncludedRules],
    includeRulesProvided: false,
    claimProfile: "",
    force: false,
    externalClaim: false,
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
    } else if (argument === "--raters") {
      parsed.raters = parseList(requireValue(argv, index, "--raters"));
      index += 1;
    } else if (argument.startsWith("--raters=")) {
      parsed.raters = parseList(requireInlineValue(argument, "--raters=", "--raters"));
    } else if (argument === "--rater-types") {
      parsed.raterTypes = parseList(requireValue(argv, index, "--rater-types"));
      index += 1;
    } else if (argument.startsWith("--rater-types=")) {
      parsed.raterTypes = parseList(requireInlineValue(argument, "--rater-types=", "--rater-types"));
    } else if (argument === "--target-population") {
      parsed.targetPopulation = requireValue(argv, index, "--target-population");
      index += 1;
    } else if (argument.startsWith("--target-population=")) {
      parsed.targetPopulation = requireInlineValue(argument, "--target-population=", "--target-population");
    } else if (argument === "--max-repository-contribution") {
      parsed.maxRepositoryContribution = parseUnitInterval(requireValue(argv, index, "--max-repository-contribution"), "--max-repository-contribution");
      index += 1;
    } else if (argument.startsWith("--max-repository-contribution=")) {
      parsed.maxRepositoryContribution = parseUnitInterval(requireInlineValue(argument, "--max-repository-contribution=", "--max-repository-contribution"), "--max-repository-contribution");
    } else if (argument === "--include-rules") {
      parsed.includeRules = parseIncludedRules(requireValue(argv, index, "--include-rules"));
      parsed.includeRulesProvided = true;
      index += 1;
    } else if (argument.startsWith("--include-rules=")) {
      parsed.includeRules = parseIncludedRules(requireInlineValue(argument, "--include-rules=", "--include-rules"));
      parsed.includeRulesProvided = true;
    } else if (argument === "--claim-profile") {
      parsed.claimProfile = requireValue(argv, index, "--claim-profile");
      index += 1;
    } else if (argument.startsWith("--claim-profile=")) {
      parsed.claimProfile = requireInlineValue(argument, "--claim-profile=", "--claim-profile");
    } else if (argument === "--external-claim") {
      parsed.externalClaim = true;
    } else if (argument === "--force") {
      parsed.force = true;
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.studyId) throw new Error("--study-id is required");
  if (!/^[a-zA-Z0-9._-]+$/.test(parsed.studyId)) throw new Error("--study-id may contain only letters, numbers, dot, underscore, and dash");
  if (!parsed.corpusPath) throw new Error("--corpus is required");
  if (!parsed.reportPath) throw new Error("--report is required");
  if (!parsed.outDir) throw new Error("--out-dir is required");
  if (parsed.raters.length !== 2) throw new Error("--raters must name exactly two independent raters");
  if (new Set(parsed.raters).size !== 2) throw new Error("--raters must be distinct");
  if (parsed.raterTypes.length !== 1 && parsed.raterTypes.length !== 2) {
    throw new Error("--rater-types must be one value or one value per rater");
  }
  for (const raterType of parsed.raterTypes) {
    if (!new Set(["human", "organization", "agent"]).has(raterType)) {
      throw new Error(`unknown --rater-types value: ${raterType}`);
    }
  }
  applyClaimProfile(parsed);
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

function parseIncludedRules(value) {
  const rules = parseList(value);
  if (rules.length === 0) throw new Error("--include-rules must contain at least one rule");
  const knownRules = new Set(defaultIncludedRules);
  const unknownRules = rules.filter((ruleId) => !knownRules.has(ruleId));
  if (unknownRules.length > 0) throw new Error(`unknown --include-rules value(s): ${unknownRules.join(", ")}`);
  if (new Set(rules).size !== rules.length) throw new Error("--include-rules must not contain duplicate rules");
  return rules;
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function applyClaimProfile(parsed) {
  if (!parsed.claimProfile) return;
  const profile = claimProfiles[parsed.claimProfile];
  if (!profile) {
    throw new Error(`unknown --claim-profile value: ${parsed.claimProfile}; expected one of ${Object.keys(claimProfiles).sort().join(", ")}`);
  }
  if (parsed.includeRulesProvided && !arraysEqual(parsed.includeRules, profile.includedRules)) {
    throw new Error(`--include-rules must match --claim-profile ${parsed.claimProfile}: ${profile.includedRules.join(",")}`);
  }
  parsed.includeRules = [...profile.includedRules];
  if (parsed.targetPopulation && parsed.targetPopulation !== profile.targetPopulation) {
    throw new Error(`--target-population must match --claim-profile ${parsed.claimProfile}: ${profile.targetPopulation}`);
  }
  parsed.targetPopulation = profile.targetPopulation;
}

function claimProfile(options) {
  return options.claimProfile ? claimProfiles[options.claimProfile] || null : null;
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
  if (!fs.existsSync(filePath)) return [];
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

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function validateReportCorpusBinding(corpusPath, reportPath) {
  const corpus = readJson(corpusPath);
  const report = readJson(reportPath);
  const actualCorpusSha256 = hashFile(corpusPath);
  const reportCorpusSha256 = report.environment?.corpusSha256 || "";
  if (!reportCorpusSha256) {
    throw new Error("report.environment.corpusSha256 is required");
  }
  if (reportCorpusSha256 && reportCorpusSha256 !== actualCorpusSha256) {
    throw new Error("report.environment.corpusSha256 does not match --corpus");
  }
  if (report.corpusPath && fs.existsSync(report.corpusPath) && hashFile(report.corpusPath) !== actualCorpusSha256) {
    throw new Error("report.corpusPath points to a different corpus than --corpus");
  }
  if (corpus.schemaVersion === "cellfence.history-replay.v1" && report.schemaVersion !== "cellfence.history-replay-study.v1") {
    throw new Error("history replay corpus requires a history replay report");
  }
  if (corpus.schemaVersion === "cellfence.corpus.v1" && report.schemaVersion !== "cellfence.corpus-study.v1") {
    throw new Error("reviewed corpus requires a corpus study report");
  }
}

function posixify(value) {
  return String(value).replace(/\\/g, "/").split(path.sep).join("/");
}

function portablePath(filePath) {
  const relativePath = path.relative(repoRoot, filePath);
  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) return posixify(relativePath);
  return posixify(filePath);
}

function increment(counts, key, amount = 1) {
  counts[key] = (counts[key] || 0) + amount;
}

function runStep(label, command, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      LC_ALL: "C",
      TZ: "UTC",
    },
    maxBuffer: 100 * 1024 * 1024,
    timeout: options.timeoutMs || defaultStepTimeoutMs,
  });
  const stdoutPath = options.stdoutPath || null;
  const stderrPath = options.stderrPath || null;
  if (stdoutPath) writeText(stdoutPath, result.stdout || "");
  if (stderrPath) writeText(stderrPath, result.stderr || "");
  return {
    label,
    command: [command, ...args].map(String),
    exitCode: typeof result.status === "number" ? result.status : null,
    signal: result.signal || null,
    durationMs: Date.now() - startedAt,
    stdoutPath: stdoutPath ? portablePath(stdoutPath) : null,
    stderrPath: stderrPath ? portablePath(stderrPath) : null,
    error: result.error ? result.error.message : null,
  };
}

function assertExit(step, expected, options = {}) {
  const acceptable = Array.isArray(expected) ? expected : [expected];
  if (!acceptable.includes(step.exitCode)) {
    const detail = [step.error, step.stderrPath ? fs.readFileSync(path.resolve(repoRoot, step.stderrPath), "utf8") : ""]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`${step.label} expected exit ${acceptable.join(" or ")}, got ${step.exitCode}${detail ? `: ${detail}` : ""}`);
  }
  if (options.rejectSignal && step.signal) throw new Error(`${step.label} was killed by ${step.signal}`);
}

function assertSafeOutDir(outDir) {
  const resolved = realPathForContainment(outDir);
  const allowedRoots = [
    realPathForContainment(path.join(repoRoot, "reports", "corpus")),
    realPathForContainment(path.join(repoRoot, "tmp")),
  ];
  if (!allowedRoots.some((root) => isInside(root, resolved))) {
    throw new Error("--out-dir must be inside reports/corpus/ or tmp/");
  }
  if (allowedRoots.includes(resolved)) throw new Error(`unsafe --out-dir: ${outDir}`);
}

function isInside(parentDir, candidatePath) {
  const relative = path.relative(parentDir, candidatePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function realPathForContainment(filePath) {
  const resolvedPath = path.resolve(filePath);
  let existingPath = resolvedPath;
  const missingParts = [];
  while (!fs.existsSync(existingPath)) {
    const parentPath = path.dirname(existingPath);
    if (parentPath === existingPath) return resolvedPath;
    missingParts.unshift(path.basename(existingPath));
    existingPath = parentPath;
  }
  return path.resolve(fs.realpathSync.native(existingPath), ...missingParts);
}

function markerPath(outDir) {
  return path.join(outDir, markerFileName);
}

function hasGeneratedMarker(outDir) {
  if (!fs.existsSync(markerPath(outDir))) return false;
  try {
    const marker = readJson(markerPath(outDir));
    return marker.schemaVersion === "cellfence.precision-next-cycle-marker.v1";
  } catch {
    return false;
  }
}

function writeGeneratedMarker(outDir) {
  writeJson(markerPath(outDir), {
    schemaVersion: "cellfence.precision-next-cycle-marker.v1",
    generatedBy: "scripts/precision-next-cycle.mjs",
  });
}

function prepareOutDir(outDir, force) {
  assertSafeOutDir(outDir);
  if (fs.existsSync(outDir)) {
    const stat = fs.lstatSync(outDir);
    if (!stat.isDirectory()) throw new Error(`output path exists and is not a directory: ${outDir}`);
    if (!force) throw new Error(`output directory already exists: ${outDir}`);
    if (!hasGeneratedMarker(outDir)) {
      throw new Error(`refusing to delete unmarked output directory: ${outDir}`);
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });
  writeGeneratedMarker(outDir);
}

function toolCommitFromStudy(study) {
  const commit = study.environment?.harnessCommit || "";
  if (/^[a-f0-9]{40}$/.test(commit)) return commit;
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const fallback = result.stdout.trim();
  return /^[a-f0-9]{40}$/.test(fallback) ? fallback : commit;
}

function writeWorklistProtocol(protocolPath, options, binding) {
  const raterTypes = expandedRaterTypes(options);
  const diagnosticAgentCycle = raterTypes.includes("agent");
  const externalClaimCycle = isExternalClaimCycle(options);
  writeJson(protocolPath, {
    schemaVersion: "cellfence.precision-claim-protocol.v1",
    studyId: options.studyId,
    claim: {
      toolCommit: binding.toolCommit,
      preLabelArtifactSetSha256: binding.preLabelArtifactSetSha256,
      targetPopulation: options.targetPopulation || `${options.studyId} reviewed TS/JS corpus precision cycle`,
      supportedSyntaxProfile: "ts-js-supported-v1",
      scopeProfile: options.claimProfile || null,
      includedRules: options.includeRules,
      primaryMetric: "blocking_precision",
      minimumPrecision: 0.99,
      confidence: 0.95,
      blockingSeverities: ["error"],
    },
    samplingPlan: {
      unit: "finding",
      method: "deterministic sampled precision-eligible set from a sealed reviewed corpus bundle",
      maxRepositoryContribution: options.maxRepositoryContribution || 0.1,
    },
    labelingPlan: {
      minimumIndependentRaters: 2,
      requireAdjudicationForDisagreements: true,
      requireKnownRaterType: true,
      allowedRaterTypes: diagnosticAgentCycle ? ["agent", "human", "organization"] : ["human", "organization"],
      allowNonHumanRaters: diagnosticAgentCycle,
      requireExternalIndependentRaters: true,
      externalRaterTypes: ["human", "organization"],
      minimumExternalIndependentRaters: 1,
      countNeedsPolicyAs: "blocking_failure_semantic_success",
      countNeedsReviewAs: "blocking_failure",
    },
    manifestReviewPlan: {
      requireExternalAttestations: externalClaimCycle,
      allowedReviewerTypes: ["human", "organization"],
    },
    exclusionRules: [],
  });
}

function expandedRaterTypes(options) {
  return options.raterTypes.length === 1 ? options.raters.map(() => options.raterTypes[0]) : options.raterTypes;
}

function isExternalClaimCycle(options) {
  return options.externalClaim || expandedRaterTypes(options).every((raterType) => raterType !== "agent");
}

function writePreflightProtocol(protocolPath, options, binding, worklistArtifactSetSha256) {
  const protocol = readJson(binding.worklistProtocolPath);
  protocol.claim.artifactSetSha256 = binding.unlabeledBundleArtifactSetSha256;
  protocol.claim.worklistArtifactSetSha256s = [worklistArtifactSetSha256];
  protocol.samplingPlan.method = `${protocol.samplingPlan.method}; pre-label preflight uses the unlabeled bundle and must be regenerated after returned labels`;
  writeJson(protocolPath, protocol);
}

function blockersFromPreflight(preflightPath) {
  if (!fs.existsSync(preflightPath)) return [];
  const preflight = readJson(preflightPath);
  const blockers = [...(preflight.gateFailures || [])];
  if (Array.isArray(preflight.issues) && preflight.issues.length > 0) {
    blockers.push(...preflight.issues.map((issue) => `malformed input: ${issue}`));
  }
  return [...new Set(blockers)];
}

function blockersFromExternalValidation(externalValidationPath) {
  if (!fs.existsSync(externalValidationPath)) return [];
  const report = readJson(externalValidationPath);
  if (report.ok === true) return [];
  const issues = Array.isArray(report.issues) ? report.issues : [];
  const blockers = [`external manifest review attestation gate has ${issues.length || "unknown"} issue(s)`];
  blockers.push(...issues.slice(0, 10).map((issue) => `external manifest review: ${issue}`));
  if (issues.length > 10) blockers.push(`external manifest review: ${issues.length - 10} additional issue(s) omitted from summary`);
  return blockers;
}

function samplingSummaryFromBundle(bundleDir) {
  const samplingPath = path.join(bundleDir, "sampling.json");
  if (!fs.existsSync(samplingPath)) return null;
  const sampling = readJson(samplingPath);
  const findings = readJsonl(path.join(bundleDir, "findings.normalized.jsonl"));
  const findingsById = new Map(findings.map((finding) => [finding.findingId, finding]));
  const removedFindingIds = sampling.repositoryBalance?.removedFindingIds || [];
  const removedByRule = {};
  const removedByRepository = {};
  for (const findingId of removedFindingIds) {
    const finding = findingsById.get(findingId);
    increment(removedByRule, finding?.ruleId || "unknown");
    increment(removedByRepository, finding?.repository || finding?.subjectId || "unknown");
  }
  return {
    sampledFindings: sampling.population?.sampledFindings ?? (sampling.sampledFindingIds || []).length,
    sampledByRule: sampling.sampledByRule || {},
    repositoryBalance: {
      enabled: sampling.repositoryBalance?.enabled === true,
      feasible: sampling.repositoryBalance?.feasible ?? null,
      maxRepositoryContribution: sampling.repositoryBalance?.maxRepositoryContribution ?? sampling.maxRepositoryContribution ?? null,
      minimumRepositories: sampling.repositoryBalance?.minimumRepositories ?? null,
      repositoriesWithSampledFindings: sampling.repositoryBalance?.repositoriesWithSampledFindings ?? null,
      removedFindingIds: removedFindingIds.length,
      removedByRule: Object.fromEntries(Object.entries(removedByRule).sort()),
      removedByRepository: Object.fromEntries(Object.entries(removedByRepository).sort((left, right) => (right[1] - left[1]) || left[0].localeCompare(right[0]))),
    },
  };
}

function worklistSelectionSummary(worklistDir) {
  const worklist = readJson(path.join(worklistDir, "worklist.json"));
  const selectedFindingIds = new Set();
  const selectedByRule = {};
  const selectedBySubject = {};
  for (const assignment of worklist.assignments || []) {
    if (selectedFindingIds.has(assignment.findingId)) continue;
    selectedFindingIds.add(assignment.findingId);
    increment(selectedByRule, assignment.ruleId || "unknown");
    increment(selectedBySubject, assignment.subjectId || "unknown");
  }
  return {
    selectedFindings: worklist.summary?.selectedFindings ?? selectedFindingIds.size,
    assignments: worklist.summary?.assignments ?? (worklist.assignments || []).length,
    selectedByRule: Object.fromEntries(Object.entries(selectedByRule).sort()),
    selectedBySubject: Object.fromEntries(Object.entries(selectedBySubject).sort((left, right) => (right[1] - left[1]) || left[0].localeCompare(right[0]))),
  };
}

function writeMarkdown(outPath, summary) {
  const lines = [
    `# ${summary.studyId} Precision Next Cycle`,
    "",
    "This cycle freezes the next evidence package and blind worklist. It does not",
    "create labels and therefore cannot satisfy the external human/org label gate.",
    "",
    "## Artifacts",
    "",
    `- Reviewed corpus validation: \`${summary.artifacts.reviewedCorpusValidation}\``,
    `- External corpus validation: \`${summary.artifacts.externalCorpusValidation}\``,
    `- Unlabeled bundle: \`${summary.artifacts.unlabeledBundle}\``,
    `- Blind worklist: \`${summary.artifacts.blindWorklist}\``,
    `- Worklist protocol: \`${summary.artifacts.worklistProtocol}\``,
    `- Pre-label preflight protocol: \`${summary.artifacts.preflightProtocol}\``,
    `- Pre-label preflight: \`${summary.artifacts.preflight}\``,
    "",
    "## Digests",
    "",
    `- preLabelArtifactSetSha256: \`${summary.digests.preLabelArtifactSetSha256}\``,
    `- unlabeledBundleArtifactSetSha256: \`${summary.digests.unlabeledBundleArtifactSetSha256}\``,
    `- blindWorklistArtifactSetSha256: \`${summary.digests.blindWorklistArtifactSetSha256}\``,
    "",
    "## Sampling",
    "",
    `- claim profile: \`${summary.claimProfile || "custom"}\``,
    ...(summary.claimProfileDescription ? [`- claim profile description: ${summary.claimProfileDescription}`] : []),
    `- included rules: \`${summary.includedRules.join(",")}\``,
    `- worklist selected findings: ${summary.worklist?.selectedFindings ?? "n/a"}`,
    `- worklist assignments: ${summary.worklist?.assignments ?? "n/a"}`,
    `- worklist selected by rule: \`${JSON.stringify(summary.worklist?.selectedByRule || {})}\``,
    `- full bundle sampled findings: ${summary.sampling?.sampledFindings ?? "n/a"}`,
    `- full bundle sampled by rule: \`${JSON.stringify(summary.sampling?.sampledByRule || {})}\``,
    `- repository balance enabled: ${summary.sampling?.repositoryBalance?.enabled === true}`,
    `- repository balance feasible: ${summary.sampling?.repositoryBalance?.feasible ?? "n/a"}`,
    `- cap-pruned sampled findings: ${summary.sampling?.repositoryBalance?.removedFindingIds ?? 0}`,
    `- cap-pruned by rule: \`${JSON.stringify(summary.sampling?.repositoryBalance?.removedByRule || {})}\``,
    "",
    "## Current Blockers",
    "",
    ...(summary.blockers.length > 0 ? summary.blockers.map((blocker) => `- ${blocker}`) : ["- none recorded"]),
    "",
    "## Next Steps",
    "",
    "- Return two independent blind label files from the sealed worklist assignments.",
    "- Rebuild a labeled bundle with the same pre-label artifact digest.",
    "- Generate adjudication worklist for disagreements, if any.",
    "- Update the final claim protocol with the labeled bundle digest and all worklist digests.",
    "- Run label readiness, claim preflight, and the statistical claim report.",
  ];
  writeText(outPath, lines.join("\n"));
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

  const steps = [];
  try {
    prepareOutDir(options.outDir, options.force);
    const logsDir = path.join(options.outDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });

    const reviewedCorpusValidationPath = path.join(options.outDir, "reviewed-corpus-validation.json");
    const externalCorpusValidationPath = path.join(options.outDir, "reviewed-corpus-external-validation.json");
    const unlabeledBundleDir = path.join(options.outDir, "bundle-unlabeled");
    const blindWorklistDir = path.join(options.outDir, "blind-worklist");
    const worklistProtocolPath = path.join(options.outDir, "protocol.worklist.json");
    const preflightProtocolPath = path.join(options.outDir, "protocol.prelabel-preflight.json");
    const preflightPath = path.join(options.outDir, "claim-preflight.prelabel.json");

    let step = runStep("reviewed corpus validation", process.execPath, [
      path.join(repoRoot, "scripts", "reviewed-corpus-validate.mjs"),
      "--corpus",
      options.corpusPath,
      "--out",
      reviewedCorpusValidationPath,
    ], {
      stdoutPath: path.join(logsDir, "reviewed-corpus-validation.stdout.log"),
      stderrPath: path.join(logsDir, "reviewed-corpus-validation.stderr.log"),
    });
    steps.push(step);
    assertExit(step, 0);

    step = runStep("external corpus validation", process.execPath, [
      path.join(repoRoot, "scripts", "reviewed-corpus-validate.mjs"),
      "--corpus",
      options.corpusPath,
      "--external-claim",
      "--out",
      externalCorpusValidationPath,
    ], {
      stdoutPath: path.join(logsDir, "reviewed-corpus-external-validation.stdout.log"),
      stderrPath: path.join(logsDir, "reviewed-corpus-external-validation.stderr.log"),
    });
    steps.push(step);
    assertExit(step, [0, 1]);
    validateReportCorpusBinding(options.corpusPath, options.reportPath);

    const bundleArgs = [
      path.join(repoRoot, "scripts", "corpus-evidence-bundle.mjs"),
      "--study-id",
      options.studyId,
      "--corpus",
      options.corpusPath,
      "--report",
      options.reportPath,
      "--out-dir",
      unlabeledBundleDir,
    ];
    if (options.maxRepositoryContribution !== null) {
      bundleArgs.push("--max-repository-contribution", String(options.maxRepositoryContribution));
      bundleArgs.push("--balance-rules", options.includeRules.join(","));
    }
    step = runStep("unlabeled bundle build", process.execPath, bundleArgs, {
      stdoutPath: path.join(logsDir, "bundle-unlabeled.stdout.log"),
      stderrPath: path.join(logsDir, "bundle-unlabeled.stderr.log"),
      timeoutMs: largeArtifactStepTimeoutMs,
    });
    steps.push(step);
    assertExit(step, 0);

    step = runStep("unlabeled bundle validate", process.execPath, [
      path.join(repoRoot, "scripts", "corpus-evidence-bundle.mjs"),
      "--validate",
      "--bundle",
      unlabeledBundleDir,
    ], {
      stdoutPath: path.join(logsDir, "bundle-unlabeled-validate.stdout.log"),
      stderrPath: path.join(logsDir, "bundle-unlabeled-validate.stderr.log"),
      timeoutMs: largeArtifactStepTimeoutMs,
    });
    steps.push(step);
    assertExit(step, 0);

    const study = readJson(path.join(unlabeledBundleDir, "study.json"));
    const binding = {
      toolCommit: toolCommitFromStudy(study),
      preLabelArtifactSetSha256: study.preregistration.preLabelArtifactSetSha256,
      unlabeledBundleArtifactSetSha256: hashFile(path.join(unlabeledBundleDir, "SHA256SUMS")),
      worklistProtocolPath,
    };
    writeWorklistProtocol(worklistProtocolPath, options, binding);

    step = runStep("blind worklist build", process.execPath, [
      path.join(repoRoot, "scripts", "precision-label-worklist.mjs"),
      "--bundle",
      unlabeledBundleDir,
      "--out-dir",
      blindWorklistDir,
      "--protocol",
      worklistProtocolPath,
      "--raters",
      options.raters.join(","),
      "--rater-types",
      options.raterTypes.join(","),
    ], {
      stdoutPath: path.join(logsDir, "blind-worklist.stdout.log"),
      stderrPath: path.join(logsDir, "blind-worklist.stderr.log"),
      timeoutMs: largeArtifactStepTimeoutMs,
    });
    steps.push(step);
    assertExit(step, 0);

    const blindWorklistArtifactSetSha256 = hashFile(path.join(blindWorklistDir, "SHA256SUMS"));
    writePreflightProtocol(preflightProtocolPath, options, binding, blindWorklistArtifactSetSha256);

    step = runStep("pre-label claim preflight", process.execPath, [
      path.join(repoRoot, "scripts", "precision-claim-preflight.mjs"),
      "--bundle",
      unlabeledBundleDir,
      "--protocol",
      preflightProtocolPath,
      "--worklist",
      blindWorklistDir,
      "--out",
      preflightPath,
    ], {
      stdoutPath: path.join(logsDir, "claim-preflight.prelabel.stdout.log"),
      stderrPath: path.join(logsDir, "claim-preflight.prelabel.stderr.log"),
      timeoutMs: largeArtifactStepTimeoutMs,
    });
    steps.push(step);
    assertExit(step, [0, 1, 2]);

    const summary = {
      schemaVersion: "cellfence.precision-next-cycle.v1",
      generatedAt: new Date().toISOString(),
      studyId: options.studyId,
      claimProfile: options.claimProfile || null,
      claimProfileDescription: claimProfile(options)?.description || null,
      corpusPath: portablePath(options.corpusPath),
      reportPath: portablePath(options.reportPath),
      outDir: portablePath(options.outDir),
      includedRules: options.includeRules,
      artifacts: {
        reviewedCorpusValidation: portablePath(reviewedCorpusValidationPath),
        externalCorpusValidation: portablePath(externalCorpusValidationPath),
        unlabeledBundle: portablePath(unlabeledBundleDir),
        blindWorklist: portablePath(blindWorklistDir),
        worklistProtocol: portablePath(worklistProtocolPath),
        preflightProtocol: portablePath(preflightProtocolPath),
        preflight: portablePath(preflightPath),
      },
      digests: {
        preLabelArtifactSetSha256: binding.preLabelArtifactSetSha256,
        unlabeledBundleArtifactSetSha256: binding.unlabeledBundleArtifactSetSha256,
        blindWorklistArtifactSetSha256,
      },
      raterPlan: {
        raters: options.raters,
        raterTypes: expandedRaterTypes(options),
        externalClaim: isExternalClaimCycle(options),
      },
      samplingOptions: {
        maxRepositoryContribution: options.maxRepositoryContribution,
        includeRulesProvided: options.includeRulesProvided,
        claimProfileProvided: Boolean(options.claimProfile),
      },
      sampling: samplingSummaryFromBundle(unlabeledBundleDir),
      worklist: worklistSelectionSummary(blindWorklistDir),
      blockers: [...new Set([
        ...blockersFromPreflight(preflightPath),
        ...blockersFromExternalValidation(externalCorpusValidationPath),
      ])],
      steps,
    };
    const summaryJsonPath = path.join(options.outDir, "summary.json");
    const summaryMdPath = path.join(options.outDir, "SUMMARY.md");
    writeJson(summaryJsonPath, summary);
    writeMarkdown(summaryMdPath, summary);
    console.log(JSON.stringify({
      schemaVersion: summary.schemaVersion,
      studyId: summary.studyId,
      outDir: summary.outDir,
      preLabelArtifactSetSha256: summary.digests.preLabelArtifactSetSha256,
      blindWorklistArtifactSetSha256,
      includedRules: summary.includedRules,
      claimProfile: summary.claimProfile,
      worklistSelectedFindings: summary.worklist.selectedFindings,
      blockers: summary.blockers.length,
      summaryPath: portablePath(summaryJsonPath),
    }, null, 2));
    return 0;
  } catch (error) {
    const failurePath = options.outDir && fs.existsSync(options.outDir) && hasGeneratedMarker(options.outDir)
      ? path.join(options.outDir, "failure.json")
      : "";
    if (failurePath) {
      writeJson(failurePath, {
        schemaVersion: "cellfence.precision-next-cycle.failure.v1",
        generatedAt: new Date().toISOString(),
        studyId: options.studyId,
        error: error instanceof Error ? error.message : String(error),
        steps,
      });
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = main();
