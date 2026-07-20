#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  console.error(`Usage:
  node scripts/precision-label-transfer.mjs --source-bundle reports/corpus/old-bundle --target-bundle reports/corpus/new-bundle --out labels.jsonl [--supplemental-labels labels.jsonl] [--default-rater-type agent] [--report report.json] [--allow-partial]

Transfers blind/adjudication labels between evidence bundles by stable
findingId. The target studyId is rewritten, labels for disappeared findings are
dropped, and newly sampled target findings are reported for fresh labeling.`);
}

function parseArgs(argv) {
  const parsed = {
    sourceBundle: "",
    targetBundle: "",
    outPath: "",
    reportPath: "",
    supplementalLabelPaths: [],
    defaultRaterType: "",
    allowPartial: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--source-bundle") {
      parsed.sourceBundle = path.resolve(requireValue(argv, index, "--source-bundle"));
      index += 1;
    } else if (argument.startsWith("--source-bundle=")) {
      parsed.sourceBundle = path.resolve(requireInlineValue(argument, "--source-bundle=", "--source-bundle"));
    } else if (argument === "--target-bundle") {
      parsed.targetBundle = path.resolve(requireValue(argv, index, "--target-bundle"));
      index += 1;
    } else if (argument.startsWith("--target-bundle=")) {
      parsed.targetBundle = path.resolve(requireInlineValue(argument, "--target-bundle=", "--target-bundle"));
    } else if (argument === "--out") {
      parsed.outPath = path.resolve(requireValue(argv, index, "--out"));
      index += 1;
    } else if (argument.startsWith("--out=")) {
      parsed.outPath = path.resolve(requireInlineValue(argument, "--out=", "--out"));
    } else if (argument === "--report") {
      parsed.reportPath = path.resolve(requireValue(argv, index, "--report"));
      index += 1;
    } else if (argument.startsWith("--report=")) {
      parsed.reportPath = path.resolve(requireInlineValue(argument, "--report=", "--report"));
    } else if (argument === "--supplemental-labels") {
      parsed.supplementalLabelPaths.push(path.resolve(requireValue(argv, index, "--supplemental-labels")));
      index += 1;
    } else if (argument.startsWith("--supplemental-labels=")) {
      parsed.supplementalLabelPaths.push(path.resolve(requireInlineValue(argument, "--supplemental-labels=", "--supplemental-labels")));
    } else if (argument === "--default-rater-type") {
      parsed.defaultRaterType = requireValue(argv, index, "--default-rater-type");
      index += 1;
    } else if (argument.startsWith("--default-rater-type=")) {
      parsed.defaultRaterType = requireInlineValue(argument, "--default-rater-type=", "--default-rater-type");
    } else if (argument === "--allow-partial") {
      parsed.allowPartial = true;
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.sourceBundle) throw new Error("--source-bundle is required");
  if (!parsed.targetBundle) throw new Error("--target-bundle is required");
  if (!parsed.outPath) throw new Error("--out is required");
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

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "");
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

function sanitizeLabel(label) {
  return Object.fromEntries(Object.entries(label).filter(([key]) => labelAllowedKeys.has(key)));
}

function increment(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function withDefaultRaterType(label, defaultRaterType) {
  if (!defaultRaterType || label.raterType || label.raterClass) return label;
  return { ...label, raterType: defaultRaterType };
}

function readBundle(bundleDir) {
  return {
    study: readJson(path.join(bundleDir, "study.json")),
    sampling: readJson(path.join(bundleDir, "sampling.json")),
    findings: readJsonl(path.join(bundleDir, "findings.normalized.jsonl")),
    labels: readJsonl(path.join(bundleDir, "labels.jsonl")),
  };
}

function sampledPrecisionEligibleFindings(bundle) {
  const sampledIds = new Set(bundle.sampling.sampledFindingIds || []);
  return bundle.findings.filter((finding) => sampledIds.has(finding.findingId) && finding.precisionEligible === true);
}

function transferLabels(options) {
  const source = readBundle(options.sourceBundle);
  const target = readBundle(options.targetBundle);
  const targetFindings = sampledPrecisionEligibleFindings(target);
  const targetIds = new Set(targetFindings.map((finding) => finding.findingId));
  const sourceLabelsByFinding = groupBy(source.labels, (label) => label.findingId);
  const transferredLabels = [];
  const transferredLabelSources = [];
  const transferredKeys = new Set();
  const transferredFindingIds = new Set();
  const missingTargetFindings = [];

  for (const finding of targetFindings) {
    const labels = sourceLabelsByFinding.get(finding.findingId) || [];
    if (labels.length === 0) {
      missingTargetFindings.push(finding);
      continue;
    }
    transferredFindingIds.add(finding.findingId);
    for (const label of labels) {
      const nextLabel = {
        ...sanitizeLabel(withDefaultRaterType(label, options.defaultRaterType)),
        studyId: target.study.studyId,
      };
      transferredLabels.push(nextLabel);
      transferredLabelSources.push({
        findingId: nextLabel.findingId,
        rater: nextLabel.rater,
        round: nextLabel.round,
        source: "transfer",
        sourceStudyId: source.study.studyId,
        sourceBundle: options.sourceBundle,
      });
      transferredKeys.add(labelKey(nextLabel));
    }
  }

  const supplementalLabels = [];
  const droppedSupplementalLabels = [];
  for (const supplementalPath of options.supplementalLabelPaths) {
    for (const label of readJsonl(supplementalPath)) {
      if (!targetIds.has(label.findingId)) {
        droppedSupplementalLabels.push({ findingId: label.findingId, path: supplementalPath });
        continue;
      }
      const nextLabel = {
        ...sanitizeLabel(withDefaultRaterType(label, options.defaultRaterType)),
        studyId: target.study.studyId,
      };
      const key = labelKey(nextLabel);
      if (transferredKeys.has(key)) {
        throw new Error(`supplemental label duplicates transferred label for ${nextLabel.findingId}/${nextLabel.rater}`);
      }
      supplementalLabels.push(nextLabel);
      transferredLabelSources.push({
        findingId: nextLabel.findingId,
        rater: nextLabel.rater,
        round: nextLabel.round,
        source: "supplemental",
        sourcePath: supplementalPath,
      });
      transferredKeys.add(key);
      transferredFindingIds.add(nextLabel.findingId);
    }
  }
  transferredLabels.push(...supplementalLabels);

  const staleSourceFindingIds = new Set(source.labels.map((label) => label.findingId).filter((findingId) => !targetIds.has(findingId)));
  const missingByRule = {};
  const transferredByRule = {};
  const targetFindingById = new Map(targetFindings.map((finding) => [finding.findingId, finding]));
  const stillMissingTargetFindings = missingTargetFindings.filter((finding) => !transferredFindingIds.has(finding.findingId));
  for (const finding of stillMissingTargetFindings) increment(missingByRule, finding.ruleId);
  for (const findingId of transferredFindingIds) {
    const finding = targetFindingById.get(findingId);
    if (finding) increment(transferredByRule, finding.ruleId);
  }
  transferredLabels.sort((left, right) => [
    left.findingId || "",
    left.round || "",
    left.role || "",
    left.rater || "",
  ].join("\0").localeCompare([
    right.findingId || "",
    right.round || "",
    right.role || "",
    right.rater || "",
  ].join("\0")));

  const report = {
    schemaVersion: "cellfence.precision-label-transfer.v1",
    generatedAt: new Date().toISOString(),
    sourceBundle: options.sourceBundle,
    targetBundle: options.targetBundle,
    sourceStudyId: source.study.studyId,
    targetStudyId: target.study.studyId,
    summary: {
      sourceLabels: source.labels.length,
      supplementalLabels: supplementalLabels.length,
      droppedSupplementalLabels: droppedSupplementalLabels.length,
      defaultRaterTypeApplied: options.defaultRaterType || null,
      targetSampledPrecisionEligibleFindings: targetFindings.length,
      transferredLabels: transferredLabels.length,
      transferredFindings: transferredFindingIds.size,
      missingTargetFindings: stillMissingTargetFindings.length,
      staleSourceFindings: staleSourceFindingIds.size,
    },
    transferredByRule,
    transferredLabelSources,
    missingByRule,
    droppedSupplementalLabels,
    missingTargetFindings: stillMissingTargetFindings.map((finding) => ({
      findingId: finding.findingId,
      subjectId: finding.subjectId,
      repository: finding.repository,
      ruleId: finding.ruleId,
      filePath: finding.filePath,
      message: finding.message,
    })),
    ok: stillMissingTargetFindings.length === 0,
  };
  writeJsonl(options.outPath, transferredLabels);
  if (options.reportPath) writeJson(options.reportPath, report);
  return report;
}

function labelKey(label) {
  const role = label.role === "adjudicator" || label.adjudication === true || label.adjudicated === true ? "adjudication" : "independent";
  return `${label.findingId}\0${label.rater}\0${role}`;
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
    const report = transferLabels(options);
    console.log(JSON.stringify(report, null, 2));
    return report.ok || options.allowPartial ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
