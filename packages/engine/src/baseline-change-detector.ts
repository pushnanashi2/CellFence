// Baseline change detector for `cellfence baseline gate`. Given two
// CellFence baselines, describe the governance change in
// human-readable units so the CLI and bundled GitHub Action can gate
// baseline widening on review.

import type { CellFenceBaseline } from "@cellfence/schema";

export type BaselineDimension =
  | "cellIds"
  | "ownedPaths"
  | "publicSymbols"
  | "crossCellEdges"
  | "signatures"
  | "resourceAccesses"
  | "artifactContracts"
  | "externalDependencies"
  | "publicSurfaceMetadata"
  | "dependencyCounts";

export type BaselineDimensionDelta = {
  dimension: BaselineDimension;
  added: string[];
  removed: string[];
  // Cells whose `ownedPathSet` was omitted on either side, so the
  // differ had to skip them rather than emit a false-positive or
  // false-negative. Surfaced so callers can flag stale locks.
  skippedCells?: string[];
};

export type GovernanceChangeReport = {
  schemaVersion: "cellfence.governance-change.v1";
  generatedAt: string;
  baseBaselinePath: string;
  headBaselinePath: string;
  // True iff at least one dimension has a non-empty `added` or
  // `removed` set, or at least one cell was skipped. A skipped
  // cell is itself a governance change because it implies the
  // locked baseline is no longer comprehensive enough to
  // differentiate the two revisions.
  hasChange: boolean;
  deltas: BaselineDimensionDelta[];
};

export function detectBaselineChanges(
  baseBaseline: CellFenceBaseline,
  headBaseline: CellFenceBaseline,
  baseBaselinePath: string,
  headBaselinePath: string,
): GovernanceChangeReport {
  const cellIds = diffCellIds(baseBaseline, headBaseline);
  const ownedPaths = diffOwnedPaths(baseBaseline, headBaseline);
  const publicSymbols = diffPublicSymbols(baseBaseline, headBaseline);
  const crossCellEdges = diffCrossCellEdges(baseBaseline, headBaseline);
  const signatures = diffSignatures(baseBaseline, headBaseline);
  const resourceAccesses = diffResourceAccesses(baseBaseline, headBaseline);
  const artifactContracts = diffArtifactContracts(baseBaseline, headBaseline);
  const externalDependencies = diffExternalDependencies(baseBaseline, headBaseline);
  const publicSurfaceMetadata = diffPublicSurfaceMetadata(baseBaseline, headBaseline);
  const dependencyCounts = diffDependencyCounts(baseBaseline, headBaseline);

  const deltas = [cellIds, ownedPaths, publicSymbols, crossCellEdges, signatures, resourceAccesses, artifactContracts, externalDependencies, publicSurfaceMetadata, dependencyCounts].filter(
    (delta) => delta.added.length > 0 || delta.removed.length > 0 || (delta.skippedCells?.length ?? 0) > 0,
  );

  return {
    schemaVersion: "cellfence.governance-change.v1",
    generatedAt: new Date().toISOString(),
    baseBaselinePath,
    headBaselinePath,
    hasChange: deltas.length > 0,
    deltas,
  };
}

function acceptedCellIds(baseline: CellFenceBaseline): string[] {
  return [...(baseline.cellIds ?? Object.keys(baseline.cells))].sort();
}

function acceptedCellRecord(baseline: CellFenceBaseline, cellId: string) {
  return acceptedCellIds(baseline).includes(cellId) ? baseline.cells[cellId] : undefined;
}

function cellIdsForComparison(baseBaseline: CellFenceBaseline, headBaseline: CellFenceBaseline): Set<string> {
  return new Set<string>([...acceptedCellIds(baseBaseline), ...acceptedCellIds(headBaseline)]);
}

function diffCellIds(baseBaseline: CellFenceBaseline, headBaseline: CellFenceBaseline): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const base = new Set(acceptedCellIds(baseBaseline));
  const head = new Set(acceptedCellIds(headBaseline));
  for (const cellId of head) if (!base.has(cellId)) added.push(cellId);
  for (const cellId of base) if (!head.has(cellId)) removed.push(cellId);
  return { dimension: "cellIds", added, removed };
}

function ownedPathSetForCell(baseline: CellFenceBaseline, cellId: string): { entries: string[]; skipped: boolean } {
  const cell = acceptedCellRecord(baseline, cellId);
  if (!cell) return { entries: [], skipped: false };
  if (Array.isArray(cell.ownedPathSet)) {
    return { entries: [...cell.ownedPathSet], skipped: false };
  }
  // `ownedPathSet` is optional in the schema. When omitted, the
  // pattern list is unknown and we cannot compute a meaningful
  // diff; record the cell as skipped so the caller knows the
  // comparison is incomplete (and the report.hasChange flag
  // stays true as long as any cell on either side was skipped).
  return { entries: [], skipped: true };
}

