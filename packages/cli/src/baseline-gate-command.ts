// CLI glue for the prototype `cellfence baseline gate` subcommand.
// The full implementation (git diff integration, GitHub Action glue,
// CODEOWNER-driven approval gating) is queued for 0.4.0. This module
// just demonstrates the wiring: given two parsed baselines, build a
// GovernanceChangeReport, render it in JSON or human form, and exit
// with a stable code so CI can detect a baseline change.

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
  report.hasChange = report.deltas.some((delta) => delta.added.length > 0 || delta.removed.length > 0);
  const warnings: string[] = [];
  if (options.hasImplementationChanges && report.hasChange) {
    // 0.4.0 will let users override this with a flag, but the default
    // is to keep governance changes and implementation changes in
    // separate PRs so reviewers can reason about them in isolation.
    warnings.push("baseline changes and implementation changes are mixed in the same pull request");
  }
  if (options.format === "human") {
    printHumanReport(report);
  }
  // exit 0: governance change present (action continues to enforce
  // approval before merge). exit 1: no change (action can short-circuit).
  const exitCode = report.hasChange ? 0 : 1;
  return { report, exitCode, warnings };
}

function printHumanReport(report: GovernanceChangeReport): void {
  if (!report.hasChange) {
    console.log("cellfence baseline gate: no governance change detected");
    return;
  }
  console.log(`cellfence baseline gate: ${report.deltas.length} dimension(s) changed between ${report.baseBaselinePath} and ${report.headBaselinePath}`);
  for (const delta of report.deltas) {
    if (delta.added.length === 0 && delta.removed.length === 0) continue;
    console.log(`\n[${delta.dimension}] +${delta.added.length} / -${delta.removed.length}`);
    for (const entry of delta.added) console.log(`  + ${entry}`);
    for (const entry of delta.removed) console.log(`  - ${entry}`);
  }
}
