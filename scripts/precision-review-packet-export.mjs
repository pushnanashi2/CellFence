#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const markerFileName = ".cellfence-precision-review-packet";
const schemaVersion = "cellfence.precision-review-packet.v1";
const copiedCycleFiles = [
  ".cellfence-precision-next-cycle",
  "SUMMARY.md",
  "summary.json",
  "reviewed-corpus-validation.json",
  "reviewed-corpus-external-validation.json",
  "protocol.worklist.json",
  "protocol.prelabel-preflight.json",
  "claim-preflight.prelabel.json",
];
const copiedBundleFiles = [
  "corpus.json",
  "study.json",
  "report.json",
  "sampling.json",
  "findings.sampled.jsonl",
  "labels.jsonl",
];
const excludedSourceBundleFiles = [
  "findings.raw.jsonl",
  "findings.normalized.jsonl",
  "logs/",
];

function usage() {
  console.error(`Usage:
  node scripts/precision-review-packet-export.mjs --round-dir reports/corpus/id-cycle --manifest-worklist-dir reports/corpus/id-manifest-attestation-worklist --out-dir docs/research/review-packets/id [--gap-worklist reports/corpus/id-gap-worklist.json] [--gap-markdown reports/corpus/id-gap-worklist.md] [--force]

Exports a compact, git-trackable review packet from a precision next-cycle
directory. The packet includes sealed blind labeling assignments, selected
finding evidence, manifest copies, manifest-attestation assignments, protocols,
and digests. It intentionally excludes large raw logs and unsampled findings.`);
}

