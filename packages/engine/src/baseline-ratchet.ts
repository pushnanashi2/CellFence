import fs from "node:fs";

import type {
  CellBaselineRecord,
  CellFenceBaseline,
  CellFenceManifest,
  CellManifest,
  ResourceBaselineEntry,
} from "@cellfence/schema";
import { absolutePath, normalizePath, patternCoveredByOwnedPaths } from "./file-index.js";
import { publicSurfaceHash } from "./module-resolution.js";
import type { ResourceAccessReference } from "./resource-access.js";
import type { Finding, SuggestedResolution } from "./types.js";

type RatchetContext = {
  rootDir: string;
  manifest: CellFenceManifest;
  cellsById: Map<string, CellManifest>;
};

type FindingReporter = (findings: Finding[], finding: Finding) => void;

function codeResolution(title: string, details?: Record<string, unknown>): SuggestedResolution {
  return { kind: "change-code", title, approvalRequired: false, details };
}

function baselineResolution(title: string, approvalRequired: boolean, details?: Record<string, unknown>): SuggestedResolution {
  return { kind: "update-baseline", title, approvalRequired, details };
}

export function resourceBaselineEntry(access: ResourceAccessReference): ResourceBaselineEntry {
  return {
    kind: access.kind,
    access: access.access,
    selector: access.selector,
    detectedBy: access.detectedBy,
    confidence: access.confidence,
  };
}

export function resourceBaselineKey(access: ResourceBaselineEntry): string {
  return `${access.kind}:${access.access}:${access.selector}`;
}

export function sortedResourceBaselineEntries(accesses: readonly ResourceAccessReference[] = []): ResourceBaselineEntry[] {
  const uniqueEntries = new Map<string, ResourceBaselineEntry>();
  for (const access of accesses) {
    const entry = resourceBaselineEntry(access);
    uniqueEntries.set(resourceBaselineKey(entry), entry);
  }
  return [...uniqueEntries.values()].sort((left, right) => resourceBaselineKey(left).localeCompare(resourceBaselineKey(right)));
}

function countLines(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, "utf8");
  if (content.length === 0) return 0;
  return content.split(/\r?\n/).length;
}

function artifactContractsForCell(cell: CellManifest): string[] {
  const contracts: string[] = [];
  for (const lane of cell.producesArtifacts || []) {
    for (const artifactPath of lane.paths) contracts.push(`produce:${lane.id}:${normalizePath(artifactPath)}`);
  }
  for (const consumer of cell.consumes || []) {
    for (const lane of consumer.artifactLanes || []) contracts.push(`consume:${consumer.cell}:${lane}`);
  }
  return contracts.sort((left, right) => left.localeCompare(right));
}

function dependencyEdgesForCell(cellId: string, dependencies: Set<string> | undefined): string[] {
  return [...(dependencies || new Set<string>())]
    .map((dependency) => `${cellId}->${dependency}`)
    .sort((left, right) => left.localeCompare(right));
}

export function computeMetrics(
  context: RatchetContext,
  crossCellDependencies: Map<string, Set<string>>,
  accessesByCell: Map<string, ResourceAccessReference[]>,
): Record<string, CellBaselineRecord> {
  const metrics: Record<string, CellBaselineRecord> = {};
  for (const cell of context.manifest.cells) {
    const publicEntryPath = absolutePath(context.rootDir, cell.publicEntry);
    metrics[cell.id] = {
      ownedPathPatterns: cell.ownedPaths.length,
      publicSymbols: cell.publicSymbols.length,
      publicSurfaceLines: countLines(absolutePath(context.rootDir, cell.publicEntry)),
      crossCellDependencies: crossCellDependencies.get(cell.id)?.size || 0,
      ownedPathSet: [...cell.ownedPaths].map(normalizePath).sort((left, right) => left.localeCompare(right)),
      publicEntryPath: normalizePath(cell.publicEntry),
      publicSymbolSet: [...cell.publicSymbols].sort((left, right) => left.localeCompare(right)),
      publicSurfaceHash: publicSurfaceHash(publicEntryPath),
      dependencyEdges: dependencyEdgesForCell(cell.id, crossCellDependencies.get(cell.id)),
      artifactContracts: artifactContractsForCell(cell),
      resourceAccesses: sortedResourceBaselineEntries(accessesByCell.get(cell.id)),
    };
  }
  return metrics;
}

