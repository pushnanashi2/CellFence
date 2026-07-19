#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkRepository } from "../packages/engine/dist/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkDir = path.join(repoRoot, "tmp", "evidence-graph-smoke");
const defaultOutPath = path.join(repoRoot, "reports", "evidence-graph-smoke.json");
const verifierScript = path.join(repoRoot, "scripts", "evidence-graph-verify.mjs");
const fixturePath = path.join(repoRoot, "fixtures", "invalid", "private-cross-cell-import");

function usage() {
  console.error(`Usage: node scripts/evidence-graph-smoke.mjs [--workdir tmp/evidence-graph-smoke] [--out reports/evidence-graph-smoke.json]

Runs CellFence against the private-cross-cell-import fixture with evidence graph
output enabled, then validates the graph with the standalone structural
verifier. This is a verifier smoke, not a formal policy-conformance proof.`);
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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runVerifier(graphPath, reportPath) {
  return spawnSync(process.execPath, [
    verifierScript,
    "--graph",
    graphPath,
    "--out",
    reportPath,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    timeout: 120_000,
  });
}

function assertSmokeResult(checkResult, verifierResult, verifierReport) {
  const failures = [];
  if (checkResult.exitCode !== 1) failures.push(`expected fixture check exit 1, got ${checkResult.exitCode}`);
  if (!checkResult.findings.some((finding) => finding.ruleId === "CELLFENCE_PRIVATE_IMPORT")) {
    failures.push("expected CELLFENCE_PRIVATE_IMPORT finding");
  }
  if (!checkResult.evidenceGraph) failures.push("expected opt-in evidenceGraph");
  if (verifierResult.status !== 0) {
    failures.push(`evidence graph verifier exited ${verifierResult.status}: ${verifierResult.stderr || verifierResult.stdout}`);
  }
  if (!verifierReport.ok) failures.push("evidence graph verifier reported structural defects");
  if (verifierReport.summary.findings < 1) failures.push("expected at least one finding node");
  if (verifierReport.summary.findingWitnesses < 1) failures.push("expected at least one finding witness");
  if (failures.length > 0) throw new Error(failures.join("\n"));
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
    const graphPath = path.join(runDir, "evidence-graph.json");
    const verifierReportPath = path.join(runDir, "evidence-graph-verifier.json");
    const checkResult = checkRepository({
      rootDir: fixturePath,
      includeEvidenceGraph: true,
    });
    if (!checkResult.evidenceGraph) {
      throw new Error(`expected evidenceGraph in fixture check result, got exit ${checkResult.exitCode} with rules ${checkResult.findings.map((finding) => finding.ruleId).join(",")}`);
    }
    writeJson(graphPath, checkResult.evidenceGraph);
    const verifierResult = runVerifier(graphPath, verifierReportPath);
    const verifierReport = JSON.parse(fs.readFileSync(verifierReportPath, "utf8"));
    assertSmokeResult(checkResult, verifierResult, verifierReport);
    const report = {
      schemaVersion: "cellfence.evidence-graph-smoke.v1",
      fixture: "fixtures/invalid/private-cross-cell-import",
      graphPath,
      verifierReportPath,
      graphCanonicalSha256: verifierReport.input.graphCanonicalSha256,
      check: {
        exitCode: checkResult.exitCode,
        findingRules: checkResult.findings.map((finding) => finding.ruleId).sort((left, right) => left.localeCompare(right)),
        warningRules: checkResult.warnings.map((warning) => warning.ruleId).sort((left, right) => left.localeCompare(right)),
      },
      verifier: {
        ok: verifierReport.ok,
        summary: verifierReport.summary,
      },
    };
    writeJson(options.outPath, report);
    console.log(`evidence graph smoke passed: ${report.verifier.summary.findings} finding node(s), ${report.verifier.summary.findingWitnesses} witness(es)`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = main();
