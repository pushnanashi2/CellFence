// 0.4.x (M-5): the gate now delegates to the engine's
// `detectBaselineChanges` so the action can never diverge from
// the engine's idea of what counts as a governance change.
// The engine covers seven dimensions (ownedPaths, publicSymbols,
// crossCellEdges, signatures, resourceAccesses,
// publicSurfaceMetadata, dependencyCounts); the action used to
// reimplement four of them and was drifting from the engine on
// every new dimension the engine added. After this commit the
// action is a glue layer: git ref + path resolution on the way
// in, GovernanceChangeReport on the way out.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { detectBaselineChanges, type CellFenceBaseline, type GovernanceChangeReport } from "@cellfence/engine";

export type { GovernanceChangeReport } from "@cellfence/engine";

export type BaselineGateResult = {
  report: GovernanceChangeReport;
  exitCode: number;
  warnings: string[];
};

export type BaselineGateOptions = {
  rootDir: string;
  baselineFile: string;
  baseRef?: string;
  headRef?: string;
  hasImplementationChanges?: boolean;
};

function readBaselineFromGit(rootDir: string, ref: string, baselineFile: string): unknown {
  const relativeBaselineFile = isAbsolute(baselineFile)
    ? relative(rootDir, baselineFile)
    : baselineFile;
  const text = String(execFileSync("git", ["show", `${ref}:${relativeBaselineFile}`], {
    cwd: rootDir,
  }));
  return JSON.parse(text);
}

function readBaselineFromPath(filePath: string): unknown {
  return JSON.parse(String(readFileSync(filePath)));
}

export function runBaselineGateFull(options: BaselineGateOptions): BaselineGateResult {
  if (!options.baseRef && !options.headRef) {
    throw new Error("either a base-ref or a head-ref is required to read the baseline");
  }
  const baselineFile = isAbsolute(options.baselineFile)
    ? options.baselineFile
    : resolve(options.rootDir, options.baselineFile);
  const baseValue = options.baseRef
    ? readBaselineFromGit(options.rootDir, options.baseRef, baselineFile)
    : readBaselineFromPath(baselineFile);
  const headValue = options.headRef
    ? readBaselineFromGit(options.rootDir, options.headRef, baselineFile)
    : readBaselineFromPath(baselineFile);
  const baseDisplay = options.baseRef
    ? `${options.baseRef}:${relative(options.rootDir, baselineFile)}`
    : baselineFile;
  const headDisplay = options.headRef
    ? `${options.headRef}:${relative(options.rootDir, baselineFile)}`
    : baselineFile;
  const report = detectBaselineChanges(
    baseValue as CellFenceBaseline,
    headValue as CellFenceBaseline,
    baseDisplay,
    headDisplay,
  );
  const warnings: string[] = [];
  if (options.hasImplementationChanges && report.hasChange) {
    warnings.push(
      "baseline changes and implementation changes are mixed in the same pull request",
    );
  }
  return {
    report,
    // exit 1: governance change present. exit 0: no change.
    exitCode: report.hasChange ? 1 : 0,
    warnings,
  };
}
