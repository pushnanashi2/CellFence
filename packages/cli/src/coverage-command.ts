// CLI glue for the coverage command. It walks the repository through
// the normal check pipeline and reports visibility-related findings as
// coverage observations for JSON, human, or SARIF output.

import fs from "node:fs";
import path from "node:path";

import {
  type CheckOptions,
} from "@cellfence/engine";

import {
  buildCoverageReport,
  type CoverageReport,
  type CoverageUnresolved,
} from "@cellfence/engine";

import { walkCoverage } from "./coverage-walker.js";
import { coverageReportToSarif } from "./coverage-sarif.js";

export type CoverageCommandOptions = {
  rootDir: string;
  format: "json" | "human" | "sarif";
  failUnder?: number;
  outputPath?: string;
  /** Forwarded to the engine check call so the walker honours the
   *  same flags as `cellfence check`. */
  check: CheckOptions;
};

export type CoverageCommandResult = {
  report: CoverageReport;
  exitCode: number;
};

const RULE_PREFIX = "CELLFENCE_COVERAGE_";

function printHumanReport(report: CoverageReport): void {
  const { summary, findings } = report;
  console.log(
    `cellfence coverage: ${(summary.coverage * 100).toFixed(2)}% ` +
      `(${summary.analyzedFiles}/${summary.totalFiles} files analysed, ` +
      `${findings.length} unresolved observations)`,
  );
  if (findings.length === 0) return;
  const grouped = new Map<string, CoverageUnresolved[]>();
  for (const finding of findings) {
    const key = `${RULE_PREFIX}${finding.kind.toUpperCase().replace(/-/g, "_")}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(finding);
    grouped.set(key, bucket);
  }
  for (const [ruleId, entries] of grouped) {
    console.log(`\n${ruleId} (${entries.length})`);
    for (const entry of entries) {
      const location = entry.line ? `${entry.filePath}:${entry.line}` : entry.filePath;
      console.log(`  ${location} ${entry.shape} \u2014 ${entry.reason}`);
    }
  }
}

export function runCoverageCommand(options: CoverageCommandOptions): CoverageCommandResult {
  const walked = walkCoverage({ ...options.check, rootDir: options.rootDir });
  const report = buildCoverageReport({
    rootDir: path.resolve(options.rootDir),
    totalFiles: walked.totalFiles,
    analyzedFiles: walked.analyzedFiles,
    unresolved: walked.unresolved,
  });
  let exitCode = 0;
  if (typeof options.failUnder === "number" && report.summary.coverage < options.failUnder) {
    exitCode = 2;
  }
  if (options.format === "human") {
    printHumanReport(report);
  } else if (options.format === "sarif") {
    process.stdout.write(`${JSON.stringify(coverageReportToSarif(report), null, 2)}\n`);
  }
  if (options.outputPath) {
    const payload = options.format === "sarif" ? coverageReportToSarif(report) : report;
    fs.writeFileSync(options.outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
  return { report, exitCode };
}