function parseArgs(argv) {
  const parsed = {
    roundDir: "",
    manifestWorklistDir: "",
    gapWorklistPath: "",
    gapMarkdownPath: "",
    outDir: "",
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--round-dir") {
      parsed.roundDir = path.resolve(requireValue(argv, index, "--round-dir"));
      index += 1;
    } else if (argument.startsWith("--round-dir=")) {
      parsed.roundDir = path.resolve(requireInlineValue(argument, "--round-dir=", "--round-dir"));
    } else if (argument === "--manifest-worklist-dir") {
      parsed.manifestWorklistDir = path.resolve(requireValue(argv, index, "--manifest-worklist-dir"));
      index += 1;
    } else if (argument.startsWith("--manifest-worklist-dir=")) {
      parsed.manifestWorklistDir = path.resolve(requireInlineValue(argument, "--manifest-worklist-dir=", "--manifest-worklist-dir"));
    } else if (argument === "--gap-worklist") {
      parsed.gapWorklistPath = path.resolve(requireValue(argv, index, "--gap-worklist"));
      index += 1;
    } else if (argument.startsWith("--gap-worklist=")) {
      parsed.gapWorklistPath = path.resolve(requireInlineValue(argument, "--gap-worklist=", "--gap-worklist"));
    } else if (argument === "--gap-markdown") {
      parsed.gapMarkdownPath = path.resolve(requireValue(argv, index, "--gap-markdown"));
      index += 1;
    } else if (argument.startsWith("--gap-markdown=")) {
      parsed.gapMarkdownPath = path.resolve(requireInlineValue(argument, "--gap-markdown=", "--gap-markdown"));
    } else if (argument === "--out-dir") {
      parsed.outDir = path.resolve(requireValue(argv, index, "--out-dir"));
      index += 1;
    } else if (argument.startsWith("--out-dir=")) {
      parsed.outDir = path.resolve(requireInlineValue(argument, "--out-dir=", "--out-dir"));
    } else if (argument === "--force") {
      parsed.force = true;
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.roundDir) throw new Error("--round-dir is required");
  if (!parsed.manifestWorklistDir) throw new Error("--manifest-worklist-dir is required");
  if (!parsed.outDir) throw new Error("--out-dir is required");
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

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`);
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function hashText(value, length = 16) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, length);
}

function posixify(value) {
  return String(value).replace(/\\/g, "/").split(path.sep).join("/");
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

function isInside(parentDir, candidatePath) {
  const relative = path.relative(parentDir, candidatePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertSafeOutDir(outDir) {
  const resolved = realPathForContainment(outDir);
  const allowedRoots = [
    realPathForContainment(path.join(repoRoot, "docs", "research", "review-packets")),
    realPathForContainment(path.join(repoRoot, "tmp")),
  ];
  if (!allowedRoots.some((root) => isInside(root, resolved))) {
    throw new Error("--out-dir must be inside docs/research/review-packets/ or tmp/");
  }
  if (allowedRoots.includes(resolved)) throw new Error(`unsafe --out-dir: ${outDir}`);
}

function markerPath(outDir) {
  return path.join(outDir, markerFileName);
}

function prepareOutDir(outDir, force) {
  assertSafeOutDir(outDir);
  if (fs.existsSync(outDir)) {
    const stat = fs.lstatSync(outDir);
    if (!stat.isDirectory()) throw new Error(`output path exists and is not a directory: ${outDir}`);
    if (!force) throw new Error(`output directory already exists: ${outDir}`);
    if (!fs.existsSync(markerPath(outDir))) throw new Error(`refusing to delete unmarked output directory: ${outDir}`);
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });
  writeText(markerPath(outDir), "cellfence precision review packet\n");
}

function requireFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`required file is missing: ${filePath}`);
}

function requireDir(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) throw new Error(`required directory is missing: ${dirPath}`);
}

function copyFile(srcRoot, relativePath, destRoot) {
  const sourcePath = path.join(srcRoot, relativePath);
  requireFile(sourcePath);
  const destinationPath = path.join(destRoot, relativePath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

function copyAbsoluteFile(sourcePath, destinationPath) {
  requireFile(sourcePath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

function copyDirectory(srcDir, destDir) {
  requireDir(srcDir);
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true, dereference: false, errorOnExist: false });
}

function writeJsonl(filePath, values) {
  writeText(filePath, values.map((value) => JSON.stringify(value)).join("\n"));
}

function compactBlindRound(round) {
  if (round === "blind_first") return "bf";
  if (round === "blind_second") return "bs";
  return hashText(round || "round", 8);
}

function compactBlindAssignmentPath(assignment) {
  const assignmentId = typeof assignment.assignmentId === "string" ? assignment.assignmentId : "";
  const suffix = assignmentId.startsWith("assignment-") ? assignmentId.slice("assignment-".length) : "";
  const stableId = suffix && /^[a-f0-9]{12,}$/i.test(suffix)
    ? suffix.slice(0, 16)
    : hashText([
      assignment.path,
      assignment.assignmentId,
      assignment.findingId,
      assignment.rater,
    ].join("\0"));
  return `assignments/${compactBlindRound(assignment.round)}/a-${stableId}.json`;
}

function compactManifestAssignmentPath(assignment) {
  return `assignments/m/m-${hashText([
    assignment.path,
    assignment.assignmentId,
    assignment.subjectId,
    assignment.reviewer,
  ].join("\0"))}.json`;
}

function copyCompactWorklist(srcDir, destDir, compactPathForAssignment) {
  requireDir(srcDir);
  fs.mkdirSync(destDir, { recursive: true });
  const sourceWorklist = readJson(path.join(srcDir, "worklist.json"));
  copyFile(srcDir, "worklist.json", destDir);
  fs.renameSync(path.join(destDir, "worklist.json"), path.join(destDir, "source-worklist.json"));
  if (fs.existsSync(path.join(srcDir, "SHA256SUMS"))) {
    copyFile(srcDir, "SHA256SUMS", destDir);
    fs.renameSync(path.join(destDir, "SHA256SUMS"), path.join(destDir, "source-SHA256SUMS"));
  }
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith(".cellfence-")) copyFile(srcDir, entry.name, destDir);
  }
  const pathMap = [];
  const compactAssignments = [];
  const usedPaths = new Set();
  for (const assignment of sourceWorklist.assignments || []) {
    const sourceRelativePath = assignment.path;
    if (!sourceRelativePath || sourceRelativePath.startsWith("../") || path.isAbsolute(sourceRelativePath)) {
      throw new Error(`unsafe assignment path in ${srcDir}: ${sourceRelativePath}`);
    }
    let compactPath = compactPathForAssignment(assignment);
    if (usedPaths.has(compactPath)) {
      const parsed = path.parse(compactPath);
      compactPath = path.join(parsed.dir, `${parsed.name}-${hashText(sourceRelativePath, 8)}${parsed.ext}`);
    }
    usedPaths.add(compactPath);
    copyFile(srcDir, sourceRelativePath, destDir);
    fs.mkdirSync(path.dirname(path.join(destDir, compactPath)), { recursive: true });
    fs.renameSync(path.join(destDir, sourceRelativePath), path.join(destDir, compactPath));
    pathMap.push({
      assignmentId: assignment.assignmentId,
      sourcePath: posixify(sourceRelativePath),
      packetPath: posixify(compactPath),
    });
    compactAssignments.push({
      ...assignment,
      sourcePath: posixify(sourceRelativePath),
      path: posixify(compactPath),
    });
  }
  writeJson(path.join(destDir, "worklist.json"), {
    ...sourceWorklist,
    pathMode: "compact",
    sourceWorklistPath: "source-worklist.json",
    assignments: compactAssignments,
  });
  writeJsonl(path.join(destDir, "path-map.jsonl"), pathMap);
  writeSha256Sums(destDir);
}

function redactLocalAbsolutePaths(baseDir) {
  const redactionTargets = [
    repoRoot,
    posixify(repoRoot),
    JSON.stringify(repoRoot).slice(1, -1),
    JSON.stringify(posixify(repoRoot)).slice(1, -1),
  ]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => right.length - left.length);
  for (const filePath of listFilesRecursive(baseDir)) {
    const extension = path.extname(filePath);
    if (!new Set([".json", ".jsonl", ".md", ".txt"]).has(extension) && path.basename(filePath) !== markerFileName) continue;
    const text = fs.readFileSync(filePath, "utf8");
    let redacted = text;
    for (const target of redactionTargets) redacted = redacted.split(target).join("<cellfence-repo>");
    redacted = redacted.replace(/<cellfence-repo>[^"'\r\n`]*/g, (match) => match.replace(/\\\\/g, "/").replace(/\\/g, "/"));
    if (redacted !== text) fs.writeFileSync(filePath, redacted);
  }
}

