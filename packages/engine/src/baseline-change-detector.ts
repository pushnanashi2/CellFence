// Baseline change detector — proof-of-concept for the 0.4.0
// `cellfence baseline gate` subcommand. Given two CellFence baselines
// (the one in main vs the one in the PR), describe the governance
// change in human-readable units. The full implementation will feed
// this into the GitHub Action that gates PRs on a CODEOWNER approval
// of any baseline change.

import type { CellFenceBaseline } from "@cellfence/schema";

export type BaselineDimension = "ownedPaths" | "publicSymbols" | "crossCellEdges" | "signatures" | "resourceAccesses";

export type BaselineDimensionDelta = {
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

export function detectBaselineChanges(
  baseBaseline: CellFenceBaseline,
  headBaseline: CellFenceBaseline,
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

function ownedPathSetForCell(baseline: CellFenceBaseline, cellId: string): string[] {
  const cell = baseline.cells[cellId];
  if (!cell) return [];
  return [...(cell.ownedPathSet || []), ...(cell.ownedPathPatterns ? [`(${cell.ownedPathPatterns} patterns)`] : [])];
}

function diffOwnedPaths(baseBaseline: CellFenceBaseline, headBaseline: CellFenceBaseline): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const cellIds = new Set<string>([...Object.keys(baseBaseline.cells), ...Object.keys(headBaseline.cells)]);
  for (const cellId of cellIds) {
    const base = new Set(ownedPathSetForCell(baseBaseline, cellId));
    const head = new Set(ownedPathSetForCell(headBaseline, cellId));
    for (const entry of head) if (!base.has(entry)) added.push(`${cellId}: ${entry}`);
    for (const entry of base) if (!head.has(entry)) removed.push(`${cellId}: ${entry}`);
  }
  return { dimension: "ownedPaths", added, removed };
}

function publicSymbolSetForCell(baseline: CellFenceBaseline, cellId: string): string[] {
  return [...(baseline.cells[cellId]?.publicSymbolSet || [])];
}

function diffPublicSymbols(baseBaseline: CellFenceBaseline, headBaseline: CellFenceBaseline): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const cellIds = new Set<string>([...Object.keys(baseBaseline.cells), ...Object.keys(headBaseline.cells)]);
  for (const cellId of cellIds) {
    const base = new Set(publicSymbolSetForCell(baseBaseline, cellId));
    const head = new Set(publicSymbolSetForCell(headBaseline, cellId));
    for (const entry of head) if (!base.has(entry)) added.push(`${cellId}.${entry}`);
    for (const entry of base) if (!head.has(entry)) removed.push(`${cellId}.${entry}`);
  }
  return { dimension: "publicSymbols", added, removed };
}

function crossCellEdgeSetForCell(baseline: CellFenceBaseline, cellId: string): string[] {
  // CellBaselineRecord.dependencyEdges is intentionally typed as
  // string[] so callers can store whatever edge encoding is convenient
  // for the language ecosystem. We diff the raw representation here;
  // 0.4.0 may switch to a structured encoding.
  return [...(baseline.cells[cellId]?.dependencyEdges || [])];
}

function diffCrossCellEdges(baseBaseline: CellFenceBaseline, headBaseline: CellFenceBaseline): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const cellIds = new Set<string>([...Object.keys(baseBaseline.cells), ...Object.keys(headBaseline.cells)]);
  for (const cellId of cellIds) {
    const base = new Set(crossCellEdgeSetForCell(baseBaseline, cellId));
    const head = new Set(crossCellEdgeSetForCell(headBaseline, cellId));
    for (const entry of head) if (!base.has(entry)) added.push(`${cellId}: ${entry}`);
    for (const entry of base) if (!head.has(entry)) removed.push(`${cellId}: ${entry}`);
  }
  return { dimension: "crossCellEdges", added, removed };
}

function resourceAccessSetForCell(baseline: CellFenceBaseline, cellId: string): string[] {
  return [...(baseline.cells[cellId]?.resourceAccesses || [])].map((entry) => `${entry.kind}:${entry.selector}:${entry.access}`);
}

function diffResourceAccesses(baseBaseline: CellFenceBaseline, headBaseline: CellFenceBaseline): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const cellIds = new Set<string>([...Object.keys(baseBaseline.cells), ...Object.keys(headBaseline.cells)]);
  for (const cellId of cellIds) {
    const base = new Set(resourceAccessSetForCell(baseBaseline, cellId));
    const head = new Set(resourceAccessSetForCell(headBaseline, cellId));
    for (const entry of head) if (!base.has(entry)) added.push(`${cellId}: ${entry}`);
    for (const entry of base) if (!head.has(entry)) removed.push(`${cellId}: ${entry}`);
  }
  return { dimension: "resourceAccesses", added, removed };
}
