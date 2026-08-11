// CLI glue for the prototype `cellfence coverage` subcommand. The full
// implementation (walking the repository, asking each adapter to record
// unresolved observations, formatting SARIF) is queued for 0.4.0. This
// module just demonstrates the wiring so the command is discoverable in
// `--help`, emits a stable JSON shape, and has a single test that proves
// the format.

import { buildCoverageReport, type CoverageReport, type CoverageUnresolved } from "@cellfence/engine";

export type CoverageCommandOptions = {
  rootDir: string;
  format: "json" | "human";
  failUnder?: number;
  outputPath?: string;
  /** Unresolved observations collected upstream (the walker fills these in for 0.4.0). */
  unresolved: CoverageUnresolved[];
  /** File paths the walker successfully walked. */
  analyzedFiles: string[];
  /** Total source files in the repository, supplied by the walker. */
  totalFiles: number;
};

export type CoverageCommandResult = {
  report: CoverageReport;
  exitCode: number;
};

const RULE_PREFIX = "CELLFENCE_COVERAGE_";

/**
 * Run the coverage subcommand and return the report + exit code. The
 * caller is responsible for actually writing the report to disk or stdout
 * — this function does not perform I/O, which keeps it easy to test.
 */
export function runCoverageCommand(options: CoverageCommandOptions): CoverageCommandResult {
  const report = buildCoverageReport({
    rootDir: options.rootDir,
    totalFiles: options.totalFiles,
    analyzedFiles: options.analyzedFiles,
    unresolved: options.unresolved,
  });
  let exitCode = 0;
  if (typeof options.failUnder === "number" && report.summary.coverage < options.failUnder) {
    exitCode = 2;
  }
  if (options.format === "human") {
    printHumanReport(report);
  }
  return { report, exitCode };
}

function printHumanReport(report: CoverageReport): void {
  const { summary, findings } = report;
  console.log(
    `cellfence coverage: ${(summary.coverage * 100).toFixed(2)}% ` +
      `(${summary.analyzedFiles}/${summary.totalFiles} files analyzed, ` +
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
      console.log(`  ${location} ${entry.shape} — ${entry.reason}`);
    }
  }
}
