import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import type { CellFenceManifest, CellManifest } from "@cellfence/schema";

import { expandedGlobPatterns, matchesGlobPattern } from "./glob.js";
import { pathPatternSubset } from "./glob-overlap.js";
import { stableStringCompare } from "./governance/canonicalization.js";

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".py", ".pyi"];

const ALWAYS_IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  ".tox",
  ".nox",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
]);
const DEFAULT_GENERATED_DIRECTORIES = new Set(["dist", "coverage", ".turbo"]);

export type FileIndexContext = {
  rootDir: string;
  manifest: CellFenceManifest;
  listFilesCache?: string[];
  sourceFilesForCellCache: Map<string, string[]>;
  sourceFilesByCellIndex?: Map<string, string[]>;
  sourceTextCache: Map<string, string>;
  sourceFileCache: Map<string, ts.SourceFile>;
};

export type SymlinkEntry = {
  path: string;
  targetPath?: string;
  targetType?: "file" | "directory" | "other";
  error?: string;
};

export function normalizePath(filePath: string): string {
  const slashPath = filePath.replace(/\\/g, "/");
  return slashPath === "" ? "" : path.posix.normalize(slashPath);
}

export function repoPath(rootDir: string, filePath: string): string {
  return normalizePath(path.relative(rootDir, filePath));
}

export function absolutePath(rootDir: string, relativePath: string): string {
  return path.resolve(rootDir, normalizePath(relativePath));
}

export function matchesPattern(relativePath: string, pattern: string): boolean {
  return matchesGlobPattern(normalizePath(relativePath), pattern);
}

export function sourceExtensionForPath(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

export function isSourceFilePath(filePath: string): boolean {
  return SOURCE_EXTENSIONS.includes(sourceExtensionForPath(filePath));
}

export function literalPrefix(pattern: string): string {
  const normalized = normalizePath(pattern);
  const wildcardIndex = normalized.search(/[*]/);
  const prefix = wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex);
  // Stryker disable next-line Regex: normalizePath collapses trailing separators, so one-or-more and one recognize the same prefix language here.
  return prefix.replace(/\/+$/, "");
}

function directoryHasExplicitGovernance(rootDir: string, directoryPath: string, context?: FileIndexContext): boolean {
  if (!context) return false;
  const relativeDirectory = repoPath(rootDir, directoryPath);
  const probePaths = SOURCE_EXTENSIONS.map((extension) => `${relativeDirectory}/__cellfence_probe__${extension}`);
  const manifest = context.manifest;
  if (manifest.governance?.include?.some((pattern) => probePaths.some((probePath) => matchesPattern(probePath, pattern)))) return true;
  return manifest.cells.some((cell) => cell.ownedPaths.some((pattern) => probePaths.some((probePath) => matchesPattern(probePath, pattern))));
}

function directoryExcludedByGovernance(rootDir: string, directoryPath: string, context?: FileIndexContext): boolean {
  // Stryker disable all: without a context, generated directories are already ignored by the explicit-governance fallback in shouldIgnoreDirectory.
  if (!context) return false;
  // Stryker restore all
  const relativeDirectory = repoPath(rootDir, directoryPath);
  const probePaths = [
    relativeDirectory,
    ...SOURCE_EXTENSIONS.map((extension) => `${relativeDirectory}/__cellfence_probe__${extension}`),
  ];
  const excludePatterns = context.manifest.governance?.exclude;
  if (!excludePatterns) return false;
  return excludePatterns.some((pattern) => probePaths.some((probePath) => matchesPattern(probePath, pattern)));
}

function shouldIgnoreDirectory(rootDir: string, directoryPath: string, directoryName: string, context?: FileIndexContext): boolean {
  if (ALWAYS_IGNORED_DIRECTORIES.has(directoryName)) return true;
  if (!DEFAULT_GENERATED_DIRECTORIES.has(directoryName)) return false;
  if (directoryExcludedByGovernance(rootDir, directoryPath, context)) return true;
  return !directoryHasExplicitGovernance(rootDir, directoryPath, context);
}

