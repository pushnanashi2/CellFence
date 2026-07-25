#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error(`Usage:
  node scripts/precision-corpus-promote-candidates.mjs --current-corpus docs/research/corpora/current.json --candidate-corpus docs/research/corpora/candidates.json --candidate-bundle reports/corpus/candidate-bundle --expansion-plan reports/corpus/plan.json --out-corpus docs/research/corpora/next.json (--top 10 | --subjects subject-a,subject-b) [--report report.json] [--markdown report.md] [--force]

Copies diagnostic candidate manifests into a frozen reviewed-corpus work queue.
This records an agent review and candidate provenance, but it does not create
external human/organization labels and does not make infer-derived findings
public-claim-ready until the promoted corpus is rerun and independently labeled.`);
}

function parseArgs(argv) {
  const parsed = {
    currentCorpusPath: "",
    candidateCorpusPath: "",
    candidateBundleDir: "",
    expansionPlanPath: "",
    outCorpusPath: "",
    manifestDir: "",
    reportPath: "",
    markdownPath: "",
    subjects: [],
    top: null,
    reviewer: "codex-agent-reviewer",
    reviewedAt: new Date().toISOString().slice(0, 10),
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--current-corpus") {
      parsed.currentCorpusPath = path.resolve(requireValue(argv, index, "--current-corpus"));
      index += 1;
    } else if (argument.startsWith("--current-corpus=")) {
      parsed.currentCorpusPath = path.resolve(requireInlineValue(argument, "--current-corpus=", "--current-corpus"));
    } else if (argument === "--candidate-corpus") {
      parsed.candidateCorpusPath = path.resolve(requireValue(argv, index, "--candidate-corpus"));
      index += 1;
    } else if (argument.startsWith("--candidate-corpus=")) {
      parsed.candidateCorpusPath = path.resolve(requireInlineValue(argument, "--candidate-corpus=", "--candidate-corpus"));
    } else if (argument === "--candidate-bundle") {
      parsed.candidateBundleDir = path.resolve(requireValue(argv, index, "--candidate-bundle"));
      index += 1;
    } else if (argument.startsWith("--candidate-bundle=")) {
      parsed.candidateBundleDir = path.resolve(requireInlineValue(argument, "--candidate-bundle=", "--candidate-bundle"));
    } else if (argument === "--expansion-plan") {
      parsed.expansionPlanPath = path.resolve(requireValue(argv, index, "--expansion-plan"));
      index += 1;
    } else if (argument.startsWith("--expansion-plan=")) {
      parsed.expansionPlanPath = path.resolve(requireInlineValue(argument, "--expansion-plan=", "--expansion-plan"));
    } else if (argument === "--out-corpus") {
      parsed.outCorpusPath = path.resolve(requireValue(argv, index, "--out-corpus"));
      index += 1;
    } else if (argument.startsWith("--out-corpus=")) {
      parsed.outCorpusPath = path.resolve(requireInlineValue(argument, "--out-corpus=", "--out-corpus"));
    } else if (argument === "--manifest-dir") {
      parsed.manifestDir = path.resolve(requireValue(argv, index, "--manifest-dir"));
      index += 1;
    } else if (argument.startsWith("--manifest-dir=")) {
      parsed.manifestDir = path.resolve(requireInlineValue(argument, "--manifest-dir=", "--manifest-dir"));
    } else if (argument === "--report") {
      parsed.reportPath = path.resolve(requireValue(argv, index, "--report"));
      index += 1;
    } else if (argument.startsWith("--report=")) {
      parsed.reportPath = path.resolve(requireInlineValue(argument, "--report=", "--report"));
    } else if (argument === "--markdown") {
      parsed.markdownPath = path.resolve(requireValue(argv, index, "--markdown"));
      index += 1;
    } else if (argument.startsWith("--markdown=")) {
      parsed.markdownPath = path.resolve(requireInlineValue(argument, "--markdown=", "--markdown"));
    } else if (argument === "--subjects") {
      parsed.subjects = parseList(requireValue(argv, index, "--subjects"));
      index += 1;
    } else if (argument.startsWith("--subjects=")) {
      parsed.subjects = parseList(requireInlineValue(argument, "--subjects=", "--subjects"));
    } else if (argument === "--top") {
      parsed.top = parsePositiveInteger(requireValue(argv, index, "--top"), "--top");
      index += 1;
    } else if (argument.startsWith("--top=")) {
      parsed.top = parsePositiveInteger(requireInlineValue(argument, "--top=", "--top"), "--top");
    } else if (argument === "--reviewer") {
      parsed.reviewer = requireValue(argv, index, "--reviewer");
      index += 1;
    } else if (argument.startsWith("--reviewer=")) {
      parsed.reviewer = requireInlineValue(argument, "--reviewer=", "--reviewer");
    } else if (argument === "--reviewed-at") {
      parsed.reviewedAt = requireValue(argv, index, "--reviewed-at");
      index += 1;
    } else if (argument.startsWith("--reviewed-at=")) {
      parsed.reviewedAt = requireInlineValue(argument, "--reviewed-at=", "--reviewed-at");
    } else if (argument === "--force") {
      parsed.force = true;
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.currentCorpusPath) throw new Error("--current-corpus is required");
  if (!parsed.candidateCorpusPath) throw new Error("--candidate-corpus is required");
  if (!parsed.candidateBundleDir) throw new Error("--candidate-bundle is required");
  if (!parsed.expansionPlanPath) throw new Error("--expansion-plan is required");
  if (!parsed.outCorpusPath) throw new Error("--out-corpus is required");
  if (parsed.subjects.length > 0 && parsed.top !== null) throw new Error("use either --subjects or --top, not both");
  if (parsed.subjects.length === 0 && parsed.top === null) throw new Error("one of --subjects or --top is required");
  if (!/^\d{4}-\d{2}-\d{2}/.test(parsed.reviewedAt)) throw new Error("--reviewed-at must start with YYYY-MM-DD");
  if (parsed.reviewer.length === 0) throw new Error("--reviewer must not be empty");
  if (path.resolve(path.dirname(parsed.outCorpusPath)) !== path.resolve(path.dirname(parsed.currentCorpusPath))) {
    throw new Error("--out-corpus must be in the same directory as --current-corpus so existing manifest.source paths remain valid");
  }
  if (!parsed.manifestDir) {
    parsed.manifestDir = path.join(
      path.dirname(parsed.outCorpusPath),
      "manifests",
      path.basename(parsed.outCorpusPath, path.extname(parsed.outCorpusPath)),
    );
  }
  if (!isPathInsideOrEqual(path.dirname(parsed.outCorpusPath), parsed.manifestDir)) {
    throw new Error("--manifest-dir must be inside the output corpus directory");
  }
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

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function posixify(value) {
  return String(value).replace(/\\/g, "/").split(path.sep).join("/");
}

function relativePosix(fromDir, toPath) {
  return posixify(path.relative(fromDir, toPath));
}

function normalizedRepositoryKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

function safeFileStem(value) {
  const stem = String(value || "subject").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return stem || "subject";
}

function isPathWithin(baseDir, candidatePath) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidatePath));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isPathInsideOrEqual(baseDir, candidatePath) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidatePath));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readCandidateSubjects(candidateCorpusPath) {
  const corpus = readJson(candidateCorpusPath);
  const subjects = new Map();
  for (const subject of corpus.subjects || []) subjects.set(subject.id, subject);
  return subjects;
}

function readManifestCopies(candidateBundleDir) {
  const studyPath = path.join(candidateBundleDir, "study.json");
  const study = readJson(studyPath);
  const copies = new Map();
  for (const copy of study.manifestCopies || []) copies.set(copy.subjectId, copy);
  return copies;
}

function expansionCandidates(expansionPlanPath) {
  const plan = readJson(expansionPlanPath);
  const candidates = new Map();
  for (const candidate of plan.candidatePool?.topCandidates || []) candidates.set(candidate.subjectId, candidate);
  return { plan, candidates };
}

function selectedSubjectIds(options, candidates) {
  if (options.subjects.length > 0) return [...options.subjects];
  return [...candidates.keys()].slice(0, options.top);
}

function assertNoDuplicatePromotion(currentCorpus, selectedSubjects) {
  const ids = new Set();
  const repositories = new Set();
  for (const subject of currentCorpus.subjects || []) {
    if (subject.id) ids.add(subject.id);
    const repositoryKey = normalizedRepositoryKey(subject.repository);
    if (repositoryKey) repositories.add(repositoryKey);
  }
  const duplicateMessages = [];
  const selectedIds = new Set();
  const selectedRepositories = new Set();
  for (const subject of selectedSubjects) {
    if (selectedIds.has(subject.id)) duplicateMessages.push(`${subject.id} is selected more than once`);
    if (subject.id) selectedIds.add(subject.id);
    if (ids.has(subject.id)) duplicateMessages.push(`${subject.id} already exists in current corpus`);
    const repositoryKey = normalizedRepositoryKey(subject.repository);
    if (repositoryKey && repositories.has(repositoryKey)) duplicateMessages.push(`${subject.id} repository already exists in current corpus: ${subject.repository}`);
    if (repositoryKey && selectedRepositories.has(repositoryKey)) duplicateMessages.push(`${subject.id} repository is selected more than once: ${subject.repository}`);
    if (repositoryKey) selectedRepositories.add(repositoryKey);
  }
  if (duplicateMessages.length > 0) throw new Error(duplicateMessages.join("; "));
}

function copyCandidateManifest(options, copy, subjectId) {
  if (!copy?.path) throw new Error(`${subjectId} has no manifest copy in the candidate bundle`);
  const sourcePath = path.resolve(options.candidateBundleDir, copy.path);
  if (!isPathWithin(options.candidateBundleDir, sourcePath)) throw new Error(`${subjectId} manifest copy escapes the candidate bundle: ${copy.path}`);
  if (!fs.existsSync(sourcePath)) throw new Error(`${subjectId} manifest copy not found: ${copy.path}`);
  const sourceText = fs.readFileSync(sourcePath, "utf8");
  const sourceSha256 = sha256Buffer(Buffer.from(sourceText));
  if (copy.sha256 && copy.sha256 !== sourceSha256) {
    throw new Error(`${subjectId} manifest copy SHA-256 mismatch: expected ${copy.sha256}, got ${sourceSha256}`);
  }
  JSON.parse(sourceText);
  const targetPath = path.join(options.manifestDir, `${safeFileStem(subjectId)}.cellfence.manifest.json`);
  if (fs.existsSync(targetPath) && !options.force && sha256File(targetPath) !== sourceSha256) {
    throw new Error(`${subjectId} target manifest already exists with different content: ${targetPath}`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, sourceText.endsWith("\n") ? sourceText : `${sourceText}\n`);
  return {
    sourcePath,
    targetPath,
    sourceSha256,
    targetSha256: sha256File(targetPath),
  };
}

function promotedSubject(options, candidateSubject, candidateRow, manifestCopyResult) {
  const corpusDir = path.dirname(options.outCorpusPath);
  return {
    id: candidateSubject.id,
    repository: candidateSubject.repository,
    commit: candidateSubject.commit,
    metadata: {
      ...(candidateSubject.metadata || {}),
      languageScope: candidateSubject.metadata?.languageScope || "TypeScript/JavaScript",
      reviewedManifestSource: "promoted-diagnostic-candidate-manifest",
      promotionSource: {
        expansionPlan: relativePosix(corpusDir, options.expansionPlanPath),
        candidateCorpus: relativePosix(corpusDir, options.candidateCorpusPath),
        candidateBundle: relativePosix(corpusDir, options.candidateBundleDir),
        candidateManifestCopy: relativePosix(corpusDir, manifestCopyResult.sourcePath),
        candidateManifestSha256: manifestCopyResult.sourceSha256,
        diagnosticSampledCountsByRule: candidateRow?.sampledCountsByRule || {},
        diagnosticTotalCountsByRule: candidateRow?.totalCountsByRule || {},
        projectionReliability: candidateRow?.projectionReliability || "diagnostic_candidate_sampling_only_recompute_after_promotion",
      },
    },
    manifest: {
      strategy: "copy",
      source: relativePosix(corpusDir, manifestCopyResult.targetPath),
      reviewStatus: "reviewed",
      reviewedBy: [options.reviewer],
      review: {
        reviewers: [options.reviewer],
        reviewedAt: options.reviewedAt,
        boundaryEvidence: [
          "diagnostic production-scope control manifest",
          "fixed repository URL and exact commit pin",
          "manifest copy frozen before promoted corpus rerun",
        ],
        limitation: "Single-agent reviewed candidate promotion. This is suitable for the next diagnostic reviewed-corpus cycle only; it is not external-human/org attested and must not be used for a public 99% precision claim until independently reviewed, rerun, and labeled.",
      },
    },
  };
}

function promotedCorpusDescription(promotedCount) {
  return `TS/JS reviewed-corpus work queue promoted from a diagnostic expansion plan. It adds ${promotedCount} candidate subject${promotedCount === 1 ? "" : "s"} with copied, single-agent-reviewed manifests. It is not external-claim-ready and must not be described as a passed 99% precision claim.`;
}

function selectedCandidateRow(candidates, subjectId) {
  const candidate = candidates.get(subjectId);
  if (!candidate) {
    throw new Error(`${subjectId} is not present in the expansion plan topCandidates; rerun the expansion plan or choose a listed subject`);
  }
  return candidate;
}

function buildPromotedCorpus(options) {
  const currentCorpus = readJson(options.currentCorpusPath);
  const candidateSubjects = readCandidateSubjects(options.candidateCorpusPath);
  const manifestCopies = readManifestCopies(options.candidateBundleDir);
  const { plan, candidates } = expansionCandidates(options.expansionPlanPath);
  const ids = selectedSubjectIds(options, candidates);
  if (ids.length === 0) throw new Error("no candidate subjects selected");

  const selectedSubjects = ids.map((id) => {
    const subject = candidateSubjects.get(id);
    if (!subject) throw new Error(`${id} not found in candidate corpus`);
    if (!/^[a-f0-9]{40}$/i.test(String(subject.commit || ""))) throw new Error(`${id} commit must be an exact 40-hex commit`);
    return subject;
  });
  assertNoDuplicatePromotion(currentCorpus, selectedSubjects);

  const promoted = [];
  for (const subject of selectedSubjects) {
    const candidateRow = selectedCandidateRow(candidates, subject.id);
    const copyResult = copyCandidateManifest(options, manifestCopies.get(subject.id), subject.id);
    promoted.push({
      subject,
      candidateRow,
      manifestCopy: {
        source: relativePosix(path.dirname(options.outCorpusPath), copyResult.sourcePath),
        target: relativePosix(path.dirname(options.outCorpusPath), copyResult.targetPath),
        sha256: copyResult.targetSha256,
      },
      promotedSubject: promotedSubject(options, subject, candidateRow, copyResult),
    });
  }

  const selectionPolicy = {
    date: options.reviewedAt,
    source: "Agent-reviewed promotion from a frozen precision corpus expansion plan.",
    constraints: [
      "exact 40-hex commit pins",
      "static CellFence checks only",
      "no dependency install and no target package scripts",
      "exclude repositories already present in the source corpus",
      "candidate subjects must be present in expansionPlan.candidatePool.topCandidates",
      "candidate manifests are copied into docs before the promoted corpus is rerun",
      "diagnostic candidate sampled counts must be recomputed after promotion and repository-cap pruning",
    ],
    manifestReview: "Promoted manifests are copied from production-scope control manifests and marked as single-agent reviewed for the next diagnostic run. They are not external-claim-ready until independent human/organization manifest review attestations bind each reviewedManifestSha256.",
    limitation: "This corpus is an agent-reviewed work queue. It does not add non-agent labels and must not be described as a passed 99% precision claim.",
    promotion: {
      schemaVersion: "cellfence.precision-corpus-promotion.v1",
      sourceCorpus: relativePosix(path.dirname(options.outCorpusPath), options.currentCorpusPath),
      expansionPlan: relativePosix(path.dirname(options.outCorpusPath), options.expansionPlanPath),
      candidateCorpus: relativePosix(path.dirname(options.outCorpusPath), options.candidateCorpusPath),
      candidateBundle: relativePosix(path.dirname(options.outCorpusPath), options.candidateBundleDir),
      promotedSubjects: promoted.map((entry) => entry.subject.id),
      reviewer: options.reviewer,
      limitation: "Agent-reviewed promotion only; external human/organization labels and manifest attestations remain required for public claim use.",
      sourceCorpusSelectionPolicy: currentCorpus.selectionPolicy
        ? "Source corpus selectionPolicy was intentionally not copied wholesale because its workload constraints may not apply to this promotion round."
        : null,
    },
  };

  return {
    plan,
    corpus: {
      schemaVersion: currentCorpus.schemaVersion || "cellfence.corpus.v1",
      description: promotedCorpusDescription(promoted.length),
      selectionPolicy,
      subjects: [
        ...(currentCorpus.subjects || []),
        ...promoted.map((entry) => entry.promotedSubject),
      ],
    },
    promoted,
  };
}

function reportFor(options, result) {
  const corpusSha256 = sha256Buffer(Buffer.from(`${JSON.stringify(result.corpus, null, 2)}\n`));
  return {
    schemaVersion: "cellfence.precision-corpus-promotion.v1",
    generatedAt: new Date().toISOString(),
    inputs: {
      currentCorpus: posixify(options.currentCorpusPath),
      candidateCorpus: posixify(options.candidateCorpusPath),
      candidateBundle: posixify(options.candidateBundleDir),
      expansionPlan: posixify(options.expansionPlanPath),
      outCorpus: posixify(options.outCorpusPath),
      manifestDir: posixify(options.manifestDir),
    },
    summary: {
      previousSubjects: (readJson(options.currentCorpusPath).subjects || []).length,
      promotedSubjects: result.promoted.length,
      outputSubjects: (result.corpus.subjects || []).length,
      outputCorpusSha256: corpusSha256,
      externalClaimReady: false,
    },
    promotedSubjects: result.promoted.map((entry) => ({
      subjectId: entry.subject.id,
      repository: entry.subject.repository,
      commit: entry.subject.commit,
      manifestSource: entry.manifestCopy.target,
      manifestSha256: entry.manifestCopy.sha256,
      diagnosticSampledCountsByRule: entry.candidateRow?.sampledCountsByRule || {},
      diagnosticTotalCountsByRule: entry.candidateRow?.totalCountsByRule || {},
      projectionReliability: entry.candidateRow?.projectionReliability || "diagnostic_candidate_sampling_only_recompute_after_promotion",
    })),
    limitations: [
      "Promoted manifests are copied and agent-reviewed, not externally attested.",
      "Diagnostic sampled counts are not claim-ready projections; rerun research:corpus and precision:next-cycle after promotion.",
      "External human/organization labels and review.reviewedManifestSha256 attestations remain required before a public 99% precision claim.",
    ],
  };
}

function renderMarkdown(report) {
  const lines = [
    "# Precision Corpus Promotion",
    "",
    `Generated: \`${report.generatedAt}\``,
    "",
    "## Summary",
    "",
    `- Previous subjects: ${report.summary.previousSubjects}`,
    `- Promoted subjects: ${report.summary.promotedSubjects}`,
    `- Output subjects: ${report.summary.outputSubjects}`,
    `- External claim ready: ${report.summary.externalClaimReady}`,
    `- Output corpus SHA-256: \`${report.summary.outputCorpusSha256}\``,
    "",
    "## Promoted Subjects",
    "",
    "| Subject | Diagnostic sampled rules | Manifest SHA-256 |",
    "| --- | --- | --- |",
  ];
  for (const subject of report.promotedSubjects) {
    lines.push(`| \`${subject.subjectId}\` | \`${JSON.stringify(subject.diagnosticSampledCountsByRule)}\` | \`${subject.manifestSha256}\` |`);
  }
  lines.push("", "## Limitations", "");
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
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
    const result = buildPromotedCorpus(options);
    writeJson(options.outCorpusPath, result.corpus);
    const report = reportFor(options, result);
    if (options.reportPath) writeJson(options.reportPath, report);
    if (options.markdownPath) writeText(options.markdownPath, renderMarkdown(report));
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = main();
