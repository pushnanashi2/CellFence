#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error(`Usage: node scripts/reviewed-corpus-validate.mjs --corpus corpus.json [--out report.json] [--external-claim]

Validates that a corpus is eligible for a reviewed-manifest precision study.
Infer-manifest onboarding corpora are intentionally rejected: they can measure
robustness and onboarding friction, but not blocking precision. With
--external-claim, manifest review attestations must identify independent
human/organization reviewers and bind the reviewed manifest SHA-256.`);
}

function parseArgs(argv) {
  const parsed = { corpusPath: "", outPath: "", externalClaim: false };
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
    } else if (argument === "--external-claim") {
      parsed.externalClaim = true;
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
  const attestations = reviewAttestations(manifest)
    .map((attestation) => attestation.id)
    .filter((id) => typeof id === "string" && id.length > 0);
  if (attestations.length > 0) return attestations;
  if (Array.isArray(manifest?.reviewedBy)) return manifest.reviewedBy;
  if (Array.isArray(manifest?.review?.reviewers)) return manifest.review.reviewers;
  return [];
}

function reviewAttestations(manifest) {
  if (Array.isArray(manifest?.review?.reviewerAttestations)) return manifest.review.reviewerAttestations;
  if (Array.isArray(manifest?.review?.reviewers) && manifest.review.reviewers.every((reviewer) => isRecord(reviewer))) {
    return manifest.review.reviewers;
  }
  return [];
}

function validateExternalReviewAttestation(subject, manifest, manifestSourceSha256, issues) {
  const prefix = subject.id || "subject";
  const review = manifest.review || {};
  const attestations = reviewAttestations(manifest);
  if (attestations.length === 0) {
    issues.push(`${prefix} external claim review requires review.reviewerAttestations with independent human/organization reviewers`);
  }
  for (const [index, attestation] of attestations.entries()) {
    const label = `${prefix} review.reviewerAttestations[${index}]`;
    const reviewerType = attestation.reviewerType || attestation.raterType || attestation.reviewerClass;
    if (typeof attestation.id !== "string" || attestation.id.length === 0) issues.push(`${label}.id is required`);
    if (reviewerType !== "human" && reviewerType !== "organization") {
      issues.push(`${label}.reviewerType must be human or organization`);
    }
    if (attestation.independent !== true) issues.push(`${label}.independent must be true`);
  }
  if (typeof review.reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(review.reviewedAt)) {
    issues.push(`${prefix} external claim review requires review.reviewedAt`);
  }
  if (typeof review.scope !== "string" || review.scope.length === 0) {
    issues.push(`${prefix} external claim review requires review.scope`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(review.reviewedManifestSha256 || ""))) {
    issues.push(`${prefix} external claim review requires review.reviewedManifestSha256`);
  } else if (manifestSourceSha256 && review.reviewedManifestSha256 !== manifestSourceSha256) {
    issues.push(`${prefix} review.reviewedManifestSha256 does not match manifest.source`);
  }
}

function isPathWithin(baseDir, candidatePath) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidatePath));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateSubject(subject, index, seenIds, corpusDir, options = {}) {
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
  let manifestSourceSha256 = "";
  let precisionEligible = false;
  if (strategy === "existing") {
    if (options.externalClaim) issues.push(`${subject.id || prefix} external claim requires a copy manifest with a hashable manifest.source`);
    precisionEligible = manifest.reviewStatus === "reviewed";
    if (!precisionEligible) issues.push(`${subject.id || prefix} existing manifest must set reviewStatus=reviewed`);
    const reviewers = reviewReaders(manifest).filter((reviewer) => typeof reviewer === "string" && reviewer.length > 0);
    if (reviewers.length === 0) issues.push(`${subject.id || prefix} reviewed existing manifest requires reviewedBy or review.reviewers`);
    if (!Array.isArray(manifest.review?.boundaryEvidence) && !Array.isArray(manifest.boundaryEvidence)) {
      warnings.push(`${subject.id || prefix} reviewed existing manifest should cite boundaryEvidence`);
    }
  } else if (strategy === "copy") {
    precisionEligible = manifest.reviewStatus === "reviewed";
    if (!precisionEligible) issues.push(`${subject.id || prefix} copy manifest must set reviewStatus=reviewed`);
    if (typeof manifest.source !== "string" || manifest.source.length === 0) {
      issues.push(`${subject.id || prefix} copy manifest requires source`);
    } else {
      const sourcePath = path.resolve(corpusDir, manifest.source);
      if (!isPathWithin(corpusDir, sourcePath)) issues.push(`${subject.id || prefix} manifest.source escapes the corpus directory`);
      else if (!fs.existsSync(sourcePath)) issues.push(`${subject.id || prefix} manifest.source not found: ${manifest.source}`);
      else manifestSourceSha256 = sha256File(sourcePath);
    }
    const reviewers = reviewReaders(manifest).filter((reviewer) => typeof reviewer === "string" && reviewer.length > 0);
    if (reviewers.length === 0) issues.push(`${subject.id || prefix} reviewed copy manifest requires reviewedBy or review.reviewers`);
    if (!Array.isArray(manifest.review?.boundaryEvidence) && !Array.isArray(manifest.boundaryEvidence)) {
      warnings.push(`${subject.id || prefix} reviewed copy manifest should cite boundaryEvidence`);
    }
  } else {
    issues.push(`${subject.id || prefix} manifest.strategy=${strategy} is not precision-eligible; use existing or reviewed copy`);
  }
  if (options.externalClaim && precisionEligible) {
    validateExternalReviewAttestation(subject, manifest, manifestSourceSha256, issues);
  }

  return {
    id: subject.id || null,
    repository: subject.repository || null,
    commit: subject.commit || null,
    manifestStrategy: strategy,
    manifestReviewStatus: manifest.reviewStatus || "unknown",
    manifestSourceSha256: manifestSourceSha256 || null,
    precisionEligible,
    issues,
    warnings,
  };
}

function validateCorpus(corpusPath, options = {}) {
  const corpus = readJson(corpusPath);
  const corpusDir = path.dirname(corpusPath);
  const issues = [];
  const warnings = [];
  if (corpus.schemaVersion !== "cellfence.corpus.v1") issues.push("corpus schemaVersion must be cellfence.corpus.v1");
  if (!Array.isArray(corpus.subjects) || corpus.subjects.length === 0) issues.push("corpus subjects must be a non-empty array");
  if (!isRecord(corpus.selectionPolicy)) warnings.push("reviewed precision corpus should include selectionPolicy");
  const seenIds = new Set();
  const subjects = Array.isArray(corpus.subjects)
    ? corpus.subjects.map((subject, index) => validateSubject(subject, index, seenIds, corpusDir, options))
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
    externalClaim: options.externalClaim === true,
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
    const report = validateCorpus(options.corpusPath, options);
    if (options.outPath) writeJson(options.outPath, report);
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

process.exitCode = main();
