#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateBundle } from "./corpus-evidence-bundle.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedLabels = [
  "true_positive",
  "false_positive",
  "needs_policy",
  "needs_review",
  "invalid_setup",
  "out_of_scope",
];
const allowedRaterTypes = new Set(["human", "organization", "agent"]);
const defaultBlockingSeverities = ["error"];

function usage() {
  console.error(`Usage:
  node scripts/precision-label-worklist.mjs --bundle reports/corpus/id-bundle --out-dir reports/corpus/id-worklist --raters reviewer-a,reviewer-b --rater-types human,human [--include-rules RULE_A,RULE_B] [--blocking-severities error] [--force] [--allow-existing-labels]
  node scripts/precision-label-worklist.mjs --mode adjudication --bundle reports/corpus/id-independent-labeled-bundle --out-dir reports/corpus/id-adjudication-worklist --adjudicator reviewer-c --adjudicator-type human [--include-rules RULE_A,RULE_B] [--blocking-severities error] [--force]

Creates blind_first and blind_second assignment packages from a sealed evidence
bundle. The generated files contain evidence and label templates only; they do
not include peer labels or adjudication outcomes.

Adjudication mode creates one sealed adjudication package for each sampled
finding whose two independent blind labels disagree. It includes the independent
labels as peer evidence, but no prior adjudication outcome.`);
}