export function compareBaseline(
  context: RatchetContext,
  metrics: Record<string, CellBaselineRecord>,
  baseline: CellFenceBaseline,
  findings: Finding[],
  addFinding: FindingReporter,
): void {
  const baselineCellIds = new Set(baseline.cellIds || Object.keys(baseline.cells));
  for (const [cellId, metric] of Object.entries(metrics)) {
    const locked = Boolean(context.cellsById.get(cellId)?.locked);
    const baselineRecord = baseline.cells[cellId];
    if (!baselineRecord || !baselineCellIds.has(cellId)) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RATCHET_CELL_SET_GROWTH",
        severity: "error",
        cellId,
        message: `${cellId} is not present in the accepted baseline cell set`,
        details: {
          baselineCellIds: [...baselineCellIds].sort((left, right) => left.localeCompare(right)),
          currentCellIds: Object.keys(metrics).sort((left, right) => left.localeCompare(right)),
        },
        suggestedResolutions: [
          codeResolution("Move the new source under an existing accepted cell if this is not an intentional architecture addition"),
          baselineResolution("Accept the new cell in the baseline", locked, { cell: cellId }),
        ],
      });
      continue;
    }

    if (baselineRecord.publicEntryPath && metric.publicEntryPath !== baselineRecord.publicEntryPath) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RATCHET_PUBLIC_ENTRY_CHANGE",
        severity: "error",
        cellId,
        message: `${cellId} public entry changed from ${baselineRecord.publicEntryPath} to ${metric.publicEntryPath}`,
        details: { previous: baselineRecord.publicEntryPath, current: metric.publicEntryPath },
        suggestedResolutions: [
          codeResolution("Keep the existing public entry path and move implementation detail behind it"),
          baselineResolution("Accept the public entry contract change in the baseline", locked, { cell: cellId, previous: baselineRecord.publicEntryPath, current: metric.publicEntryPath }),
        ],
      });
    }

    if (baselineRecord.ownedPathSet) {
      const uncovered = (metric.ownedPathSet as string[]).filter((currentPattern) => !patternCoveredByOwnedPaths(currentPattern, baselineRecord.ownedPathSet as string[]));
      if (uncovered.length > 0) {
        addFinding(findings, {
          ruleId: "CELLFENCE_RATCHET_OWNERSHIP_SCOPE_CHANGE",
          severity: "error",
          cellId,
          message: `${cellId} ownership scope expanded or shifted outside the accepted baseline: ${uncovered.join(", ")}`,
          details: { previous: baselineRecord.ownedPathSet, current: metric.ownedPathSet, uncovered },
          suggestedResolutions: [
            codeResolution("Keep new source inside an existing accepted ownership scope or create a reviewed cell change"),
            baselineResolution("Accept the ownership scope change in the baseline", locked, { cell: cellId, uncovered }),
          ],
        });
      }
    }

    if (baselineRecord.publicSymbolSet) {
      const previousSymbols = new Set(baselineRecord.publicSymbolSet);
      const addedSymbols = (metric.publicSymbolSet as string[]).filter((symbol) => !previousSymbols.has(symbol));
      if (addedSymbols.length > 0) {
        addFinding(findings, {
          ruleId: "CELLFENCE_RATCHET_PUBLIC_SYMBOL_SET_CHANGE",
          severity: "error",
          cellId,
          message: `${cellId} added public symbols outside the accepted baseline: ${addedSymbols.join(", ")}`,
          details: { previous: baselineRecord.publicSymbolSet, current: metric.publicSymbolSet, addedSymbols },
          suggestedResolutions: [
            codeResolution("Keep the new API internal or route through an existing public symbol"),
            baselineResolution("Accept the public symbol set change in the baseline", locked, { cell: cellId, addedSymbols }),
          ],
        });
      }
    }

    if (baselineRecord.dependencyEdges) {
      const previousEdges = new Set(baselineRecord.dependencyEdges);
      const addedEdges = (metric.dependencyEdges as string[]).filter((edge) => !previousEdges.has(edge));
      if (addedEdges.length > 0) {
        addFinding(findings, {
          ruleId: "CELLFENCE_RATCHET_DEPENDENCY_EDGE_CHANGE",
          severity: "error",
          cellId,
          message: `${cellId} added dependency edges outside the accepted baseline: ${addedEdges.join(", ")}`,
          details: { previous: baselineRecord.dependencyEdges, current: metric.dependencyEdges, addedEdges },
          suggestedResolutions: [
            codeResolution("Remove the new dependency edge or depend on an existing accepted cell"),
            baselineResolution("Accept the dependency edge change in the baseline", locked, { cell: cellId, addedEdges }),
          ],
        });
      }
    }

    if (baselineRecord.artifactContracts) {
      const previousArtifacts = new Set(baselineRecord.artifactContracts);
      const addedArtifacts = (metric.artifactContracts as string[]).filter((artifact) => !previousArtifacts.has(artifact));
      if (addedArtifacts.length > 0) {
        addFinding(findings, {
          ruleId: "CELLFENCE_RATCHET_ARTIFACT_CONTRACT_CHANGE",
          severity: "error",
          cellId,
          message: `${cellId} added artifact contracts outside the accepted baseline: ${addedArtifacts.join(", ")}`,
          details: { previous: baselineRecord.artifactContracts, current: metric.artifactContracts, addedArtifacts },
          suggestedResolutions: [
            codeResolution("Avoid the new artifact lane or reuse an accepted artifact contract"),
            baselineResolution("Accept the artifact contract change in the baseline", locked, { cell: cellId, addedArtifacts }),
          ],
        });
      }
    }

    if (baselineRecord.publicSurfaceHash && metric.publicSurfaceHash !== baselineRecord.publicSurfaceHash) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RATCHET_PUBLIC_SURFACE_SIGNATURE_CHANGE",
        severity: "error",
        cellId,
        message: `${cellId} public surface signature hash changed from the accepted baseline`,
        details: { previous: baselineRecord.publicSurfaceHash, current: metric.publicSurfaceHash },
        suggestedResolutions: [
          codeResolution("Keep the public type/signature contract stable or move changes behind existing exports"),
          baselineResolution("Accept the public signature change in the baseline", locked, { cell: cellId }),
        ],
      });
    }

    if (metric.ownedPathPatterns > baselineRecord.ownedPathPatterns) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RATCHET_OWNED_PATH_GROWTH",
        severity: "error",
        cellId,
        message: `${cellId} owned path patterns grew from ${baselineRecord.ownedPathPatterns} to ${metric.ownedPathPatterns}`,
        details: { metric: "ownedPathPatterns", previous: baselineRecord.ownedPathPatterns, current: metric.ownedPathPatterns },
        suggestedResolutions: [
          codeResolution("Move new files under existing owned path patterns or reduce the owned path expansion"),
          baselineResolution("Accept the owned path growth in the baseline", locked, { cell: cellId, metric: "ownedPathPatterns" }),
        ],
      });
    }
    if (metric.publicSymbols > baselineRecord.publicSymbols) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RATCHET_PUBLIC_SYMBOL_GROWTH",
        severity: "error",
        cellId,
        message: `${cellId} public symbols grew from ${baselineRecord.publicSymbols} to ${metric.publicSymbols}`,
        details: { metric: "publicSymbols", previous: baselineRecord.publicSymbols, current: metric.publicSymbols },
        suggestedResolutions: [
          codeResolution("Keep the new API internal or remove public exports that are not part of the intended contract"),
          baselineResolution("Accept the public symbol growth in the baseline", locked, { cell: cellId, metric: "publicSymbols" }),
        ],
      });
    }
    if (!baselineRecord.publicSurfaceHash && metric.publicSurfaceLines > baselineRecord.publicSurfaceLines) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RATCHET_PUBLIC_SURFACE_LINE_GROWTH",
        severity: "error",
        cellId,
        message: `${cellId} public surface lines grew from ${baselineRecord.publicSurfaceLines} to ${metric.publicSurfaceLines}`,
        details: { metric: "publicSurfaceLines", previous: baselineRecord.publicSurfaceLines, current: metric.publicSurfaceLines },
        suggestedResolutions: [
          codeResolution("Move implementation detail out of the public entry or reduce public surface size"),
          baselineResolution("Accept the public surface growth in the baseline", locked, { cell: cellId, metric: "publicSurfaceLines" }),
        ],
      });
    }
    if (metric.crossCellDependencies > baselineRecord.crossCellDependencies) {
      addFinding(findings, {
        ruleId: "CELLFENCE_RATCHET_CROSS_CELL_DEPENDENCY_GROWTH",
        severity: "error",
        cellId,
        message: `${cellId} cross-cell dependencies grew from ${baselineRecord.crossCellDependencies} to ${metric.crossCellDependencies}`,
        details: { metric: "crossCellDependencies", previous: baselineRecord.crossCellDependencies, current: metric.crossCellDependencies },
        suggestedResolutions: [
          codeResolution("Remove the new cross-cell dependency or route it through an existing allowed dependency"),
          baselineResolution("Accept the cross-cell dependency growth in the baseline", locked, { cell: cellId, metric: "crossCellDependencies" }),
        ],
      });
    }
  }
}