function listFilesRecursive(baseDir) {
  const files = [];
  if (!fs.existsSync(baseDir)) return files;
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function writeSha256Sums(baseDir) {
  const lines = listFilesRecursive(baseDir)
    .map((filePath) => posixify(path.relative(baseDir, filePath)))
    .filter((relativePath) => relativePath !== "SHA256SUMS")
    .sort()
    .map((relativePath) => `${hashFile(path.join(baseDir, relativePath))}  ${relativePath}`);
  writeText(path.join(baseDir, "SHA256SUMS"), lines.join("\n"));
  return hashFile(path.join(baseDir, "SHA256SUMS"));
}

function countJsonl(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const text = fs.readFileSync(filePath, "utf8").trim();
  return text ? text.split(/\r?\n/).length : 0;
}

function uniqueSelectedFindings(worklist) {
  const findingsById = new Map();
  for (const assignment of worklist.assignments || []) {
    if (!assignment.findingId) continue;
    if (!findingsById.has(assignment.findingId)) findingsById.set(assignment.findingId, assignment);
  }
  return [...findingsById.values()];
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort());
}

function repositoryBalanceTopSubjects(selectedBySubject, selectedFindings) {
  return Object.entries(selectedBySubject || {})
    .sort((left, right) => (right[1] - left[1]) || left[0].localeCompare(right[0]))
    .slice(0, 10)
    .map(([subjectId, findings]) => ({
      subjectId,
      findings,
      contribution: selectedFindings ? findings / selectedFindings : null,
    }));
}

function writeReadme(outDir, metadata) {
  const lines = [
    `# ${metadata.studyId} Review Packet`,
    "",
    "This packet is a compact, git-trackable external review packet for the",
    "reviewed TS/JS boundary-core precision study. It gives outside reviewers",
    "the exact blind label assignments, selected finding records, manifest",
    "copies, manifest-attestation assignments, protocols, and digests needed to",
    "return labels or manifest attestations.",
    "",
    "It is not a final precision claim. At export time the blocking gates remain:",
    "",
    `- external human/org finding labels: 0/${metadata.selectedFindings}`,
    `- external manifest attestations: 0/${metadata.manifestSubjects}`,
    `- source bundle dirty: ${metadata.sourceBundleDirty}`,
    "",
    "The packet intentionally excludes large raw artifacts:",
    "",
    ...metadata.excludedSourceBundleFiles.map((entry) => `- \`source-bundle/${entry}\``),
    "",
    "Reviewers should use the assignment's repository URL, exact commit, file",
    "path, line, copied manifest, and finding text. Full raw logs remain local",
    "diagnostic artifacts and are not required for returned label validation.",
    "",
    "## Included Paths",
    "",
    "- `blind-worklist/`: sealed blind labeling worklist and per-rater assignments.",
    "- `manifest-attestation-worklist/`: per-subject manifest review assignment templates.",
    "- `source-bundle/`: compact selected evidence and manifest copies from the unlabeled bundle.",
    "- `cycle/`: next-cycle summaries, protocols, preflight output, and validation reports.",
    ...(metadata.gapWorklist?.json ? ["- `cycle/gap-worklist.json`: remaining evidence tasks for the clean preflight."] : []),
    "- `EXTERNAL_REVIEW_REQUEST.md`: reviewer prompt for human/org review or non-claim agent triage.",
    "- `review-packet.json`: packet metadata.",
    "- `SHA256SUMS`: digest list for the exported packet.",
    "",
    "## Current Scope",
    "",
    `- claim profile: \`${metadata.claimProfile || "custom"}\``,
    `- included rules: \`${metadata.includedRules.join(",")}\``,
    `- selected findings: ${metadata.selectedFindings}`,
    `- blind assignments: ${metadata.blindAssignments}`,
    `- manifest subjects: ${metadata.manifestSubjects}`,
    `- manifest assignments: ${metadata.manifestAssignments}`,
    `- source unlabeledBundleArtifactSetSha256: \`${metadata.sourceDigests.unlabeledBundleArtifactSetSha256 || "n/a"}\``,
    `- source blindWorklistArtifactSetSha256: \`${metadata.sourceDigests.blindWorklistArtifactSetSha256 || "n/a"}\``,
    "- exported packet digest: run `sha256sum SHA256SUMS` from this directory.",
    "",
    "Agent-only labels can be useful for non-claim triage, but they must remain",
    "outside the external human/org claim lane.",
  ];
  writeText(path.join(outDir, "README.md"), lines.join("\n"));
}