export function listFiles(rootDir: string, context?: FileIndexContext): string[] {
  if (context?.listFilesCache) return context.listFilesCache;
  const files: string[] = [];
  const realRootDir = fs.existsSync(rootDir) ? fs.realpathSync(rootDir) : path.resolve(rootDir);
  const visitedDirectories = new Set<string>();
  const pathInsideRoot = (targetPath: string): boolean => {
    const relativePath = path.relative(realRootDir, targetPath);
    return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
  };
  function visit(directoryPath: string): void {
    const realDirectoryPath = fs.existsSync(directoryPath) ? fs.realpathSync(directoryPath) : path.resolve(directoryPath);
    if (!pathInsideRoot(realDirectoryPath) || visitedDirectories.has(realDirectoryPath)) return;
    visitedDirectories.add(realDirectoryPath);
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory() && shouldIgnoreDirectory(rootDir, entryPath, entry.name, context)) continue;
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      } else if (entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(entryPath);
          if (stat.isFile()) files.push(entryPath);
          else if (stat.isDirectory() && !shouldIgnoreDirectory(rootDir, entryPath, entry.name, context)) visit(entryPath);
        } catch {
          // Broken symlinks are handled by listSymlinks; listFiles stays a source-file inventory.
        }
      }
    }
  }
  visit(rootDir);
  const sortedFiles = files.sort();
  if (context) context.listFilesCache = sortedFiles;
  return sortedFiles;
}

