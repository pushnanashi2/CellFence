#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const allowedLabels = new Set([
  "true_positive",
  "false_positive",
  "needs_policy",
  "needs_review",
  "invalid_setup",
  "out_of_scope",
]);

function usage() {
  console.error(`Usage: node scripts/precision-labels-validate.mjs --bundle reports/corpus/id-bundle [--min-raters 2] [--out report.json]

Validates labeling readiness before a precision claim: every sampled,
precision-eligible finding needs independent labels, disagreements need a
separate adjudicator, and label rows must be schema-valid.`);
}

function parseArgs(argv) {
  const parsed = { bundleDir: "", outPath: "", minRaters: 2 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--bundle") {
      parsed.bundleDir = path.resolve(requireValue(argv, index, "--bundle"));
      index += 1;
    } else if (argument.startsWith("--bundle=")) {
      parsed.bundleDir = path.resolve(requireInlineValue(argument, "--bundle=", "--bundle"));
    } else if (argument === "--out") {
      parsed.outPath = path.resolve(requireValue(argv, index, "--out"));
      index += 1;
    } else if (argument.startsWith("--out=")) {
      parsed.outPath = path.resolve(requireInlineValue(argument, "--out=", "--out"));
    } else if (argument === "--min-raters") {
      parsed.minRaters = Number(requireValue(argv, index, "--min-raters"));
      index += 1;
    } else if (argument.startsWith("--min-raters=")) {
      parsed.minRaters = Number(requireInlineValue(argument, "--min-raters=", "--min-raters"));
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.bundleDir) throw new Error("--bundle is required");
  if (!Number.isInteger(parsed.minRaters) || parsed.minRaters < 1) throw new Error("--min-raters must be a positive integer");
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

function isAdjudication(label) {
  return label.role === "adjudicator" || label.adjudication === true || label.adjudicated === true;
}

function increment(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function validateLabelRows(labels, studyId, knownFindingIds, issues) {
  const seen = new Set();
  for (const [index, label] of labels.entries()) {
    const line = index + 1;
    if (label.schemaVersion !== "cellfence.corpus-label.v1") issues.push(`labels.jsonl:${line} has unexpected schemaVersion`);
    if (label.studyId !== studyId) issues.push(`labels.jsonl:${line} has unexpected studyId`);
    if (!knownFindingIds.has(label.findingId)) issues.push(`labels.jsonl:${line} references unknown findingId ${label.findingId}`);
    if (!allowedLabels.has(label.label)) issues.push(`labels.jsonl:${line} has unknown label ${label.label}`);
    if (!label.rater || typeof label.rater !== "string") issues.push(`labels.jsonl:${line} is missing rater`);
    if (!label.rationale || typeof label.rationale !== "string" || label.rationale.trim().length === 0) {
      issues.push(`labels.jsonl:${line} is missing rationale`);
    }
    const duplicateKey = `${label.findingId}\0${label.rater}\0${isAdjudication(label) ? "adjudication" : "independent"}`;
    if (seen.has(duplicateKey)) issues.push(`labels.jsonl:${line} duplicates finding/rater/role label`);
    seen.add(duplicateKey);
  }
}

function validateFindingLabels(finding, labels, options) {
  const issues = [];
  const independent = labels.filter((label) => !isAdjudication(label));
  const adjudications = labels.filter(isAdjudication);
  const independentRaters = new Set(independent.map((label) => label.rater));
  if (independentRaters.size < options.minRaters) {
    issues.push(`${finding.findingId} has ${independentRaters.size} independent labels; ${options.minRaters} required`);
  }
  if (independent.length !== independentRaters.size) {
    issues.push(`${finding.findingId} has duplicate independent labels from the same rater`);
  }
  const independentLabels = new Set(independent.map((label) => label.label));
  let finalLabel = independentLabels.size === 1 ? independent[0]?.label : null;
  let adjudicated = false;
  if (independentLabels.size > 1) {
    if (adjudications.length === 0) {
      issues.push(`${finding.findingId} has conflicting independent labels and no adjudication`);
    } else {
      const adjudicationLabels = new Set(adjudications.map((label) => label.label));
      if (adjudicationLabels.size > 1) issues.push(`${finding.findingId} has conflicting adjudication labels`);
      const adjudicationRaters = new Set(adjudications.map((label) => label.rater));
      for (const rater of adjudicationRaters) {
        if (independentRaters.has(rater)) issues.push(`${finding.findingId} adjudicator ${rater} also supplied an independent label`);
      }
      finalLabel = adjudications.at(-1)?.label || null;
      adjudicated = true;
    }
  }
  return {
    findingId: finding.findingId,
    subjectId: finding.subjectId,
    ruleId: finding.ruleId,
    labels: labels.length,
    independentRaters: independentRaters.size,
    adjudicated,
    finalLabel,
    issues,
  };
}

function validateBundle(options) {
  if (!fs.existsSync(options.bundleDir)) throw new Error(`bundle not found: ${options.bundleDir}`);
  const study = readJson(path.join(options.bundleDir, "study.json"));
  const findings = readJsonl(path.join(options.bundleDir, "findings.normalized.jsonl"));
  const sampling = readJson(path.join(options.bundleDir, "sampling.json"));
  const labels = readJsonl(path.join(options.bundleDir, "labels.jsonl"));
  const issues = [];
  if (study.schemaVersion !== "cellfence.corpus-evidence-bundle.v1") issues.push("study.json has unexpected schemaVersion");
  const studyId = study.studyId;
  const knownFindingIds = new Set(findings.map((finding) => finding.findingId));
  validateLabelRows(labels, studyId, knownFindingIds, issues);

  const sampledIds = new Set(Array.isArray(sampling.sampledFindingIds) ? sampling.sampledFindingIds : []);
  const selectedFindings = findings.filter((finding) => sampledIds.has(finding.findingId) && finding.precisionEligible === true);
  const labelsByFinding = new Map();
  for (const label of labels) {
    const existing = labelsByFinding.get(label.findingId) || [];
    existing.push(label);
    labelsByFinding.set(label.findingId, existing);
  }
  const findingResults = selectedFindings.map((finding) => validateFindingLabels(finding, labelsByFinding.get(finding.findingId) || [], options));
  for (const finding of findingResults) issues.push(...finding.issues);
  const finalLabelCounts = {};
  for (const finding of findingResults) {
    if (finding.finalLabel) increment(finalLabelCounts, finding.finalLabel);
  }
  return {
    schemaVersion: "cellfence.precision-label-readiness.v1",
    generatedAt: new Date().toISOString(),
    bundleDir: options.bundleDir,
    studyId,
    minRaters: options.minRaters,
    summary: {
      sampledFindings: sampledIds.size,
      sampledPrecisionEligibleFindings: selectedFindings.length,
      labels: labels.length,
      fullyLabeledFindings: findingResults.filter((finding) => finding.issues.length === 0).length,
      adjudicatedFindings: findingResults.filter((finding) => finding.adjudicated).length,
      issues: issues.length,
      finalLabelCounts,
    },
    findings: findingResults,
    issues,
    ok: issues.length === 0,
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
    const report = validateBundle(options);
    if (options.outPath) writeJson(options.outPath, report);
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

process.exitCode = main();