function writeExternalReviewRequest(outDir, metadata) {
  const lines = [
    `# External Review Request: ${metadata.studyId}`,
    "",
    "Please review the CellFence external review packet in this directory.",
    "",
    "Scope:",
    "",
    `- Claim profile: ${metadata.claimProfile || "custom"}`,
    `- Included rules: ${metadata.includedRules.join(",")}`,
    `- Selected findings: ${metadata.selectedFindings}`,
    `- Blind assignments: ${metadata.blindAssignments}`,
    `- Manifest attestation assignments: ${metadata.manifestAttestation.assignments}`,
    `- Source bundle harness commit: ${metadata.source.harnessCommit}`,
    `- Source bundle harness dirty: ${metadata.source.harnessDirty}`,
    "",
    "Finding labeling task:",
    "",
    "1. Open only your assigned files under `blind-worklist/assignments/`.",
    "2. Do not inspect peer labels, adjudication output, or aggregate outcomes before labeling.",
    "3. For each assignment, inspect the embedded `finding`, the copied manifest under `source-bundle/manifests/`, and the pinned upstream repository commit named in the assignment.",
    "4. Return one JSONL label per assignment by filling the assignment's `labelTemplate`.",
    "5. Allowed labels are `true_positive`, `false_positive`, `needs_policy`, `needs_review`, `invalid_setup`, and `out_of_scope`.",
    "6. If the repository, commit, manifest, or code path cannot be inspected, do not guess; use `needs_review` or `invalid_setup` with a concrete rationale.",
    "",
    "Manifest attestation task:",
    "",
    "1. Open your assigned files under `manifest-attestation-worklist/assignments/`.",
    "2. Compare the copied manifest against the pinned upstream repository's package/workspace boundaries, package names, exports/entry points, and declared workspace dependencies.",
    "3. Return an attestation only when the reviewed manifest hash matches the assignment and the reviewer is willing to attest the stated review scope.",
    "",
    "Important claim-lane rules:",
    "",
    "- A language model or automated agent is not an external human/org reviewer.",
    "- Agent output is useful only for non-claim triage unless a separate protocol explicitly accepts it.",
    "- Do not mark `raterType` as `human` or `organization` unless that is literally true.",
    "- Do not claim the 99% precision gate is satisfied from this packet alone; the packet currently has no returned external labels or manifest attestations.",
    "- Do not open issues or pull requests against upstream repositories from this review.",
  ];
  writeText(path.join(outDir, "EXTERNAL_REVIEW_REQUEST.md"), lines.join("\n"));
}