export function listSymlinks(rootDir: string): SymlinkEntry[] {
  const symlinks: SymlinkEntry[] = [];
  function visit(directoryPath: string): void {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory() && shouldIgnoreDirectory(rootDir, entryPath, entry.name)) continue;
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(entryPath);
          const targetType = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
          symlinks.push({ path: entryPath, targetPath: fs.realpathSync(entryPath), targetType });
        } catch (error) {
          symlinks.push({ path: entryPath, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }
  visit(rootDir);
  return symlinks.sort((left, right) => stableStringCompare(left.path, right.path));
}

function buildSourceFilesByCellIndex(rootDir: string, manifest: CellFenceManifest, context: FileIndexContext): Map<string, string[]> {
  if (context.sourceFilesByCellIndex) return context.sourceFilesByCellIndex;
  const index = new Map<string, string[]>();
  for (const cell of manifest.cells) index.set(cell.id, []);
  for (const filePath of listFiles(rootDir, context)) {
    const relativePath = repoPath(rootDir, filePath);
    if (!isSourceFilePath(filePath)) continue;
    if (pathExcludedByGovernance(manifest, relativePath)) continue;
    for (const cell of manifest.cells) {
      if (!cell.ownedPaths.some((pattern) => matchesPattern(relativePath, pattern))) continue;
      // Stryker disable next-line OptionalChaining: the map is initialized for every manifest cell before iteration.
      index.get(cell.id)?.push(filePath);
    }
  }
  for (const files of index.values()) files.sort();
  context.sourceFilesByCellIndex = index;
  return index;
}

export function sourceFilesForCell(rootDir: string, cell: CellManifest, context?: FileIndexContext): string[] {
  if (context) {
    const indexedFiles = buildSourceFilesByCellIndex(rootDir, context.manifest, context).get(cell.id) || [];
    return indexedFiles;
  }
  const files = listFiles(rootDir).filter((filePath) => {
    const relativePath = repoPath(rootDir, filePath);
    return isSourceFilePath(filePath) && pathOwnedByCell(cell, relativePath);
  });
  return files;
}

function pathExcludedByGovernance(manifest: CellFenceManifest, relativePath: string): boolean {
  // Stryker disable next-line ArrayDeclaration: the synthetic exact fallback has no supported source extension and cannot exclude an indexed source file.
  return (manifest.governance?.exclude || []).some((pattern) => matchesPattern(relativePath, pattern));
}

export function sourceFilesUnderGovernance(rootDir: string, manifest: CellFenceManifest, context?: FileIndexContext): string[] {
  const governance = manifest.governance;
  if (!governance?.requireOwnership) return [];
  // Stryker disable next-line ArrayDeclaration: a synthetic exact "Stryker was here" include cannot match any source-extension file.
  const include = governance.include || [];
  // Stryker disable next-line ArrayDeclaration: a synthetic exact "Stryker was here" exclude cannot match any source-extension file.
  const exclude = governance.exclude || [];
  return listFiles(rootDir, context).filter((filePath) => {
    const relativePath = repoPath(rootDir, filePath);
    return isSourceFilePath(filePath)
      && include.some((pattern) => matchesPattern(relativePath, pattern))
      && !exclude.some((pattern) => matchesPattern(relativePath, pattern));
  });
}

export function pathIsGoverned(manifest: CellFenceManifest, relativePath: string): boolean {
  const governance = manifest.governance;
  if (!governance?.requireOwnership) return false;
  const include = governance.include || [];
  const exclude = governance.exclude || [];
  return include.some((pattern) => matchesPattern(relativePath, pattern))
    && !exclude.some((pattern) => matchesPattern(relativePath, pattern));
}

export function pathOwnedByCell(cell: CellManifest, relativePath: string): boolean {
  return cell.ownedPaths.some((pattern) => expandOwnedPath(pattern).some((expanded) => matchesPattern(relativePath, expanded)));
}

export function patternCoveredByOwnedPaths(pattern: string, ownedPaths: string[]): boolean {
  // B-04 review fix: the previous implementation used a
  // literal-prefix heuristic, which produced false-positive
  // containment. The 0.4.1 implementation delegates the
  // containment test to `pathPatternSubset`, which is a
  // proper NFA->DFA subset check: L(pattern) is contained
  // in L(ownedPath) iff the product DFA of `pattern` and
  // `complement(ownedPath)` has no accept state reachable
  // from the start state. This catches sibling-prefix cases
  // such as `src/api-client/**` not being covered by
  // `src/api/**`, which the prefix heuristic would have
  // reported as covered.
  //
  // A bare owned path such as `src/core` is treated as a
  // directory ownership: it covers `src/core` and all of
  // its descendants, i.e. L(`src/core`) union L(`src/core/**`).
  // This matches the previous prefix heuristic for the
  // "directory" cases (e.g. `src/core/nested/**` is covered
  // by `src/core`) without re-introducing the false
  // positives for sibling directories (e.g. `src/corex/**`
  // is still NOT covered by `src/core/**`).
  const expandedOwnedPaths = ownedPaths.flatMap(expandOwnedPath);
  // Stryker disable next-line ConditionalExpression,StringLiteral: empty normalized inner patterns are rejected by `pathPatternSubset`; changing this guard cannot make a schema-valid path covered.
  return expandedGlobPatterns(pattern).every((expandedPattern) =>
    expandedPattern !== "" && expandedOwnedPaths.some((ownedPath) => pathPatternSubset(expandedPattern, ownedPath)));
}

function expandOwnedPath(ownedPath: string): string[] {
  if (ownedPath.includes("*")) return [ownedPath];
  const trimmed = ownedPath.replace(/\/$/, "");
  return [trimmed, `${trimmed}/**`];
}

export function sourceKindForPath(filePath: string): ts.ScriptKind {
  const extension = sourceExtensionForPath(filePath);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  if (extension === ".py" || extension === ".pyi") return ts.ScriptKind.Unknown;
  return ts.ScriptKind.TS;
}

export function readSourceText(context: FileIndexContext, filePath: string): string {
  const normalizedFilePath = path.resolve(filePath);
  const cachedText = context.sourceTextCache.get(normalizedFilePath);
  if (cachedText !== undefined) return cachedText;
  const sourceText = fs.readFileSync(normalizedFilePath, "utf8");
  context.sourceTextCache.set(normalizedFilePath, sourceText);
  return sourceText;
}

export function parseSourceFile(context: FileIndexContext, filePath: string): ts.SourceFile {
  const normalizedFilePath = path.resolve(filePath);
  const cachedSourceFile = context.sourceFileCache.get(normalizedFilePath);
  if (cachedSourceFile) return cachedSourceFile;
  const sourceFile = ts.createSourceFile(normalizedFilePath, readSourceText(context, normalizedFilePath), ts.ScriptTarget.Latest, true, sourceKindForPath(normalizedFilePath));
  context.sourceFileCache.set(normalizedFilePath, sourceFile);
  return sourceFile;
}