function diffOwnedPaths(baseBaseline: CellFenceBaseline, headBaseline: CellFenceBaseline): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const skippedCells: string[] = [];
  const cellIds = cellIdsForComparison(baseBaseline, headBaseline);
  for (const cellId of cellIds) {
    const base = ownedPathSetForCell(baseBaseline, cellId);
    const head = ownedPathSetForCell(headBaseline, cellId);
    if (base.skipped || head.skipped) {
      skippedCells.push(cellId);
      continue;
    }
    const baseSet = new Set(base.entries);
    const headSet = new Set(head.entries);
    for (const entry of headSet) if (!baseSet.has(entry)) added.push(`${cellId}: ${entry}`);
    for (const entry of baseSet) if (!headSet.has(entry)) removed.push(`${cellId}: ${entry}`);
  }
  return { dimension: "ownedPaths", added, removed, ...(skippedCells.length ? { skippedCells } : {}) };
}

function publicSymbolSetForCell(baseline: CellFenceBaseline, cellId: string): string[] {
  return [...(acceptedCellRecord(baseline, cellId)?.publicSymbolSet || [])];
}

function diffPublicSymbols(baseBaseline: CellFenceBaseline, headBaseline: CellFenceBaseline): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const cellIds = cellIdsForComparison(baseBaseline, headBaseline);
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
  // for the language ecosystem. We diff the raw representation here.
  return [...(acceptedCellRecord(baseline, cellId)?.dependencyEdges || [])];
}

function diffCrossCellEdges(baseBaseline: CellFenceBaseline, headBaseline: CellFenceBaseline): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const cellIds = cellIdsForComparison(baseBaseline, headBaseline);
  for (const cellId of cellIds) {
    const base = new Set(crossCellEdgeSetForCell(baseBaseline, cellId));
    const head = new Set(crossCellEdgeSetForCell(headBaseline, cellId));
    for (const entry of head) if (!base.has(entry)) added.push(`${cellId}: ${entry}`);
    for (const entry of base) if (!head.has(entry)) removed.push(`${cellId}: ${entry}`);
  }
  return { dimension: "crossCellEdges", added, removed };
}

// `signatures` dimension: the per-baseline HMAC seal. If the
// algorithm or keyId (or, by definition, the digest) differs, the
// baseline was re-signed — that is a governance change even if
// every other field is identical. Splitting the comparison out
// of the publicSurface dimension is what stops an attacker who
// holds a signing key from rolling the seal under a constant
// content and convincing the differ that nothing changed.
function diffSignatures(baseBaseline: CellFenceBaseline, headBaseline: CellFenceBaseline): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const baseSeal = baseBaseline.seal;
  const headSeal = headBaseline.seal;
  // BaselineSeal is a discriminated union: hmac-sha256 carries
  // `digest` and ed25519 carries `signature`. Extract the right
  // payload per algorithm before stringifying so a key swap that
  // changes the algorithm AND the key id both surface as a change.
  const sealFingerprint = (seal: typeof baseSeal) => {
    if (!seal) return "<none>";
    const payload = seal.algorithm === "hmac-sha256"
      ? seal.digest
      : seal.algorithm === "ed25519"
        ? seal.signature
        : "";
    return `${seal.algorithm}|${seal.keyId ?? ""}|${payload}`;
  };
  const baseKey = sealFingerprint(baseSeal);
  const headKey = sealFingerprint(headSeal);
  if (baseKey !== headKey) {
    removed.push(`base: ${baseKey}`);
    added.push(`head: ${headKey}`);
  }
  return { dimension: "signatures", added, removed };
}

function resourceAccessSetForCell(baseline: CellFenceBaseline, cellId: string): string[] {
  return [...(acceptedCellRecord(baseline, cellId)?.resourceAccesses || [])].map((entry) => `${entry.kind}:${entry.selector}:${entry.access}`);
}

function diffResourceAccesses(baseBaseline: CellFenceBaseline, headBaseline: CellFenceBaseline): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const cellIds = cellIdsForComparison(baseBaseline, headBaseline);
  for (const cellId of cellIds) {
    const base = new Set(resourceAccessSetForCell(baseBaseline, cellId));
    const head = new Set(resourceAccessSetForCell(headBaseline, cellId));
    for (const entry of head) if (!base.has(entry)) added.push(`${cellId}: ${entry}`);
    for (const entry of base) if (!head.has(entry)) removed.push(`${cellId}: ${entry}`);
  }
  return { dimension: "resourceAccesses", added, removed };
}

