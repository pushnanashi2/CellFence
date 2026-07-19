import fs from "node:fs";
import path from "node:path";

import type { CellBaselineRecord, CellFenceBaseline, CellFenceManifest } from "@cellfence/schema";

import { DEFAULT_MANIFEST_PATH } from "./constants.js";
import { defaultBaselinePath, loadBaselineFromFile } from "./baseline.js";
import { repoPath } from "./file-index.js";
import type {
  AnalysisContext,
  CellFenceContext,
  CheckOptions,
  CheckResult,
  ContextAllowedImport,
  ContextBudgetEntry,
  ContextOptions,
} from "./types.js";

type ContextOperationDependencies = {
  checkRepository(options?: CheckOptions): CheckResult;
  createContext(rootDir: string, manifest: CellFenceManifest): AnalysisContext;
  loadManifestFromFile(manifestPath: string): CellFenceManifest;
};

function loadOptionalBaseline(rootDir: string, baselinePath: string | undefined): CellFenceBaseline | undefined {
  const resolvedBaselinePath = baselinePath
    ? path.resolve(rootDir, baselinePath)
    : defaultBaselinePath(rootDir);
  if (!fs.existsSync(resolvedBaselinePath)) return undefined;
  return loadBaselineFromFile(resolvedBaselinePath);
}

function budgetEntry(current: number, limit: number, source: ContextBudgetEntry["source"]): ContextBudgetEntry {
  return {
    current,
    limit,
    remaining: limit - current,
    source,
  };
}

export function createCellContext(
  options: ContextOptions,
  dependencies: ContextOperationDependencies,
): CellFenceContext {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  const manifest = dependencies.loadManifestFromFile(manifestPath);
  const context = dependencies.createContext(rootDir, manifest);
  const cell = context.cellsById.get(options.cellId);
  if (!cell) {
    throw new Error(`unknown cell ${options.cellId}`);
  }

  const baseline = loadOptionalBaseline(rootDir, options.baselinePath);
  const currentResult = dependencies.checkRepository({
    rootDir,
    manifestPath: repoPath(rootDir, manifestPath),
    evidencePaths: options.evidencePaths,
  });
  const currentMetrics = currentResult.metrics[cell.id];
  const baselineRecord = baseline?.cells[cell.id];
  const budgets: CellFenceContext["budgets"] = {};

  for (const metric of ["ownedPathPatterns", "publicSymbols", "publicSurfaceLines", "crossCellDependencies"] as const) {
    const current = (currentMetrics as CellBaselineRecord)[metric];
    const manifestLimit = cell.budgets?.[metric];
    if (typeof manifestLimit === "number") {
      budgets[metric] = budgetEntry(current, manifestLimit, "manifest-budget");
    } else if (baselineRecord && typeof baselineRecord[metric] === "number") {
      budgets[metric] = budgetEntry(current, baselineRecord[metric], "baseline-ratchet");
    }
  }

  const allowedImports: ContextAllowedImport[] = (cell.consumes ?? []).flatMap((consumer) => {
    const producer = context.cellsById.get(consumer.cell);
    if (!producer) return [];
    return [{
      cell: producer.id,
      publicEntry: producer.publicEntry,
      packageName: producer.packageName,
      locked: Boolean(producer.locked),
      artifactLanes: consumer.artifactLanes || [],
    }];
  });

  return {
    schemaVersion: "cellfence.context.v1",
    cell: {
      id: cell.id,
      packageName: cell.packageName,
      locked: Boolean(cell.locked),
      ownedPaths: cell.ownedPaths,
      publicEntry: cell.publicEntry,
      publicSymbols: cell.publicSymbols,
    },
    allowedImports,
    allowedResources: cell.resourceContracts || [],
    baselineResources: baselineRecord?.resourceAccesses || [],
    producedArtifacts: cell.producesArtifacts || [],
    budgets,
    guidance: [
      "Create and edit source only inside ownedPaths unless a human changes the manifest.",
      "Cross-cell imports must use the listed publicEntry or packageName surfaces.",
      "Do not import another cell's internal implementation paths.",
      "Resource access must match allowedResources or existing baselineResources.",
      "Baseline updates expand the fence and should be treated as review-sensitive changes.",
    ],
  };
}
