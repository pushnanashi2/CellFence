#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile, labelRaterType, validateClaimLabelMetadata, verifyWorklistLabels } from "./precision-worklist-lib.mjs";

function usage() {
  console.error(`Usage:
  node scripts/precision-label-transfer.mjs --source-bundle reports/corpus/old-bundle --target-bundle reports/corpus/new-bundle --out labels.jsonl [--target-worklist reports/corpus/new-worklist ...] [--supplemental-labels labels.jsonl] [--default-rater-type agent] [--strict-claim-labels] [--report report.json] [--allow-partial]

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
    targetWorklistDirs: [],
    defaultRaterType: "",
    strictClaimLabels: false,
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
    } else if (argument === "--target-worklist") {
      parsed.targetWorklistDirs.push(path.resolve(requireValue(argv, index, "--target-worklist")));
      index += 1;
    } else if (argument.startsWith("--target-worklist=")) {
      parsed.targetWorklistDirs.push(path.resolve(requireInlineValue(argument, "--target-worklist=", "--target-worklist")));
    } else if (argument === "--default-rater-type") {
      parsed.defaultRaterType = requireValue(argv, index, "--default-rater-type");
      index += 1;
    } else if (argument.startsWith("--default-rater-type=")) {
      parsed.defaultRaterType = requireInlineValue(argument, "--default-rater-type=", "--default-rater-type");
    } else if (argument === "--strict-claim-labels") {
      parsed.strictClaimLabels = true;
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
  "worklistArtifactSetSha256",
  "sawPeerLabels",
  "sourceBundleContainsLabels",
  "claimUse",
  "label",
  "rationale",
  "adjudication",
  "adjudicated",
]);
const allowedLabels = new Set([
  "true_positive",
  "false_positive",
  "needs_policy",
  "needs_review",
  "invalid_setup",
  "out_of_scope",
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

function isAdjudication(label) {
  return label?.role === "adjudicator" || label?.round === "adjudication" || label?.adjudication === true || label?.adjudicated === true;
}

function assignmentKey(label) {
  const role = isAdjudication(label) ? "adjudicator" : "independent";
  return `${label.findingId}\0${label.rater}\0${label.round}\0${role}`;
}

function readTargetWorklistAssignments(worklistDirs, target, labelIssues) {
  const assignments = new Map();
  const worklists = [];
  if (!target.artifactSetSha256) {
    labelIssues.push(`target bundle ${target.bundleDir}: SHA256SUMS is missing; cannot verify target worklist bundle binding`);
  }
  for (const worklistDir of worklistDirs) {
    const verification = verifyWorklistLabels(worklistDir, target.labels, {
      bundleDir: target.bundleDir,
      findings: target.findings,
      studyId: target.study.studyId,
      bundleArtifactSetSha256: target.artifactSetSha256,
      preLabelArtifactSetSha256: target.study.preregistration?.preLabelArtifactSetSha256,
    });
    for (const issue of verification.issues) {
      labelIssues.push(`target worklist ${worklistDir}: ${issue}`);
    }
    const sumsPath = path.join(worklistDir, "SHA256SUMS");
    const manifestPath = path.join(worklistDir, "worklist.json");
    const artifactSetSha256 = verification.artifactSetSha256 || (fs.existsSync(sumsPath) ? hashFile(sumsPath) : null);
    if (!artifactSetSha256) {
      labelIssues.push(`target worklist ${worklistDir}: SHA256SUMS is missing`);
    }
    if (!fs.existsSync(manifestPath)) {
      worklists.push({
        path: worklistDir,
        artifactSetSha256,
        assignments: 0,
        rounds: verification.rounds,
      });
      continue;
    }
    const manifest = readJson(manifestPath);
    worklists.push({
      path: worklistDir,
      artifactSetSha256,
      assignments: Array.isArray(manifest.assignments) ? manifest.assignments.length : 0,
      rounds: verification.rounds,
    });
    if (verification.issues.length > 0 || !artifactSetSha256) continue;
    for (const entry of manifest.assignments || []) {
      const assignmentPath = path.resolve(worklistDir, entry.path || "");
      const relativeAssignmentPath = path.relative(worklistDir, assignmentPath);
      if (!relativeAssignmentPath || relativeAssignmentPath.startsWith("..") || path.isAbsolute(relativeAssignmentPath)) {
        labelIssues.push(`target worklist ${worklistDir}: unsafe assignment path ${entry.path || "<missing>"}`);
        continue;
      }
      const assignment = readJson(assignmentPath);
      const template = assignment.labelTemplate || {};
      const key = assignmentKey(template);
      if (assignments.has(key)) {
        labelIssues.push(`target worklist ${worklistDir}: duplicate assignment for ${template.findingId}/${template.rater}/${template.round}`);
        continue;
      }
      assignments.set(key, {
        artifactSetSha256,
        template,
      });
    }
  }
  return { assignments, worklists };
}

function rebindLabelToTargetWorklist(label, worklistIndex, labelIssues, stats, location) {
  if (!worklistIndex) return label;
  const assignment = worklistIndex.assignments.get(assignmentKey(label));
  if (!assignment) {
    stats.missingAssignments += 1;
    labelIssues.push(`${location} has no target worklist assignment for ${label.findingId}/${label.rater}/${label.round}`);
    return label;
  }
  const template = assignment.template;
  const nextLabel = {
    ...label,
    schemaVersion: template.schemaVersion,
    studyId: template.studyId,
    findingId: template.findingId,
    rater: template.rater,
    raterType: template.raterType,
    role: template.role,
    round: template.round,
    assignmentId: template.assignmentId,
    evidencePackageId: template.evidencePackageId,
    worklistArtifactSetSha256: assignment.artifactSetSha256,
    sawPeerLabels: template.sawPeerLabels,
    sourceBundleContainsLabels: template.sourceBundleContainsLabels,
    claimUse: template.claimUse,
  };
  stats.reboundLabels += 1;
  if (
    label.assignmentId !== nextLabel.assignmentId
    || label.evidencePackageId !== nextLabel.evidencePackageId
    || label.worklistArtifactSetSha256 !== nextLabel.worklistArtifactSetSha256
  ) {
    stats.rewrittenLabels += 1;
  }
  return nextLabel;
}

function validateStrictClaimLabel(label, location, issues) {
  validateClaimLabelMetadata(label, 1, issues, { location, sealedWorklist: true });
  if (label.schemaVersion !== "cellfence.corpus-label.v1") issues.push(`${location} has unexpected schemaVersion`);
  if (!label.findingId || typeof label.findingId !== "string") issues.push(`${location}.findingId is required`);
  if (!label.rater || typeof label.rater !== "string") issues.push(`${location}.rater is required`);
  if (!label.assignmentId || typeof label.assignmentId !== "string") issues.push(`${location}.assignmentId is required`);
  if (!label.evidencePackageId || typeof label.evidencePackageId !== "string") issues.push(`${location}.evidencePackageId is required`);
  if (!allowedLabels.has(label.label)) issues.push(`${location}.label must be one of ${[...allowedLabels].join(", ")}`);
  if (!label.rationale || typeof label.rationale !== "string" || label.rationale.trim().length === 0) {
    issues.push(`${location}.rationale is required`);
  }
  if (!labelRaterType(label)) issues.push(`${location}.raterType is required`);
  if (isAdjudication(label)) {
    if (label.round !== "adjudication") issues.push(`${location}.round must be adjudication`);
  } else if (label.round !== "blind_first" && label.round !== "blind_second") {
    issues.push(`${location}.round must be blind_first or blind_second`);
  }
}

function readBundle(bundleDir) {
  return {
    bundleDir,
    artifactSetSha256: fs.existsSync(path.join(bundleDir, "SHA256SUMS")) ? hashFile(path.join(bundleDir, "SHA256SUMS")) : null,
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
  const worklistRebindingStats = {
    enabled: options.targetWorklistDirs.length > 0,
    targetWorklists: options.targetWorklistDirs.length,
    reboundLabels: 0,
    rewrittenLabels: 0,
    missingAssignments: 0,
  };
  const targetFindings = sampledPrecisionEligibleFindings(target);
  const targetIds = new Set(targetFindings.map((finding) => finding.findingId));
  const sourceLabelsByFinding = groupBy(source.labels, (label) => label.findingId);
  const transferredLabels = [];
  const transferredLabelSources = [];
  const transferredKeys = new Set();
  const transferredFindingIds = new Set();
  const missingTargetFindings = [];
  const labelIssues = [];
  if (options.strictClaimLabels && options.targetWorklistDirs.length === 0) {
    labelIssues.push("--strict-claim-labels requires --target-worklist so transferred labels are rebound to sealed target assignments");
  }
  const targetWorklistIndex = options.targetWorklistDirs.length > 0
    ? readTargetWorklistAssignments(options.targetWorklistDirs, target, labelIssues)
    : null;

  for (const finding of targetFindings) {
    const labels = sourceLabelsByFinding.get(finding.findingId) || [];
    if (labels.length === 0) {
      missingTargetFindings.push(finding);
      continue;
    }
    transferredFindingIds.add(finding.findingId);
    for (const label of labels) {
      const sourceLabel = {
        ...sanitizeLabel(withDefaultRaterType(label, options.defaultRaterType)),
        studyId: target.study.studyId,
      };
      if (options.strictClaimLabels) {
        validateStrictClaimLabel(sourceLabel, `source transferred label ${finding.findingId}/${label.rater}`, labelIssues);
      }
      const nextLabel = rebindLabelToTargetWorklist(
        sourceLabel,
        targetWorklistIndex,
        labelIssues,
        worklistRebindingStats,
        `transferred label ${finding.findingId}/${label.rater}`,
      );
      transferredLabels.push(nextLabel);
      if (options.strictClaimLabels) {
        validateStrictClaimLabel(nextLabel, `transferred label ${nextLabel.findingId}/${nextLabel.rater}`, labelIssues);
      }
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
      const sourceLabel = {
        ...sanitizeLabel(withDefaultRaterType(label, options.defaultRaterType)),
        studyId: target.study.studyId,
      };
      if (options.strictClaimLabels) {
        validateStrictClaimLabel(sourceLabel, `source supplemental label ${label.findingId}/${label.rater}`, labelIssues);
      }
      const nextLabel = rebindLabelToTargetWorklist(
        sourceLabel,
        targetWorklistIndex,
        labelIssues,
        worklistRebindingStats,
        `supplemental label ${label.findingId}/${label.rater}`,
      );
      const key = labelKey(nextLabel);
      if (transferredKeys.has(key)) {
        throw new Error(`supplemental label duplicates transferred label for ${nextLabel.findingId}/${nextLabel.rater}`);
      }
      supplementalLabels.push(nextLabel);
      if (options.strictClaimLabels) {
        validateStrictClaimLabel(nextLabel, `supplemental label ${nextLabel.findingId}/${nextLabel.rater}`, labelIssues);
      }
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
      labelIssues: labelIssues.length,
      worklistRebinding: worklistRebindingStats,
    },
    targetWorklists: targetWorklistIndex ? targetWorklistIndex.worklists : [],
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
    labelIssues,
    ok: stillMissingTargetFindings.length === 0 && labelIssues.length === 0,
  };
  if (labelIssues.length === 0) writeJsonl(options.outPath, transferredLabels);
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
    return report.ok || (options.allowPartial && report.summary.labelIssues === 0) ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
