// 0.4.x: self-contained baseline comparison for the GitHub Action.
// This module is intentionally kept free of `@cellfence/cli` and
// `@cellfence/engine` runtime dependencies so the action can be
// ncc-bundled into a single distributable file. The schema types
// are inlined as a minimal subset (only the fields the action
// inspects); the comparison logic is the same as the engine's
// `detectBaselineChanges`, ported here to keep the action's
// runtime dependency graph at `@actions/core` + `@actions/github`
// only.

import { execFileSync } from "node:child_process";
import path from "node:path";

// Minimal CellFence baseline shape (only the fields the action
// diffs). The full schema lives in `@cellfence/schema`; we do
// not import it here to keep the action's runtime dependency
// graph small. The action never validates the baseline
// structure, it only reads the fields it cares about, so a
// partial type is safe.
type CellFenceBaselineLike = {
  cells?: Record<
    string,
    {
      ownedPathSet?: string[];
      ownedPathPatterns?: string[];
      publicSymbolSet?: string[];
      dependencyEdges?: string[];
      resourceAccesses?: Array<{ kind: string; selector: string; access: string }>;
    }
  >;
};

type BaselineDimension = "ownedPaths" | "publicSymbols" | "crossCellEdges" | "resourceAccesses";

type BaselineDimensionDelta = {
  dimension: BaselineDimension;
  added: string[];
  removed: string[];
};

export type GovernanceChangeReport = {
  schemaVersion: "cellfence.governance-change.v1";
  generatedAt: string;
  baseBaselinePath: string;
  headBaselinePath: string;
  hasChange: boolean;
  deltas: BaselineDimensionDelta[];
};

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

function ownedPathSetForCell(baseline: CellFenceBaselineLike, cellId: string): string[] {
  const cell = baseline.cells?.[cellId];
  if (!cell) return [];
  const out: string[] = [];
  if (Array.isArray(cell.ownedPathSet)) out.push(...cell.ownedPathSet);
  if (cell.ownedPathPatterns) out.push(`(${cell.ownedPathPatterns} patterns)`);
  return out;
}

function diffOwnedPaths(
  base: CellFenceBaselineLike,
  head: CellFenceBaselineLike,
): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const cellIds = new Set<string>([
    ...Object.keys(base.cells ?? {}),
    ...Object.keys(head.cells ?? {}),
  ]);
  for (const cellId of cellIds) {
    const baseSet = new Set(ownedPathSetForCell(base, cellId));
    const headSet = new Set(ownedPathSetForCell(head, cellId));
    for (const entry of headSet) if (!baseSet.has(entry)) added.push(`${cellId}: ${entry}`);
    for (const entry of baseSet) if (!headSet.has(entry)) removed.push(`${cellId}: ${entry}`);
  }
  return { dimension: "ownedPaths", added, removed };
}

function diffPublicSymbols(
  base: CellFenceBaselineLike,
  head: CellFenceBaselineLike,
): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const cellIds = new Set<string>([
    ...Object.keys(base.cells ?? {}),
    ...Object.keys(head.cells ?? {}),
  ]);
  for (const cellId of cellIds) {
    const baseSet = new Set(base.cells?.[cellId]?.publicSymbolSet ?? []);
    const headSet = new Set(head.cells?.[cellId]?.publicSymbolSet ?? []);
    for (const entry of headSet) if (!baseSet.has(entry)) added.push(`${cellId}.${entry}`);
    for (const entry of baseSet) if (!headSet.has(entry)) removed.push(`${cellId}.${entry}`);
  }
  return { dimension: "publicSymbols", added, removed };
}

function diffCrossCellEdges(
  base: CellFenceBaselineLike,
  head: CellFenceBaselineLike,
): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const cellIds = new Set<string>([
    ...Object.keys(base.cells ?? {}),
    ...Object.keys(head.cells ?? {}),
  ]);
  for (const cellId of cellIds) {
    const baseSet = new Set(base.cells?.[cellId]?.dependencyEdges ?? []);
    const headSet = new Set(head.cells?.[cellId]?.dependencyEdges ?? []);
    for (const entry of headSet) if (!baseSet.has(entry)) added.push(`${cellId}: ${entry}`);
    for (const entry of baseSet) if (!headSet.has(entry)) removed.push(`${cellId}: ${entry}`);
  }
  return { dimension: "crossCellEdges", added, removed };
}

function diffResourceAccesses(
  base: CellFenceBaselineLike,
  head: CellFenceBaselineLike,
): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const cellIds = new Set<string>([
    ...Object.keys(base.cells ?? {}),
    ...Object.keys(head.cells ?? {}),
  ]);
  for (const cellId of cellIds) {
    const baseSet = new Set(
      (base.cells?.[cellId]?.resourceAccesses ?? []).map(
        (r) => `${r.kind}:${r.selector}:${r.access}`,
      ),
    );
    const headSet = new Set(
      (head.cells?.[cellId]?.resourceAccesses ?? []).map(
        (r) => `${r.kind}:${r.selector}:${r.access}`,
      ),
    );
    for (const entry of headSet) if (!baseSet.has(entry)) added.push(`${cellId}: ${entry}`);
    for (const entry of baseSet) if (!headSet.has(entry)) removed.push(`${cellId}: ${entry}`);
  }
  return { dimension: "resourceAccesses", added, removed };
}

function detectBaselineChanges(
  baseBaseline: CellFenceBaselineLike,
  headBaseline: CellFenceBaselineLike,
  baseBaselinePath: string,
  headBaselinePath: string,
): GovernanceChangeReport {
  return {
    schemaVersion: "cellfence.governance-change.v1",
    generatedAt: new Date().toISOString(),
    baseBaselinePath,
    headBaselinePath,
    hasChange: false,
    deltas: [
      diffOwnedPaths(baseBaseline, headBaseline),
      diffPublicSymbols(baseBaseline, headBaseline),
      diffCrossCellEdges(baseBaseline, headBaseline),
      diffResourceAccesses(baseBaseline, headBaseline),
    ].filter((delta) => delta.added.length > 0 || delta.removed.length > 0),
  };
}

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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
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
    baseValue as CellFenceBaselineLike,
    headValue as CellFenceBaselineLike,
    baseDisplay,
    headDisplay,
  );
  report.hasChange = report.deltas.some(
    (delta) => delta.added.length > 0 || delta.removed.length > 0,
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
