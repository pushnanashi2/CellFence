// CLI glue for the `cellfence baseline gate` subcommand. The full
// Git-ref loading and GitHub Action approval flow live in adjacent
// modules; this module turns two parsed baselines into a stable
// GovernanceChangeReport and exit code.

import type { CellFenceBaseline } from "@cellfence/schema";
import { detectBaselineChanges, type GovernanceChangeReport } from "@cellfence/engine";

export type BaselineGateOptions = {
  baseBaseline: CellFenceBaseline;
  headBaseline: CellFenceBaseline;
  baseBaselinePath: string;
  headBaselinePath: string;
  format: "json" | "human";
  /** When set, mixing this PR with non-baseline code changes triggers a warning. */
  hasImplementationChanges: boolean;
};

export type BaselineGateResult = {
  report: GovernanceChangeReport;
  exitCode: number;
  warnings: string[];
};

export function runBaselineGateCommand(options: BaselineGateOptions): BaselineGateResult {
  const report = detectBaselineChanges(
    options.baseBaseline,
    options.headBaseline,
    options.baseBaselinePath,
    options.headBaselinePath,
  );
  const warnings: string[] = [];
  if (options.hasImplementationChanges && report.hasChange) {
    warnings.push("baseline changes and implementation changes are mixed in the same pull request");
  }
  if (options.format === "human") {
    printHumanReport(report);
  }
  // exit 0: no governance change. exit 1: governance change present.
  const exitCode = report.hasChange ? 1 : 0;
  return { report, exitCode, warnings };
}

function printHumanReport(report: GovernanceChangeReport): void {
  if (!report.hasChange) {
    console.log("cellfence baseline gate: no governance change detected");
    return;
  }
  console.log(`cellfence baseline gate: ${report.deltas.length} dimension(s) changed between ${report.baseBaselinePath} and ${report.headBaselinePath}`);
  for (const delta of report.deltas) {
    if (delta.added.length === 0 && delta.removed.length === 0 && (delta.skippedCells?.length ?? 0) === 0) continue;
    console.log(`\n[${delta.dimension}] +${delta.added.length} / -${delta.removed.length}`);
    for (const entry of delta.added) console.log(`  + ${entry}`);
    for (const entry of delta.removed) console.log(`  - ${entry}`);
    if (delta.skippedCells?.length) console.log(`  skipped: ${delta.skippedCells.join(", ")}`);
  }
}
