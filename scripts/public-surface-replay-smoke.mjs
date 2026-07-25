#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkDir = path.join(repoRoot, "tmp", "public-surface-replay-smoke");
const defaultOutPath = path.join(repoRoot, "reports", "public-surface-replay-smoke.json");
const defaultSubjects = 10;
const maxSubjects = 300;
const ruleId = "CELLFENCE_PUBLIC_SYMBOL_MISMATCH";

function usage() {
  console.error(`Usage: node scripts/public-surface-replay-smoke.mjs [--subjects 10] [--workdir tmp/public-surface-replay-smoke] [--out reports/public-surface-replay-smoke.json]

Creates local git fixtures whose public surface expands in one commit, replays
the before reviewed copy manifest against the after commit with reuse-before,
then freezes a rule-scoped precision next-cycle packet for
CELLFENCE_PUBLIC_SYMBOL_MISMATCH. This is synthetic mechanism validation, not
public-OSS precision evidence or a 99% claim.`);
}

function parseArgs(argv) {
  const parsed = {
    subjects: defaultSubjects,
    workDir: defaultWorkDir,
    outPath: defaultOutPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--subjects") {
      parsed.subjects = parseSubjects(requireValue(argv, index, "--subjects"));
      index += 1;
    } else if (argument.startsWith("--subjects=")) {
      parsed.subjects = parseSubjects(requireInlineValue(argument, "--subjects=", "--subjects"));
    } else if (argument === "--workdir") {
      parsed.workDir = path.resolve(requireValue(argv, index, "--workdir"));
      index += 1;
    } else if (argument.startsWith("--workdir=")) {
      parsed.workDir = path.resolve(requireInlineValue(argument, "--workdir=", "--workdir"));
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
  if (!parsed.workDir) throw new Error("--workdir requires a non-empty path");
  if (!parsed.outPath) throw new Error("--out requires a non-empty path");
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

function parseSubjects(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxSubjects) {
    throw new Error(`--subjects must be an integer from 1 to ${maxSubjects}`);
  }
  return parsed;
}

function writeFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${value}\n`);
}

function writeJson(filePath, value) {
  writeFile(filePath, JSON.stringify(value, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonl(filePath) {
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  return text.split(/\r?\n/).map((line) => JSON.parse(line));
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
      LC_ALL: "C",
      TZ: "UTC",
    },
    maxBuffer: 100 * 1024 * 1024,
    timeout: options.timeoutMs || 120_000,
  });
}

function requireStatus(result, expectedStatus, label) {
  if (result.status !== expectedStatus) {
    const detail = result.stderr || result.stdout || result.error?.message || `exit ${result.status}`;
    throw new Error(`${label} expected exit ${expectedStatus}, got ${result.status}: ${detail}`);
  }
}

function git(rootDir, args) {
  const result = run("git", args, { cwd: rootDir });
  requireStatus(result, 0, `git ${args.join(" ")}`);
  return result.stdout.trim();
}

function publicSurfaceManifest() {
  return {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      requiredRules: [ruleId],
    },
    cells: [
      {
        id: "app",
        ownedPaths: ["src/app/**"],
        publicEntry: "src/app/public.ts",
        publicSymbols: ["app"],
        consumes: [],
        producesArtifacts: [],
      },
    ],
  };
}

function createFixtureRepository(sourceDir, index) {
  fs.mkdirSync(path.join(sourceDir, "src", "app"), { recursive: true });
  git(sourceDir, ["init"]);
  git(sourceDir, ["config", "user.email", "cellfence@example.invalid"]);
  git(sourceDir, ["config", "user.name", "CellFence Public Surface Smoke"]);
  writeFile(path.join(sourceDir, "src", "app", "public.ts"), [
    `export const app = "subject-${index}";`,
  ].join("\n"));
  git(sourceDir, ["add", "."]);
  git(sourceDir, ["commit", "--quiet", "-m", "initial public surface"]);
  const beforeCommit = git(sourceDir, ["rev-parse", "HEAD"]);

  writeFile(path.join(sourceDir, "src", "app", "public.ts"), [
    `export const app = "subject-${index}";`,
    `export const newlyExported${index} = "stale manifest witness";`,
  ].join("\n"));
  git(sourceDir, ["add", "."]);
  git(sourceDir, ["commit", "--quiet", "-m", "expand public surface"]);
  const afterCommit = git(sourceDir, ["rev-parse", "HEAD"]);
  return { beforeCommit, afterCommit };
}

function createCorpus(runDir, subjectCount) {
  const corpusPath = path.join(runDir, "corpus.json");
  const manifestsDir = path.join(runDir, "manifests");
  const subjects = [];
  for (let index = 1; index <= subjectCount; index += 1) {
    const id = `public-surface-${String(index).padStart(3, "0")}`;
    const sourceDir = path.join(runDir, "sources", id);
    const { beforeCommit, afterCommit } = createFixtureRepository(sourceDir, index);
    const manifestSource = path.join(manifestsDir, `${id}.cellfence.manifest.json`);
    writeJson(manifestSource, publicSurfaceManifest());
    const manifestSha256 = hashFile(manifestSource);
    subjects.push({
      id,
      repository: sourceDir,
      beforeCommit,
      afterCommit,
      before: {
        manifest: {
          strategy: "copy",
          source: `manifests/${id}.cellfence.manifest.json`,
          reviewed: true,
          reviewStatus: "reviewed",
          review: {
            reviewerAttestations: [
              {
                id: "synthetic-public-surface-review-protocol",
                reviewerType: "organization",
                independent: true,
              },
            ],
            reviewedAt: "2026-07-25",
            reviewedManifestSha256: manifestSha256,
            scope: "synthetic public surface stale-manifest replay fixture",
            boundaryEvidence: [
              "before public entry exports only the manifest-declared app symbol",
              "after commit adds one undeclared public export and reuses the before manifest",
            ],
          },
        },
      },
      after: {
        manifest: {
          strategy: "reuse-before",
        },
      },
      expected: {
        beforeExitCode: 0,
        afterExitCode: 1,
        introducedRuleIds: [ruleId],
      },
    });
  }
  writeJson(corpusPath, {
    schemaVersion: "cellfence.history-replay.v1",
    description: "Synthetic mechanism validation for public-surface stale-manifest history replay. This is not public-OSS precision evidence.",
    selectionPolicy: {
      frozenAt: "2026-07-25T00:00:00.000Z",
      method: "deterministic local synthetic public-surface drift fixtures",
    },
    subjects,
  });
  return corpusPath;
}

function assertHistoryReport(report, expectedSubjects) {
  const failures = [];
  if (report.schemaVersion !== "cellfence.history-replay-study.v1") failures.push("unexpected history report schema");
  if (report.summary?.replayed !== expectedSubjects) failures.push(`expected ${expectedSubjects} replayed subjects`);
  if (report.summary?.singleCommitIntroductions !== expectedSubjects) failures.push(`expected ${expectedSubjects} single-commit introductions`);
  if (report.summary?.introducedFindingsByRule?.[ruleId] !== expectedSubjects) failures.push(`expected ${expectedSubjects} introduced ${ruleId} findings`);
  if (report.summary?.expectations?.passed !== expectedSubjects) failures.push("expected every replay expectation to pass");
  for (const subject of report.subjects || []) {
    if (subject.proofEligibility !== "counterfactual_candidate_requires_manual_label") failures.push(`${subject.id} is not proof eligible`);
    if (subject.after?.manifest?.strategy !== "reuse-before") failures.push(`${subject.id} did not reuse the before manifest`);
    if (subject.introducedFindingCount !== 1) failures.push(`${subject.id} should have exactly one introduced finding`);
    const finding = subject.introducedFindings?.[0];
    if (finding?.ruleId !== ruleId) failures.push(`${subject.id} introduced unexpected rule ${finding?.ruleId}`);
    if (finding?.changedFile !== true) failures.push(`${subject.id} introduced finding is not on a changed file`);
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

function assertNextCycle(cycleDir, expectedSubjects) {
  const summary = readJson(path.join(cycleDir, "summary.json"));
  const worklist = readJson(path.join(cycleDir, "blind-worklist", "worklist.json"));
  const preflight = readJson(path.join(cycleDir, "claim-preflight.prelabel.json"));
  const externalValidation = readJson(path.join(cycleDir, "reviewed-corpus-external-validation.json"));
  const findings = readJsonl(path.join(cycleDir, "bundle-unlabeled", "findings.normalized.jsonl"));
  const failures = [];
  if (JSON.stringify(summary.includedRules) !== JSON.stringify([ruleId])) failures.push("next cycle is not public-symbol scoped");
  if (worklist.summary?.selectedFindings !== expectedSubjects) failures.push(`expected ${expectedSubjects} selected findings`);
  if (worklist.summary?.assignments !== expectedSubjects * 2) failures.push("expected two blind assignments per finding");
  if (externalValidation.ok !== true) failures.push("external manifest validation should pass for the synthetic attested fixture");
  if (preflight.valid !== true) failures.push("preflight should be structurally valid");
  if (preflight.claimReady !== false) failures.push("unlabeled preflight must not be claim ready");
  if (!preflight.gateFailures?.some((failure) => failure.includes(`${ruleId} has ${expectedSubjects} selected findings`))) {
    failures.push("preflight should report the public-symbol sample deficit");
  }
  if (preflight.gateFailures?.some((failure) => failure.includes("CELLFENCE_PRIVATE_IMPORT"))) {
    failures.push("preflight should not report unrelated private-import deficits");
  }
  if (findings.length !== expectedSubjects) failures.push(`expected ${expectedSubjects} normalized findings`);
  for (const finding of findings) {
    if (finding.ruleId !== ruleId) failures.push(`${finding.findingId} has unexpected rule ${finding.ruleId}`);
    if (finding.precisionEligible !== true) failures.push(`${finding.findingId} should be precision eligible`);
    if (finding.manifestStrategy !== "reuse-before") failures.push(`${finding.findingId} should come from reuse-before`);
    if (finding.manifestReviewStatus !== "reviewed") failures.push(`${finding.findingId} should have reviewed manifest status`);
    if (finding.replay?.proofEligibility !== "counterfactual_candidate_requires_manual_label") failures.push(`${finding.findingId} replay proof eligibility is wrong`);
    if (finding.replay?.replayKind !== "single_commit_intro") failures.push(`${finding.findingId} replay kind is wrong`);
    if (finding.replay?.introducedChangedFile !== true) failures.push(`${finding.findingId} should be introduced on a changed file`);
    if (finding.replay?.beforeManifestHasExternalReviewAttestation !== true) failures.push(`${finding.findingId} should carry external manifest attestation provenance`);
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return { summary, worklist, preflight, findings };
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
    fs.mkdirSync(options.workDir, { recursive: true });
    const runDir = fs.mkdtempSync(path.join(options.workDir, "run-"));
    const cycleDir = path.join(repoRoot, "tmp", "public-surface-replay-smoke-cycles", path.basename(runDir));
    const historyReportPath = path.join(runDir, "history-report.json");
    const replayWorkDir = path.join(runDir, "replay-work");
    const corpusPath = createCorpus(runDir, options.subjects);

    let result = run(process.execPath, [
      path.join(repoRoot, "scripts", "history-replay-study.mjs"),
      "--corpus",
      corpusPath,
      "--workdir",
      replayWorkDir,
      "--out",
      historyReportPath,
      "--clone-mode",
      "full",
    ], { timeoutMs: 600_000 });
    requireStatus(result, 0, "history replay study");
    const historyReport = readJson(historyReportPath);
    assertHistoryReport(historyReport, options.subjects);

    result = run(process.execPath, [
      path.join(repoRoot, "scripts", "precision-next-cycle.mjs"),
      "--study-id",
      `public-surface-replay-smoke-${options.subjects}`,
      "--corpus",
      corpusPath,
      "--report",
      historyReportPath,
      "--out-dir",
      cycleDir,
      "--raters",
      "agent-public-surface-a,agent-public-surface-b",
      "--rater-types",
      "agent,agent",
      "--include-rules",
      ruleId,
    ], { timeoutMs: 600_000 });
    requireStatus(result, 0, "precision next cycle");
    const nextCycle = assertNextCycle(cycleDir, options.subjects);

    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    const output = {
      schemaVersion: "cellfence.public-surface-replay-smoke.v1",
      generatedAt: new Date().toISOString(),
      limitation: "synthetic mechanism validation only; not public-OSS precision evidence and not a 99% claim",
      subjects: options.subjects,
      ruleId,
      corpusPath,
      historyReportPath,
      cycleDir,
      bundleDir: path.join(cycleDir, "bundle-unlabeled"),
      blindWorklistDir: path.join(cycleDir, "blind-worklist"),
      preflightPath: path.join(cycleDir, "claim-preflight.prelabel.json"),
      history: {
        replayed: historyReport.summary.replayed,
        singleCommitIntroductions: historyReport.summary.singleCommitIntroductions,
        introducedFindingsByRule: historyReport.summary.introducedFindingsByRule,
        evidenceSetSha256: historyReport.evidenceSetSha256,
      },
      nextCycle: {
        includedRules: nextCycle.summary.includedRules,
        selectedFindings: nextCycle.worklist.summary.selectedFindings,
        assignments: nextCycle.worklist.summary.assignments,
        preflightValid: nextCycle.preflight.valid,
        claimReady: nextCycle.preflight.claimReady,
        blockers: nextCycle.summary.blockers,
        unlabeledBundleArtifactSetSha256: nextCycle.summary.digests.unlabeledBundleArtifactSetSha256,
        blindWorklistArtifactSetSha256: nextCycle.summary.digests.blindWorklistArtifactSetSha256,
      },
      normalizedFindings: nextCycle.findings.length,
    };
    writeJson(options.outPath, output);
    console.log(`public surface replay smoke passed: ${options.subjects} ${ruleId} replay finding(s) sealed into a rule-scoped next-cycle packet`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = main();
