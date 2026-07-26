#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateBundle } from "./corpus-evidence-bundle.mjs";
import { appearsNonHumanRater, hashFile, posixify } from "./precision-worklist-lib.mjs";

const schemaVersion = "cellfence.manifest-attestation-worklist.v1";
const assignmentSchemaVersion = "cellfence.manifest-attestation-assignment.v1";
const allowedReviewerTypes = new Set(["human", "organization"]);

function usage() {
  console.error(`Usage:
  node scripts/precision-manifest-attestation-worklist.mjs --bundle reports/corpus/id-bundle --out-dir reports/corpus/id-manifest-review-worklist --reviewers reviewer-a[,reviewer-b] --reviewer-types human[,organization] [--force]

Creates sealed per-subject manifest-review assignment packages from a sealed
evidence bundle. The generated files include manifest copy hashes and an empty
attestation template only; they do not create reviewer attestations.`);
}

function parseArgs(argv) {
  const parsed = {
    bundleDir: "",
    outDir: "",
    reviewers: [],
    reviewerTypes: [],
    force: false,
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
    } else if (argument === "--reviewers") {
      parsed.reviewers = parseList(requireValue(argv, index, "--reviewers"));
      index += 1;
    } else if (argument.startsWith("--reviewers=")) {
      parsed.reviewers = parseList(requireInlineValue(argument, "--reviewers=", "--reviewers"));
    } else if (argument === "--reviewer-types") {
      parsed.reviewerTypes = parseList(requireValue(argv, index, "--reviewer-types"));
      index += 1;
    } else if (argument.startsWith("--reviewer-types=")) {
      parsed.reviewerTypes = parseList(requireInlineValue(argument, "--reviewer-types=", "--reviewer-types"));
    } else if (argument === "--force") {
      parsed.force = true;
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.bundleDir) throw new Error("--bundle is required");
  if (!parsed.outDir) throw new Error("--out-dir is required");
  if (parsed.reviewers.length === 0) throw new Error("--reviewers is required");
  if (new Set(parsed.reviewers).size !== parsed.reviewers.length) throw new Error("--reviewers must be distinct");
  if (parsed.reviewerTypes.length !== 1 && parsed.reviewerTypes.length !== parsed.reviewers.length) {
    throw new Error("--reviewer-types must be one value or one value per reviewer");
  }
  parsed.reviewerTypes = parsed.reviewers.map((_, index) => parsed.reviewerTypes.length === 1 ? parsed.reviewerTypes[0] : parsed.reviewerTypes[index]);
  parsed.reviewers.forEach((reviewer, index) => validateReviewer(reviewer, parsed.reviewerTypes[index], `reviewer ${index + 1}`));
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

function validateReviewer(reviewer, reviewerType, label) {
  if (!reviewer || typeof reviewer !== "string") throw new Error(`${label} id is required`);
  if (appearsNonHumanRater(reviewer)) throw new Error(`${label} appears non-human`);
  if (!allowedReviewerTypes.has(reviewerType)) throw new Error(`${label} reviewer type must be human or organization`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeName(value) {
  const slug = String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "subject";
  return `${slug}-${hashText(value).slice(0, 12)}`;
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

function prepareOutputDir(outDir, force) {
  const markerPath = path.join(outDir, ".cellfence-manifest-attestation-worklist");
  if (fs.existsSync(outDir)) {
    if (!force) throw new Error(`output directory already exists: ${outDir}; pass --force to replace a CellFence manifest attestation worklist`);
    if (!fs.existsSync(markerPath)) throw new Error(`refusing to delete unmarked output directory: ${outDir}`);
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(markerPath, "cellfence manifest attestation worklist\n");
}

function listFiles(baseDir) {
  const files = [];
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath));
    else if (entry.isFile() && entry.name !== "SHA256SUMS") files.push(fullPath);
  }
  return files;
}

function writeSha256Sums(baseDir) {
  const lines = listFiles(baseDir)
    .map((filePath) => posixify(path.relative(baseDir, filePath)))
    .sort()
    .map((relativePath) => `${hashFile(path.join(baseDir, relativePath))}  ${relativePath}`);
  fs.writeFileSync(path.join(baseDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
  return hashFile(path.join(baseDir, "SHA256SUMS"));
}

function bundleArtifactSetSha256(bundleDir) {
  const sumsPath = path.join(bundleDir, "SHA256SUMS");
  if (!fs.existsSync(sumsPath)) throw new Error("bundle SHA256SUMS is missing");
  return hashFile(sumsPath);
}

function manifestCopies(study, bundleDir) {
  return new Map((study.manifestCopies || []).map((copy) => {
    const key = copy.phase ? `${copy.subjectId}\0${copy.phase}` : copy.subjectId;
    const filePath = path.join(bundleDir, copy.path);
    return [key, {
      ...copy,
      actualSha256: fs.existsSync(filePath) ? hashFile(filePath) : null,
    }];
  }));
}

function expectedSubjects(corpus) {
  if (corpus.schemaVersion === "cellfence.history-replay.v1") {
    return (corpus.subjects || []).map((subject) => ({
      subjectId: subject.id,
      phase: "before",
      repository: subject.repository,
      commit: subject.before?.commit || subject.beforeCommit || null,
    }));
  }
  return (corpus.subjects || []).map((subject) => ({
    subjectId: subject.id,
    phase: null,
    repository: subject.repository,
    commit: subject.commit || null,
  }));
}

function assignmentId(studyId, subjectId, phase, reviewer) {
  return `manifest-attestation-${hashText([studyId, subjectId, phase || "", reviewer].join("\0")).slice(0, 16)}`;
}

function createWorklist(options) {
  validateBundle(options.bundleDir);
  assertDisjointBundleAndOutput(options.bundleDir, options.outDir);
  prepareOutputDir(options.outDir, options.force);
  const study = readJson(path.join(options.bundleDir, "study.json"));
  const corpus = readJson(path.join(options.bundleDir, "corpus.json"));
  const bundleHash = bundleArtifactSetSha256(options.bundleDir);
  const copies = manifestCopies(study, options.bundleDir);
  const reviewers = options.reviewers.map((reviewer, index) => ({
    id: reviewer,
    reviewerType: options.reviewerTypes[index],
  }));
  const assignments = [];

  for (const subject of expectedSubjects(corpus)) {
    const key = subject.phase ? `${subject.subjectId}\0${subject.phase}` : subject.subjectId;
    const copy = copies.get(key);
    if (!copy || !copy.actualSha256) throw new Error(`sealed manifest copy is missing for ${posixify(key)}`);
    for (const reviewer of reviewers) {
      const id = assignmentId(study.studyId, subject.subjectId, subject.phase, reviewer.id);
      const relativePath = posixify(path.join(
        "assignments",
        `${safeName(subject.subjectId)}-${subject.phase || "manifest"}-${safeName(reviewer.id)}.json`,
      ));
      const assignment = {
        schemaVersion: assignmentSchemaVersion,
        studyId: study.studyId,
        bundle: {
          pathHint: posixify(path.basename(options.bundleDir)),
          artifactSetSha256: bundleHash,
        },
        assignment: {
          assignmentId: id,
          subjectId: subject.subjectId,
          phase: subject.phase,
          reviewer: reviewer.id,
          reviewerType: reviewer.reviewerType,
          claimUse: "external_manifest_review",
        },
        subject: {
          subjectId: subject.subjectId,
          phase: subject.phase,
          repository: subject.repository || null,
          commit: subject.commit || null,
        },
        manifestCopy: {
          path: copy.path,
          sha256: copy.actualSha256,
        },
        attestationTemplate: {
          subjectId: subject.subjectId,
          ...(subject.phase ? { phase: subject.phase } : {}),
          repository: subject.repository || null,
          commit: subject.commit || null,
          manifestCopy: {
            path: copy.path,
            sha256: copy.actualSha256,
          },
          reviewStatus: "reviewed",
          review: {
            reviewedAt: "YYYY-MM-DD",
            scope: "package/workspace boundary manifest review",
            reviewedManifestSha256: copy.actualSha256,
            reviewerAttestations: [
              {
                id: reviewer.id,
                reviewerType: reviewer.reviewerType,
                independent: true,
              },
            ],
          },
        },
      };
      writeJson(path.join(options.outDir, relativePath), assignment);
      assignments.push({
        path: relativePath,
        assignmentId: id,
        subjectId: subject.subjectId,
        phase: subject.phase,
        reviewer: reviewer.id,
        reviewerType: reviewer.reviewerType,
      });
    }
  }

  const worklist = {
    schemaVersion,
    createdAt: new Date().toISOString(),
    studyId: study.studyId,
    bundle: {
      pathHint: posixify(path.basename(options.bundleDir)),
      artifactSetSha256: bundleHash,
    },
    reviewers,
    summary: {
      subjects: expectedSubjects(corpus).length,
      reviewers: reviewers.length,
      assignments: assignments.length,
    },
    assignments,
  };
  writeJson(path.join(options.outDir, "worklist.json"), worklist);
  const artifactSetSha256 = writeSha256Sums(options.outDir);
  return {
    schemaVersion: "cellfence.manifest-attestation-worklist-report.v1",
    ok: true,
    outDir: posixify(options.outDir),
    studyId: study.studyId,
    artifactSetSha256,
    summary: worklist.summary,
  };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = createWorklist(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exit(2);
  }
}

main();