function createReviewPacket(options) {
  const bundleDir = path.join(options.roundDir, "bundle-unlabeled");
  const blindWorklistDir = path.join(options.roundDir, "blind-worklist");
  requireDir(options.roundDir);
  requireDir(bundleDir);
  requireDir(blindWorklistDir);
  requireDir(options.manifestWorklistDir);
  for (const relativePath of copiedCycleFiles) copyFile(options.roundDir, relativePath, path.join(options.outDir, "cycle"));
  if (options.gapWorklistPath) copyAbsoluteFile(options.gapWorklistPath, path.join(options.outDir, "cycle", "gap-worklist.json"));
  if (options.gapMarkdownPath) copyAbsoluteFile(options.gapMarkdownPath, path.join(options.outDir, "cycle", "gap-worklist.md"));
  for (const relativePath of copiedBundleFiles) copyFile(bundleDir, relativePath, path.join(options.outDir, "source-bundle"));
  copyDirectory(path.join(bundleDir, "manifests"), path.join(options.outDir, "source-bundle", "manifests"));
  copyCompactWorklist(blindWorklistDir, path.join(options.outDir, "blind-worklist"), compactBlindAssignmentPath);
  copyCompactWorklist(
    options.manifestWorklistDir,
    path.join(options.outDir, "manifest-attestation-worklist"),
    compactManifestAssignmentPath,
  );
  redactLocalAbsolutePaths(options.outDir);

  const summary = readJson(path.join(options.roundDir, "summary.json"));
  const study = readJson(path.join(bundleDir, "study.json"));
  const blindWorklist = readJson(path.join(blindWorklistDir, "worklist.json"));
  const manifestWorklist = readJson(path.join(options.manifestWorklistDir, "worklist.json"));
  const selectedFindings = uniqueSelectedFindings(blindWorklist);
  const selectedByRule = countBy(selectedFindings, (finding) => finding.ruleId);
  const selectedBySubject = countBy(selectedFindings, (finding) => finding.subjectId);
  const metadata = {
    schemaVersion,
    exportedAt: new Date().toISOString(),
    exportedBy: "scripts/precision-review-packet-export.mjs",
    studyId: summary.studyId || study.studyId || blindWorklist.studyId,
    claimProfile: summary.claimProfile || null,
    claimProfileDescription: summary.claimProfileDescription || null,
    includedRules: summary.includedRules || [],
    source: {
      roundDir: posixify(path.relative(repoRoot, options.roundDir)),
      manifestWorklistDir: posixify(path.relative(repoRoot, options.manifestWorklistDir)),
      harnessCommit: study.environment?.harnessCommit || null,
      harnessDirty: study.environment?.harnessDirty ?? null,
      corpusSha256: study.environment?.corpusSha256 || null,
    },
    sourceDigests: summary.digests || {},
    selectedFindings: blindWorklist.summary?.selectedFindings || selectedFindings.length,
    blindAssignments: (blindWorklist.assignments || []).length,
    selectedByRule,
    selectedBySubject,
    topSubjects: repositoryBalanceTopSubjects(selectedBySubject, blindWorklist.summary?.selectedFindings || selectedFindings.length),
    sourceBundle: {
      sampledFindingsJsonl: countJsonl(path.join(bundleDir, "findings.sampled.jsonl")),
      manifestCopies: Array.isArray(study.manifestCopies) ? study.manifestCopies.length : 0,
      excludedFiles: excludedSourceBundleFiles,
    },
    manifestAttestation: {
      subjects: manifestWorklist.summary?.subjects || 0,
      assignments: manifestWorklist.summary?.assignments || (manifestWorklist.assignments || []).length,
      artifactSetSha256: fs.existsSync(path.join(options.manifestWorklistDir, "SHA256SUMS"))
        ? hashFile(path.join(options.manifestWorklistDir, "SHA256SUMS"))
        : null,
    },
    gapWorklist: {
      json: options.gapWorklistPath ? {
        path: "cycle/gap-worklist.json",
        sha256: hashFile(options.gapWorklistPath),
      } : null,
      markdown: options.gapMarkdownPath ? {
        path: "cycle/gap-worklist.md",
        sha256: hashFile(options.gapMarkdownPath),
      } : null,
    },
    blockers: summary.blockers || [],
  };
  writeJson(path.join(options.outDir, "review-packet.json"), metadata);
  writeReadme(options.outDir, {
    ...metadata,
    sourceBundleDirty: metadata.source.harnessDirty,
    manifestSubjects: metadata.manifestAttestation.subjects,
    manifestAssignments: metadata.manifestAttestation.assignments,
    excludedSourceBundleFiles,
  });
  writeExternalReviewRequest(options.outDir, metadata);
  const finalPacketSha256SumsSha256 = writeSha256Sums(options.outDir);
  return {
    ...metadata,
    packetSha256SumsSha256: finalPacketSha256SumsSha256,
    outDir: posixify(path.relative(repoRoot, options.outDir)),
  };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    prepareOutDir(options.outDir, options.force);
    const result = createReviewPacket(options);
    console.log(JSON.stringify({
      ok: true,
      outDir: result.outDir,
      studyId: result.studyId,
      selectedFindings: result.selectedFindings,
      blindAssignments: result.blindAssignments,
      manifestSubjects: result.manifestAttestation.subjects,
      manifestAssignments: result.manifestAttestation.assignments,
      packetSha256SumsSha256: result.packetSha256SumsSha256,
      sourceHarnessCommit: result.source.harnessCommit,
      sourceHarnessDirty: result.source.harnessDirty,
    }, null, 2));
    return 0;
  } catch (error) {
    if (!options) usage();
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

process.exitCode = main();
