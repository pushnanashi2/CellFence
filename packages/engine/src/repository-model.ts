import path from "node:path";

import type { CellBaselineRecord, CellFenceBaseline } from "@cellfence/schema";
import {
  listFiles,
  normalizePath,
  readSourceText,
  repoPath,
  sourceFilesForCell,
  sourceFilesUnderGovernance,
} from "./file-index.js";
import type { ResourceAccessReference } from "./resource-access.js";
import type {
  AnalysisContext,
  PluginImportReference,
  PluginRepositoryModel,
  PluginResourceAccess,
} from "./types.js";

function allSourceFilesByCell(context: AnalysisContext): Record<string, readonly string[]> {
  const byCell: Record<string, readonly string[]> = {};
  for (const cell of context.manifest.cells) {
    byCell[cell.id] = sourceFilesForCell(context.rootDir, cell, context).map((filePath) => repoPath(context.rootDir, filePath));
  }
  return byCell;
}

function repositoryFiles(context: AnalysisContext): readonly string[] {
  return listFiles(context.rootDir, context).map((filePath) => repoPath(context.rootDir, filePath));
}

function sourceContentsByPath(context: AnalysisContext, byCell: Record<string, readonly string[]>): Record<string, string> {
  const contents: Record<string, string> = {};
  const sourceFiles = new Set(Object.values(byCell).flat());
  for (const filePath of sourceFiles) {
    contents[filePath] = readSourceText(context, path.join(context.rootDir, filePath));
  }
  return contents;
}

function resourceAccessForPlugin(cellId: string, access: ResourceAccessReference): PluginResourceAccess {
  return {
    kind: access.kind,
    access: access.access,
    selector: access.selector,
    filePath: access.filePath,
    line: access.line,
    source: access.source,
    detectedBy: access.detectedBy,
    confidence: access.confidence,
    cellId,
    unresolved: access.unresolved,
    reason: access.reason,
  };
}

function flattenResourceAccesses(accessesByCell: Map<string, ResourceAccessReference[]>): PluginResourceAccess[] {
  const accesses: PluginResourceAccess[] = [];
  for (const [cellId, cellAccesses] of accessesByCell.entries()) {
    for (const access of cellAccesses) accesses.push(resourceAccessForPlugin(cellId, access));
  }
  return accesses.sort((left, right) =>
    `${left.cellId}:${left.kind}:${left.access}:${left.selector}:${left.filePath}:${left.line}`
      .localeCompare(`${right.cellId}:${right.kind}:${right.access}:${right.selector}:${right.filePath}:${right.line}`));
}

export function createRepositoryModel(
  context: AnalysisContext,
  baseline: CellFenceBaseline | undefined,
  observedImports: PluginImportReference[],
  accessesByCell: Map<string, ResourceAccessReference[]>,
  metrics: Record<string, CellBaselineRecord>,
  changedFiles: string[] = [],
): PluginRepositoryModel {
  const byCell = allSourceFilesByCell(context);
  return {
    rootDir: context.rootDir,
    manifest: context.manifest,
    baseline: baseline || null,
    files: {
      all: repositoryFiles(context),
      governed: sourceFilesUnderGovernance(context.rootDir, context.manifest, context).map((filePath) => repoPath(context.rootDir, filePath)),
      byCell,
      contents: sourceContentsByPath(context, byCell),
    },
    imports: observedImports,
    resources: flattenResourceAccesses(accessesByCell),
    metrics,
    changedFiles: new Set(changedFiles.map(normalizePath)),
  };
}