function artifactContractSetForCell(baseline: CellFenceBaseline, cellId: string): string[] {
  return [...(acceptedCellRecord(baseline, cellId)?.artifactContracts || [])];
}

function diffArtifactContracts(baseBaseline: CellFenceBaseline, headBaseline: CellFenceBaseline): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const cellIds = cellIdsForComparison(baseBaseline, headBaseline);
  for (const cellId of cellIds) {
    const base = new Set(artifactContractSetForCell(baseBaseline, cellId));
    const head = new Set(artifactContractSetForCell(headBaseline, cellId));
    for (const entry of head) if (!base.has(entry)) added.push(`${cellId}: ${entry}`);
    for (const entry of base) if (!head.has(entry)) removed.push(`${cellId}: ${entry}`);
  }
  return { dimension: "artifactContracts", added, removed };
}

function externalDependencySetForCell(baseline: CellFenceBaseline, cellId: string): string[] {
  return [...(acceptedCellRecord(baseline, cellId)?.externalDependencySet || [])];
}

function diffExternalDependencies(baseBaseline: CellFenceBaseline, headBaseline: CellFenceBaseline): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const cellIds = cellIdsForComparison(baseBaseline, headBaseline);
  for (const cellId of cellIds) {
    const base = new Set(externalDependencySetForCell(baseBaseline, cellId));
    const head = new Set(externalDependencySetForCell(headBaseline, cellId));
    for (const entry of head) if (!base.has(entry)) added.push(`${cellId}: ${entry}`);
    for (const entry of base) if (!head.has(entry)) removed.push(`${cellId}: ${entry}`);
  }
  return { dimension: "externalDependencies", added, removed };
}

// `publicSurfaceMetadata` covers the fields that describe the cell
// surface shape but are not sets: publicSurfaceHash, publicEntryPath,
// and the publicSymbols / publicSurfaceLines / crossCellDependencies
// counts. The previous differ only compared the symbol *set* and so
// missed any change in the count fields that ship without a
// publicSymbolSet.
function diffPublicSurfaceMetadata(baseBaseline: CellFenceBaseline, headBaseline: CellFenceBaseline): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const cellIds = cellIdsForComparison(baseBaseline, headBaseline);
  for (const cellId of cellIds) {
    const baseRecord = acceptedCellRecord(baseBaseline, cellId);
    const headRecord = acceptedCellRecord(headBaseline, cellId);
    const baseMeta = baseRecord
      ? {
          publicSurfaceHash: baseRecord.publicSurfaceHash ?? null,
          publicEntryPath: baseRecord.publicEntryPath ?? null,
          publicSymbolsCount: typeof baseRecord.publicSymbols === "number" ? baseRecord.publicSymbols : null,
          publicSurfaceLinesCount: typeof baseRecord.publicSurfaceLines === "number" ? baseRecord.publicSurfaceLines : null,
        }
      : null;
    const headMeta = headRecord
      ? {
          publicSurfaceHash: headRecord.publicSurfaceHash ?? null,
          publicEntryPath: headRecord.publicEntryPath ?? null,
          publicSymbolsCount: typeof headRecord.publicSymbols === "number" ? headRecord.publicSymbols : null,
          publicSurfaceLinesCount: typeof headRecord.publicSurfaceLines === "number" ? headRecord.publicSurfaceLines : null,
        }
      : null;
    if (JSON.stringify(baseMeta) === JSON.stringify(headMeta)) continue;
    removed.push(`${cellId}: base=${JSON.stringify(baseMeta)}`);
    added.push(`${cellId}: head=${JSON.stringify(headMeta)}`);
  }
  return { dimension: "publicSurfaceMetadata", added, removed };
}

function diffDependencyCounts(baseBaseline: CellFenceBaseline, headBaseline: CellFenceBaseline): BaselineDimensionDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const cellIds = cellIdsForComparison(baseBaseline, headBaseline);
  for (const cellId of cellIds) {
    const baseRecord = acceptedCellRecord(baseBaseline, cellId);
    const headRecord = acceptedCellRecord(headBaseline, cellId);
    const base = typeof baseRecord?.crossCellDependencies === "number" ? baseRecord.crossCellDependencies : null;
    const head = typeof headRecord?.crossCellDependencies === "number" ? headRecord.crossCellDependencies : null;
    if (base === null && head === null) continue;
    if (base === head) continue;
    if (base !== null) removed.push(`${cellId}: base=${base}`);
    if (head !== null) added.push(`${cellId}: head=${head}`);
  }
  return { dimension: "dependencyCounts", added, removed };
}
