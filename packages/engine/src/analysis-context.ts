import fs from "node:fs";
import path from "node:path";
import type * as ts from "typescript";

import type { CellFenceManifest, CellManifest } from "@cellfence/schema";
import { absolutePath, matchesPattern, repoPath } from "./file-index.js";
import { readWorkspacePathAliases } from "./module-resolution.js";
import type { AnalysisContext } from "./types.js";

export function findOwningCell(manifest: CellFenceManifest, relativePath: string): CellManifest | undefined {
  return manifest.cells.find((cell) => cell.ownedPaths.some((pattern) => matchesPattern(relativePath, pattern)));
}

export function owningCells(manifest: CellFenceManifest, relativePath: string): CellManifest[] {
  return manifest.cells.filter((cell) => cell.ownedPaths.some((pattern) => matchesPattern(relativePath, pattern)));
}

function findPackageRoot(rootDir: string, publicEntry: string): string | undefined {
  let directoryPath = path.dirname(absolutePath(rootDir, publicEntry));
  while (directoryPath.startsWith(rootDir)) {
    if (fs.existsSync(path.join(directoryPath, "package.json"))) {
      return repoPath(rootDir, directoryPath);
    }
    const parentPath = path.dirname(directoryPath);
    /* c8 ignore next -- Safety guard for filesystem roots; normal repo roots exit via the while condition. */
    if (parentPath === directoryPath) break;
    directoryPath = parentPath;
  }
  return undefined;
}

export function createContext(rootDir: string, manifest: CellFenceManifest): AnalysisContext {
  const cellsById = new Map<string, CellManifest>();
  const packageToCell = new Map<string, CellManifest>();
  const packageRoots = new Map<string, string>();
  for (const cell of manifest.cells) {
    cellsById.set(cell.id, cell);
    if (cell.packageName) {
      packageToCell.set(cell.packageName, cell);
      const packageRoot = findPackageRoot(rootDir, cell.publicEntry);
      if (packageRoot) packageRoots.set(cell.packageName, packageRoot);
    }
  }
  return {
    rootDir,
    manifest,
    cellsById,
    packageToCell,
    packageRoots,
    pathAliases: readWorkspacePathAliases(rootDir),
    sourceFilesForCellCache: new Map<string, string[]>(),
    sourceTextCache: new Map<string, string>(),
    sourceFileCache: new Map<string, ts.SourceFile>(),
  };
}
