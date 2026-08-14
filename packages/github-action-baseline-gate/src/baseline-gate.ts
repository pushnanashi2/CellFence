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
import fs from "node:fs";
import path from "node:path";

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
  const relative = path.isAbsolute(baselineFile)
    ? path.relative(rootDir, baselineFile) || baselineFile
    : baselineFile;
  const text = execFileSync("git", ["show", `${ref}:${relative}`], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(text);
}

function readBaselineFromPath(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function runBaselineGateFull(options: BaselineGateOptions): BaselineGateResult {
  if (!options.baseRef && !options.headRef) {
    throw new Error("either a base-ref or a head-ref is required to read the baseline");
  }
  const baselineFile = path.isAbsolute(options.baselineFile)
    ? options.baselineFile
    : path.resolve(options.rootDir, options.baselineFile);
  const baseValue = options.baseRef
    ? readBaselineFromGit(options.rootDir, options.baseRef, baselineFile)
    : readBaselineFromPath(baselineFile);
  const headValue = options.headRef
    ? readBaselineFromGit(options.rootDir, options.headRef, baselineFile)
    : readBaselineFromPath(baselineFile);
  const baseDisplay = options.baseRef
    ? `${options.baseRef}:${path.relative(options.rootDir, baselineFile) || baselineFile}`
    : baselineFile;
  const headDisplay = options.headRef
    ? `${options.headRef}:${path.relative(options.rootDir, baselineFile) || baselineFile}`
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
    // exit 0: governance change present (action continues to enforce
    // approval before merge). exit 1: no change (action can short-circuit).
    exitCode: report.hasChange ? 0 : 1,
    warnings,
  };
}
