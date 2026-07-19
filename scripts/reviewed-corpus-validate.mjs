#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error(`Usage: node scripts/reviewed-corpus-validate.mjs --corpus corpus.json [--out report.json]

Validates that a corpus is eligible for a reviewed-manifest precision study.
Infer-manifest onboarding corpora are intentionally rejected: they can measure
robustness and onboarding friction, but not blocking precision.`);
}

function parseArgs(argv) {
  const parsed = { corpusPath: "", outPath: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") {
      parsed.corpusPath = path.resolve(requireValue(argv, index, "--corpus"));
      index += 1;
    } else if (argument.startsWith("--corpus=")) {
      parsed.corpusPath = path.resolve(requireInlineValue(argument, "--corpus=", "--corpus"));
    } else if (argument === "--out") {
      parsed.outPath = path.resolve(requireValue(argv, index, "--out"));
      index += 1;
    } else if (argument.startsWith("--out=")) {
      parsed.outPath = path.resolve(requireInlineValue(argument, "--out=", "--out"));
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.corpusPath) throw new Error("--corpus is required");
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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function isExactCommit(value) {
  return /^[a-f0-9]{40}$/i.test(String(value || ""));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reviewReaders(manifest) {
  if (Array.isArray(manifest?.reviewedBy)) return manifest.reviewedBy;
  if (Array.isArray(manifest?.review?.reviewers)) return manifest.review.reviewers;
  return [];
}

function isPathWithin(baseDir, candidatePath) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidatePath));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateSubject(subject, index, seenIds, corpusDir) {
  const issues = [];
  const warnings = [];
  const prefix = `subjects[${index}]`;
  if (!isRecord(subject)) {
    return {
      id: null,
      precisionEligible: false,
      manifestStrategy: "unknown",
      issues: [`${prefix} must be an object`],
      warnings,
    };
  }
  if (typeof subject.id !== "string" || subject.id.length === 0) issues.push(`${prefix}.id is required`);
  if (subject.id && seenIds.has(subject.id)) issues.push(`duplicate subject id: ${subject.id}`);
  if (subject.id) seenIds.add(subject.id);
  if (typeof subject.repository !== "string" || subject.repository.length === 0) issues.push(`${prefix}.repository is required`);
  if (!isExactCommit(subject.commit)) issues.push(`${subject.id || prefix} commit must be an exact 40-hex commit`);

  const manifest = subject.manifest || {};
  const strategy = manifest.strategy || "existing";
  let precisionEligible = false;
  if (strategy === "existing") {
    precisionEligible = manifest.reviewStatus === undefined
      || manifest.reviewStatus === "existing"
      || manifest.reviewStatus === "reviewed";
    if (!precisionEligible) issues.push(`${subject.id || prefix} existing manifest reviewStatus must not be ${manifest.reviewStatus}`);
    if (manifest.reviewStatus === undefined) warnings.push(`${subject.id || prefix} uses existing upstream manifest without explicit reviewStatus`);
  } else if (strategy === "copy") {
    precisionEligible = manifest.reviewStatus === "reviewed";
    if (!precisionEligible) issues.push(`${subject.id || prefix} copy manifest must set reviewStatus=reviewed`);
    if (typeof manifest.source !== "string" || manifest.source.length === 0) {
      issues.push(`${subject.id || prefix} copy manifest requires source`);
    } else {
      const sourcePath = path.resolve(corpusDir, manifest.source);
      if (!isPathWithin(corpusDir, sourcePath)) issues.push(`${subject.id || prefix} manifest.source escapes the corpus directory`);
      else if (!fs.existsSync(sourcePath)) issues.push(`${subject.id || prefix} manifest.source not found: ${manifest.source}`);
    }
    const reviewers = reviewReaders(manifest).filter((reviewer) => typeof reviewer === "string" && reviewer.length > 0);
    if (reviewers.length === 0) issues.push(`${subject.id || prefix} reviewed copy manifest requires reviewedBy or review.reviewers`);
    if (!Array.isArray(manifest.review?.boundaryEvidence) && !Array.isArray(manifest.boundaryEvidence)) {
      warnings.push(`${subject.id || prefix} reviewed copy manifest should cite boundaryEvidence`);
    }
  } else {
    issues.push(`${subject.id || prefix} manifest.strategy=${strategy} is not precision-eligible; use existing or reviewed copy`);
  }

  return {
    id: subject.id || null,
    repository: subject.repository || null,
    commit: subject.commit || null,
    manifestStrategy: strategy,
    manifestReviewStatus: manifest.reviewStatus || (strategy === "existing" ? "existing" : "unknown"),
    precisionEligible,
    issues,
    warnings,
  };
}

function validateCorpus(corpusPath) {
  const corpus = readJson(corpusPath);
  const corpusDir = path.dirname(corpusPath);
  const issues = [];
  const warnings = [];
  if (corpus.schemaVersion !== "cellfence.corpus.v1") issues.push("corpus schemaVersion must be cellfence.corpus.v1");
  if (!Array.isArray(corpus.subjects) || corpus.subjects.length === 0) issues.push("corpus subjects must be a non-empty array");
  if (!isRecord(corpus.selectionPolicy)) warnings.push("reviewed precision corpus should include selectionPolicy");
  const seenIds = new Set();
  const subjects = Array.isArray(corpus.subjects)
    ? corpus.subjects.map((subject, index) => validateSubject(subject, index, seenIds, corpusDir))
    : [];
  for (const subject of subjects) {
    issues.push(...subject.issues);
    warnings.push(...subject.warnings);
  }
  return {
    schemaVersion: "cellfence.reviewed-corpus-validation.v1",
    generatedAt: new Date().toISOString(),
    corpusPath,
    corpusSha256: sha256File(corpusPath),
    summary: {
      subjects: subjects.length,
      precisionEligibleSubjects: subjects.filter((subject) => subject.precisionEligible && subject.issues.length === 0).length,
      ineligibleSubjects: subjects.filter((subject) => !subject.precisionEligible || subject.issues.length > 0).length,
      issues: issues.length,
      warnings: warnings.length,
    },
    subjects,
    issues,
    warnings,
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
    const report = validateCorpus(options.corpusPath);
    if (options.outPath) writeJson(options.outPath, report);
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

process.exitCode = main();
