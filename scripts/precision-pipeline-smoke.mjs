#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkDir = path.join(repoRoot, "tmp", "precision-pipeline-smoke");
const defaultOutPath = path.join(repoRoot, "reports", "precision-pipeline-smoke.json");
const studyId = "precision-pipeline-smoke";

function usage() {
  console.error(`Usage: node scripts/precision-pipeline-smoke.mjs [--workdir tmp/precision-pipeline-smoke] [--out reports/precision-pipeline-smoke.json]

Builds a tiny local corpus report, freezes an evidence bundle, adds independent
labels, validates the bundle, and evaluates a pre-registered precision claim.
The expected claim decision is insufficient_evidence because the sample is
intentionally tiny; passing the smoke means the evidence pipeline is wired.`);
}

function parseArgs(argv) {
  const parsed = {
    workDir: defaultWorkDir,
    outPath: defaultOutPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workdir") {
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

function writeFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${value}\n`);
}

function writeJson(filePath, value) {
  writeFile(filePath, JSON.stringify(value, null, 2));
}

function writeJsonl(filePath, values) {
  writeFile(filePath, values.map((value) => JSON.stringify(value)).join("\n"));
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

function createFixture(runDir) {
  const subjectDir = path.join(runDir, "subjects", "reviewed-demo");
  const manifestPath = path.join(subjectDir, "control", "cellfence.manifest.json");
  const auditLogPath = path.join(subjectDir, "logs", "check.audit.jsonl");
  const corpusPath = path.join(runDir, "corpus.json");
  const reportPath = path.join(runDir, "corpus-report.json");

  writeJson(manifestPath, {
    schemaVersion: "cellfence.manifest.v1",
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
      requiredRules: [
        "CELLFENCE_PRIVATE_IMPORT",
        "CELLFENCE_UNDECLARED_CONSUMER",
      ],
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
      {
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["core"],
        consumes: [],
        producesArtifacts: [],
      },
    ],
  });
  writeJsonl(auditLogPath, [
    {
      schemaVersion: "cellfence.audit-event.v1",
      runId: "precision-smoke",
      timestamp: "2026-07-19T00:00:00.000Z",
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      event: "finding.detected",
      command: "check",
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      severity: "error",
      cellId: "app",
      producerCellId: "core",
      filePath: "src/app/leak.ts",
      line: 1,
      message: "private import",
      fingerprint: "precision-smoke-private-import",
      outcome: "rejected",
    },
    {
      schemaVersion: "cellfence.audit-event.v1",
      runId: "precision-smoke",
      timestamp: "2026-07-19T00:00:01.000Z",
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      event: "finding.detected",
      command: "check",
      ruleId: "CELLFENCE_UNDECLARED_CONSUMER",
      severity: "error",
      cellId: "app",
      producerCellId: "core",
      filePath: "src/app/public.ts",
      line: 2,
      message: "undeclared consumer",
      fingerprint: "precision-smoke-undeclared-consumer",
      outcome: "rejected",
    },
    {
      schemaVersion: "cellfence.audit-event.v1",
      runId: "precision-smoke",
      timestamp: "2026-07-19T00:00:02.000Z",
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      event: "finding.detected",
      command: "check",
      ruleId: "CELLFENCE_PRIVATE_IMPORT",
      severity: "error",
      cellId: "app",
      producerCellId: "core",
      filePath: "src/app/also-leak.ts",
      line: 1,
      message: "private import",
      fingerprint: "precision-smoke-private-import-2",
      outcome: "rejected",
    },
  ]);
  writeJson(corpusPath, {
    schemaVersion: "cellfence.corpus.v1",
    subjects: [
      {
        id: "reviewed-demo",
        repository: "https://github.com/example/reviewed-demo.git",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        manifest: {
          strategy: "copy",
          source: "manifests/reviewed-demo.cellfence.manifest.json",
          reviewStatus: "reviewed",
        },
      },
    ],
  });
  writeJson(reportPath, {
    schemaVersion: "cellfence.corpus-study.v1",
    generatedAt: "2026-07-19T00:00:03.000Z",
    corpusPath,
    dryRun: false,
    allowFloatingRef: false,
    environment: {
      harnessCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      harnessDirty: false,
      cellfenceVersion: "0.1.14",
      corpusSha256: hashFile(corpusPath),
    },
    subjects: [
      {
        id: "reviewed-demo",
        repository: "https://github.com/example/reviewed-demo.git",
        requestedCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        requestedRef: null,
        status: "checked_findings",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        gitTree: "cccccccccccccccccccccccccccccccccccccccc",
        subjectDir,
        manifest: {
          strategy: "copy",
          reviewStatus: "reviewed",
          path: "cellfence.manifest.json",
          effectivePath: manifestPath,
          sha256: hashFile(manifestPath),
          status: "completed",
        },
        check: {
          status: "checked_findings",
          exitCode: 1,
          ok: false,
          findings: 3,
          warnings: 0,
          auditLogPath,
          auditLogSha256: hashFile(auditLogPath),
        },
      },
    ],
    summary: {
      total: 1,
      completed: 1,
      failed: 0,
      totalFindings: 3,
    },
  });
  return { corpusPath, reportPath };
}

function writeLabels(labelsPath, findings) {
  const labels = findings.flatMap((finding) => [
    {
      schemaVersion: "cellfence.corpus-label.v1",
      studyId,
      findingId: finding.findingId,
      rater: "reviewer-a",
      label: "true_positive",
      rationale: "fixture finding matches the reviewed manifest violation",
    },
    {
      schemaVersion: "cellfence.corpus-label.v1",
      studyId,
      findingId: finding.findingId,
      rater: "reviewer-b",
      label: "true_positive",
      rationale: "independent fixture label agrees with the manifest violation",
    },
  ]);
  writeJsonl(labelsPath, labels);
}

function writeProtocol(protocolPath, artifactSetSha256) {
  writeJson(protocolPath, {
    schemaVersion: "cellfence.precision-claim-protocol.v1",
    studyId,
    claim: {
      toolCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      artifactSetSha256,
      targetPopulation: "local reviewed-manifest precision pipeline smoke fixture",
      supportedSyntaxProfile: "ts-js-supported-v1",
      includedRules: [
        "CELLFENCE_PRIVATE_IMPORT",
        "CELLFENCE_UNDECLARED_CONSUMER",
      ],
      primaryMetric: "blocking_precision",
      minimumPrecision: 0.99,
      confidence: 0.95,
    },
    samplingPlan: {
      maxRepositoryContribution: 1,
    },
    labelingPlan: {
      minimumIndependentRaters: 2,
      requireAdjudicationForDisagreements: true,
    },
  });
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
    const { corpusPath, reportPath } = createFixture(runDir);
    const firstBundleDir = path.join(runDir, "bundle-unlabeled");
    const labeledBundleDir = path.join(runDir, "bundle-labeled");
    const labelsPath = path.join(runDir, "labels.jsonl");
    const protocolPath = path.join(runDir, "protocol.json");
    const claimPath = path.join(runDir, "claim-report.json");

    requireStatus(run(process.execPath, [
      path.join(repoRoot, "scripts", "corpus-evidence-bundle.mjs"),
      "--study-id",
      studyId,
      "--corpus",
      corpusPath,
      "--report",
      reportPath,
      "--out-dir",
      firstBundleDir,
    ]), 0, "bundle build");
    const findings = readJsonl(path.join(firstBundleDir, "findings.normalized.jsonl"));
    if (findings.length !== 3) throw new Error(`expected 3 normalized findings, got ${findings.length}`);
    if (!findings.every((finding) => finding.precisionEligible === true)) {
      throw new Error("expected all smoke findings to be precision eligible");
    }

    writeLabels(labelsPath, findings);
    requireStatus(run(process.execPath, [
      path.join(repoRoot, "scripts", "corpus-evidence-bundle.mjs"),
      "--study-id",
      studyId,
      "--corpus",
      corpusPath,
      "--report",
      reportPath,
      "--labels",
      labelsPath,
      "--out-dir",
      labeledBundleDir,
    ]), 0, "labeled bundle build");
    requireStatus(run(process.execPath, [
      path.join(repoRoot, "scripts", "corpus-evidence-bundle.mjs"),
      "--validate",
      "--bundle",
      labeledBundleDir,
    ]), 0, "bundle validate");
    const artifactSetSha256 = hashFile(path.join(labeledBundleDir, "SHA256SUMS"));
    writeProtocol(protocolPath, artifactSetSha256);

    const claim = run(process.execPath, [
      path.join(repoRoot, "scripts", "corpus-precision-claim.mjs"),
      "--bundle",
      labeledBundleDir,
      "--protocol",
      protocolPath,
      "--out",
      claimPath,
    ]);
    requireStatus(claim, 1, "claim evaluate");
    const claimReport = readJson(claimPath);
    if (claimReport.decision?.status !== "insufficient_evidence") {
      throw new Error(`expected insufficient_evidence, got ${claimReport.decision?.status}`);
    }
    if (claimReport.metrics?.occurrence?.blocking?.trials !== 3) {
      throw new Error("expected three labeled blocking trials");
    }

    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    writeJson(options.outPath, {
      schemaVersion: "cellfence.precision-pipeline-smoke.v1",
      generatedAt: new Date().toISOString(),
      studyId,
      runDir,
      bundleDir: labeledBundleDir,
      protocolPath,
      claimReportPath: claimPath,
      normalizedFindings: findings.length,
      sampledFindings: claimReport.bundle.sampledFindings,
      precisionEligibleSampledFindings: claimReport.bundle.precisionEligibleSampledFindings,
      decision: claimReport.decision,
      artifactSetSha256: claimReport.bundle.artifactSetSha256,
    });
    console.log(`precision pipeline smoke passed: ${findings.length} labeled findings; claim=${claimReport.decision.status}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = main();