function parseArgs(argv) {
  const parsed = {
    bundleDir: "",
    outDir: "",
    raters: [],
    raterTypes: [],
    mode: "blind",
    adjudicator: "",
    adjudicatorType: "",
    includeRules: [],
    blockingSeverities: defaultBlockingSeverities,
    force: false,
    allowExistingLabels: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--bundle") {
      parsed.bundleDir = path.resolve(requireValue(argv, index, "--bundle"));
      index += 1;
    } else if (argument.startsWith("--bundle=")) {
      parsed.bundleDir = path.resolve(requireInlineValue(argument, "--bundle=", "--bundle"));
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
    } else if (argument === "--mode") {
      parsed.mode = requireValue(argv, index, "--mode");
      index += 1;
    } else if (argument.startsWith("--mode=")) {
      parsed.mode = requireInlineValue(argument, "--mode=", "--mode");
    } else if (argument === "--adjudicator") {
      parsed.adjudicator = requireValue(argv, index, "--adjudicator");
      index += 1;
    } else if (argument.startsWith("--adjudicator=")) {
      parsed.adjudicator = requireInlineValue(argument, "--adjudicator=", "--adjudicator");
    } else if (argument === "--adjudicator-type") {
      parsed.adjudicatorType = requireValue(argv, index, "--adjudicator-type");
      index += 1;
    } else if (argument.startsWith("--adjudicator-type=")) {
      parsed.adjudicatorType = requireInlineValue(argument, "--adjudicator-type=", "--adjudicator-type");
    } else if (argument === "--include-rules") {
      parsed.includeRules = parseList(requireValue(argv, index, "--include-rules"));
      index += 1;
    } else if (argument.startsWith("--include-rules=")) {
      parsed.includeRules = parseList(requireInlineValue(argument, "--include-rules=", "--include-rules"));
    } else if (argument === "--blocking-severities") {
      parsed.blockingSeverities = parseList(requireValue(argv, index, "--blocking-severities"));
      index += 1;
    } else if (argument.startsWith("--blocking-severities=")) {
      parsed.blockingSeverities = parseList(requireInlineValue(argument, "--blocking-severities=", "--blocking-severities"));
    } else if (argument === "--force") {
      parsed.force = true;
    } else if (argument === "--allow-existing-labels") {
      parsed.allowExistingLabels = true;
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.bundleDir) throw new Error("--bundle is required");
  if (!parsed.outDir) throw new Error("--out-dir is required");
  if (parsed.mode !== "blind" && parsed.mode !== "adjudication") throw new Error("--mode must be blind or adjudication");
  if (parsed.mode === "blind") {
    if (parsed.raters.length !== 2) throw new Error("--raters must name exactly two independent raters");
    if (new Set(parsed.raters).size !== parsed.raters.length) throw new Error("--raters must be distinct");
    if (parsed.raterTypes.length === 0) throw new Error("--rater-types is required; declare human, organization, or agent explicitly");
    if (parsed.raterTypes.length !== 0 && parsed.raterTypes.length !== 1 && parsed.raterTypes.length !== parsed.raters.length) {
      throw new Error("--rater-types must be one value or one value per rater");
    }
    for (const raterType of parsed.raterTypes) {
      if (!allowedRaterTypes.has(raterType)) throw new Error(`unknown --rater-types value: ${raterType}`);
    }
  } else {
    if (parsed.raters.length > 0 || parsed.raterTypes.length > 0) throw new Error("adjudication mode uses --adjudicator and --adjudicator-type, not --raters");
    if (!parsed.adjudicator) throw new Error("--adjudicator is required in adjudication mode");
    if (!parsed.adjudicatorType) throw new Error("--adjudicator-type is required in adjudication mode");
    if (!allowedRaterTypes.has(parsed.adjudicatorType)) throw new Error(`unknown --adjudicator-type value: ${parsed.adjudicatorType}`);
    parsed.raters = [parsed.adjudicator];
    parsed.raterTypes = [parsed.adjudicatorType];
    parsed.allowExistingLabels = true;
  }
  if (parsed.blockingSeverities.length === 0) throw new Error("--blocking-severities cannot be empty");
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function posixify(value) {
  return String(value).replace(/\\/g, "/").split(path.sep).join("/");
}

function isSameOrInside(parentDir, candidatePath) {
  const relativePath = path.relative(realPathForContainment(parentDir), realPathForContainment(candidatePath));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
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

function assertDisjointBundleAndOutput(bundleDir, outDir) {
  if (isSameOrInside(bundleDir, outDir) || isSameOrInside(outDir, bundleDir)) {
    throw new Error("--out-dir must not overlap --bundle; choose a separate worklist directory outside the sealed bundle");
  }
}

function portablePathHint(filePath) {
  const relativePath = path.relative(repoRoot, filePath);
  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) return posixify(relativePath);
  return posixify(path.basename(filePath));
}

function safeName(value) {
  const slug = String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "subject";
  return `${slug}-${hashText(value).slice(0, 12)}`;
}

function listFilesRecursive(baseDir) {
  const files = [];
  if (!fs.existsSync(baseDir)) return files;
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files.sort();
}

function writeSha256Sums(outDir) {
  const files = listFilesRecursive(outDir)
    .filter((filePath) => path.basename(filePath) !== "SHA256SUMS")
    .map((filePath) => posixify(path.relative(outDir, filePath)))
    .sort();
  const lines = files.map((relativePath) => `${hashFile(path.join(outDir, relativePath))}  ${relativePath}`);
  fs.writeFileSync(path.join(outDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

function artifactSetSha256(bundleDir) {
  const sumsPath = path.join(bundleDir, "SHA256SUMS");
  if (!fs.existsSync(sumsPath)) throw new Error("bundle SHA256SUMS is missing");
  return hashFile(sumsPath);
}

function raterTypeFor(options, index) {
  if (options.raterTypes.length === 1) return options.raterTypes[0];
  return options.raterTypes[index];
}

function artifactRef(bundleDir, relativePath) {
  if (!relativePath) return null;
  const artifactPath = path.join(bundleDir, relativePath);
  if (!fs.existsSync(artifactPath)) return null;
  return {
    path: posixify(relativePath),
    sha256: hashFile(artifactPath),
  };
}

function firstSubjectArtifact(study, subjectId, suffix) {
  return (study.logCopies || []).find((copy) => {
    return copy?.subjectId === subjectId && String(copy.path || "").endsWith(suffix);
  })?.path || null;
}

function evidenceArtifacts(study, bundleDir, finding) {
  const manifestCopy = (study.manifestCopies || []).find((copy) => copy?.subjectId === finding.subjectId)?.path || null;
  return {
    bundleFiles: {
      corpus: artifactRef(bundleDir, "corpus.json"),
      report: artifactRef(bundleDir, "report.json"),
      rawFindings: artifactRef(bundleDir, "findings.raw.jsonl"),
      normalizedFindings: artifactRef(bundleDir, "findings.normalized.jsonl"),
      sampledFindings: artifactRef(bundleDir, "findings.sampled.jsonl"),
      sampling: artifactRef(bundleDir, "sampling.json"),
    },
    subject: {
      manifest: artifactRef(bundleDir, manifestCopy),
      auditLog: artifactRef(bundleDir, firstSubjectArtifact(study, finding.subjectId, "check.audit.jsonl")),
      evidenceGraph: artifactRef(bundleDir, firstSubjectArtifact(study, finding.subjectId, "evidence-graph.json")),
      checkStdout: artifactRef(bundleDir, firstSubjectArtifact(study, finding.subjectId, "check.stdout.log")),
      checkStderr: artifactRef(bundleDir, firstSubjectArtifact(study, finding.subjectId, "check.stderr.log")),
    },
  };
}

function selectedFindings(findings, sampling, options) {
  const sampledIds = new Set(sampling.sampledFindingIds || []);
  const includedRules = new Set(options.includeRules);
  const severities = new Set(options.blockingSeverities);
  return findings.filter((finding) => {
    return sampledIds.has(finding.findingId)
      && finding.precisionEligible === true
      && (includedRules.size === 0 || includedRules.has(finding.ruleId))
      && severities.has(finding.severity || "error");
  });
}

function isAdjudicationLabel(label) {
  return label?.role === "adjudicator" || label?.round === "adjudication" || label?.adjudication === true || label?.adjudicated === true;
}

function independentLabelsForFinding(labels, findingId) {
  return labels.filter((label) => label?.findingId === findingId && !isAdjudicationLabel(label));
}

function sourceLabelSnapshot(label) {
  return {
    schemaVersion: label.schemaVersion || "cellfence.corpus-label.v1",
    studyId: label.studyId,
    findingId: label.findingId,
    rater: label.rater,
    raterType: label.raterType || label.raterClass || null,
    role: label.role || "independent",
    round: label.round,
    assignmentId: label.assignmentId,
    evidencePackageId: label.evidencePackageId,
    sawPeerLabels: label.sawPeerLabels,
    sourceBundleContainsLabels: label.sourceBundleContainsLabels,
    claimUse: label.claimUse,
    label: label.label,
    rationale: label.rationale || "",
  };
}

function disagreementFindings(selected, labels) {
  return selected.map((finding) => {
    const independent = independentLabelsForFinding(labels, finding.findingId);
    const blindFirst = independent.filter((label) => label.round === "blind_first");
    const blindSecond = independent.filter((label) => label.round === "blind_second");
    const labelsByValue = new Set(independent.map((label) => label.label));
    return {
      finding,
      independent,
      blindFirst,
      blindSecond,
      disagrees: blindFirst.length === 1 && blindSecond.length === 1 && labelsByValue.size > 1,
    };
  }).filter((entry) => entry.disagrees);
}

function findingEvidence(finding) {
  return {
    findingId: finding.findingId,
    subjectId: finding.subjectId || null,
    repository: finding.repository || null,
    commit: finding.commit || null,
    gitTree: finding.gitTree || null,
    manifestSha256: finding.manifestSha256 || null,
    manifestStrategy: finding.manifestStrategy || null,
    manifestReviewStatus: finding.manifestReviewStatus || null,
    ruleId: finding.ruleId,
    severity: finding.severity || "error",
    filePath: finding.filePath || null,
    line: finding.line ?? null,
    message: finding.message || "",
    cellId: finding.cellId || null,
    producerCellId: finding.producerCellId || null,
    cellfenceFingerprint: finding.cellfenceFingerprint || null,
    occurrenceIndex: finding.occurrenceIndex ?? null,
  };
}

function labelTemplate(studyId, finding, assignment, context) {
  const adjudication = assignment.round === "adjudication";
  return {
    schemaVersion: "cellfence.corpus-label.v1",
    studyId,
    findingId: finding.findingId,
    rater: assignment.rater,
    raterType: assignment.raterType,
    role: adjudication ? "adjudicator" : "independent",
    round: assignment.round,
    assignmentId: assignment.assignmentId,
    evidencePackageId: assignment.evidencePackageId,
    sawPeerLabels: adjudication ? true : false,
    sourceBundleContainsLabels: context.sourceBundleContainsLabels,
    claimUse: adjudication ? "sealed_adjudication" : context.sourceBundleContainsLabels ? "diagnostic_only_existing_labels" : "blind_labeling",
    label: "",
    rationale: "",
  };
}

function buildAssignment(study, bundleDir, bundleSha256, finding, options, index, context, sourceLabels = []) {
  const adjudication = options.mode === "adjudication";
  const round = adjudication ? "adjudication" : index === 0 ? "blind_first" : "blind_second";
  const rater = adjudication ? options.adjudicator : options.raters[index];
  const raterType = adjudication ? options.adjudicatorType : raterTypeFor(options, index);
  const evidencePackageId = `evidence-${finding.findingId.replace(/^sha256:/, "").slice(0, 16)}`;
  const assignmentId = `assignment-${hashText([study.studyId, finding.findingId, round, rater].join("\0")).slice(0, 16)}`;
  return {
    schemaVersion: "cellfence.precision-label-assignment.v1",
    studyId: study.studyId,
    bundle: {
      pathHint: portablePathHint(bundleDir),
      artifactSetSha256: bundleSha256,
      preLabelArtifactSetSha256: study.preregistration?.preLabelArtifactSetSha256 || null,
    },
    assignment: {
      assignmentId,
      evidencePackageId,
      round,
      rater,
      raterType,
      sawPeerLabels: adjudication ? true : false,
      peerLabelsIncluded: adjudication ? true : false,
      sourceBundleContainsLabels: context.sourceBundleContainsLabels,
      claimUse: adjudication ? "sealed_adjudication" : context.sourceBundleContainsLabels ? "diagnostic_only_existing_labels" : "blind_labeling",
    },
    evidenceArtifacts: evidenceArtifacts(study, bundleDir, finding),
    finding: findingEvidence(finding),
    sourceLabels,
    allowedLabels,
    labelTemplate: labelTemplate(study.studyId, finding, {
      assignmentId,
      evidencePackageId,
      round,
      rater,
      raterType,
    }, context),
  };
}

function createWorklist(options) {
  assertDisjointBundleAndOutput(options.bundleDir, options.outDir);
  validateBundle(options.bundleDir);
  const study = readJson(path.join(options.bundleDir, "study.json"));
  const sampling = readJson(path.join(options.bundleDir, "sampling.json"));
  const findings = readJsonl(path.join(options.bundleDir, "findings.normalized.jsonl"));
  const labels = readJsonl(path.join(options.bundleDir, "labels.jsonl"));
  if (options.mode === "blind" && labels.length > 0 && !options.allowExistingLabels) {
    throw new Error("bundle already contains labels; pass --allow-existing-labels only for diagnostic carry-forward worklists");
  }
  if (options.mode === "adjudication" && labels.length === 0) {
    throw new Error("adjudication mode requires an independently labeled bundle");
  }
  if (options.mode === "adjudication" && labels.some(isAdjudicationLabel)) {
    throw new Error("adjudication mode requires a pre-adjudication bundle without adjudication labels");
  }
  const sampled = selectedFindings(findings, sampling, options);
  const adjudicationEntries = options.mode === "adjudication" ? disagreementFindings(sampled, labels) : [];
  const selected = options.mode === "adjudication" ? adjudicationEntries.map((entry) => entry.finding) : sampled;
  if (selected.length === 0) throw new Error("no sampled precision-eligible findings match the worklist filters");
  if (fs.existsSync(options.outDir)) {
    if (!options.force) throw new Error(`output directory already exists: ${options.outDir}`);
    fs.rmSync(options.outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(options.outDir, { recursive: true });

  const bundleSha256 = artifactSetSha256(options.bundleDir);
  const assignmentEntries = [];
  const outputPaths = new Set();
  const context = {
    sourceBundleContainsLabels: labels.length > 0,
  };
  for (const finding of selected) {
    const rounds = options.mode === "adjudication" ? [0] : options.raters.map((_, index) => index);
    for (const index of rounds) {
      const sourceLabels = options.mode === "adjudication"
        ? (adjudicationEntries.find((entry) => entry.finding.findingId === finding.findingId)?.independent || []).map(sourceLabelSnapshot)
        : [];
      const assignment = buildAssignment(study, options.bundleDir, bundleSha256, finding, options, index, context, sourceLabels);
      const relativePath = path.join(
        "assignments",
        assignment.assignment.round,
        `${safeName(finding.subjectId || "subject")}-${safeName(finding.ruleId)}-${assignment.assignment.assignmentId.replace(/^assignment-/, "")}.json`,
      );
      const normalizedRelativePath = posixify(relativePath);
      if (outputPaths.has(normalizedRelativePath)) throw new Error(`duplicate assignment output path: ${normalizedRelativePath}`);
      outputPaths.add(normalizedRelativePath);
      writeJson(path.join(options.outDir, relativePath), assignment);
      assignmentEntries.push({
        path: normalizedRelativePath,
        assignmentId: assignment.assignment.assignmentId,
        evidencePackageId: assignment.assignment.evidencePackageId,
        findingId: finding.findingId,
        subjectId: finding.subjectId || null,
        ruleId: finding.ruleId,
        round: assignment.assignment.round,
        rater: assignment.assignment.rater,
        raterType: assignment.assignment.raterType,
      });
    }
  }

  assignmentEntries.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schemaVersion: options.mode === "adjudication" ? "cellfence.precision-label-worklist.v2" : "cellfence.precision-label-worklist.v1",
    mode: options.mode === "adjudication" ? "adjudication" : "blind_labeling",
    createdBy: "scripts/precision-label-worklist.mjs",
    studyId: study.studyId,
    bundle: {
      pathHint: portablePathHint(options.bundleDir),
      artifactSetSha256: bundleSha256,
      preLabelArtifactSetSha256: study.preregistration?.preLabelArtifactSetSha256 || null,
      createdAt: study.createdAt || null,
    },
    filters: {
      includedRules: options.includeRules,
      blockingSeverities: options.blockingSeverities,
      allowExistingLabels: options.allowExistingLabels,
    },
    raters: options.raters.map((rater, index) => ({
      rater,
      raterType: raterTypeFor(options, index),
      round: options.mode === "adjudication" ? "adjudication" : index === 0 ? "blind_first" : "blind_second",
    })),
    summary: {
      selectedFindings: selected.length,
      assignments: assignmentEntries.length,
      existingLabelsInBundle: labels.length,
      disagreements: adjudicationEntries.length,
    },
    assignments: assignmentEntries,
  };
  writeJson(path.join(options.outDir, "worklist.json"), manifest);
  writeSha256Sums(options.outDir);
  return manifest;
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
    const manifest = createWorklist(options);
    const worklistArtifactSetSha256 = hashFile(path.join(options.outDir, "SHA256SUMS"));
    console.log(JSON.stringify({
      schemaVersion: manifest.schemaVersion,
      studyId: manifest.studyId,
      outDir: posixify(options.outDir),
      artifactSetSha256: worklistArtifactSetSha256,
      mode: manifest.mode,
      raters: manifest.raters,
      summary: manifest.summary,
    }, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
