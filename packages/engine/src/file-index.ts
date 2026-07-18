import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import type { CellFenceManifest, CellManifest } from "@cellfence/schema";

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".py"];

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage", ".turbo"]);
const PATTERN_REGEXP_CACHE = new Map<string, RegExp>();

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

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function patternToRegExp(pattern: string): RegExp {
  const cachedPattern = PATTERN_REGEXP_CACHE.get(pattern);
  // Stryker disable next-line ConditionalExpression: cache-hit removal only changes performance, not matcher semantics.
  if (cachedPattern) return cachedPattern;
  const normalized = normalizePath(pattern);
  let expression = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const nextCharacter = normalized[index + 1];
    if (character === "*" && nextCharacter === "*") {
      expression += ".*";
      // Stryker disable next-line AssignmentOperator: reversing the double-star skip makes the tokenizer non-terminating; ** semantics are covered by glob matching tests.
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else {
      expression += escapeRegExp(character);
    }
  }
  const regexp = new RegExp(`^${expression}$`);
  PATTERN_REGEXP_CACHE.set(pattern, regexp);
  return regexp;
}

export function matchesPattern(relativePath: string, pattern: string): boolean {
  return patternToRegExp(pattern).test(normalizePath(relativePath));
}

export function literalPrefix(pattern: string): string {
  const normalized = normalizePath(pattern);
  const wildcardIndex = normalized.search(/[*?]/);
  const prefix = wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex);
  return prefix.replace(/\/+$/, "");
}

export function listFiles(rootDir: string, context?: FileIndexContext): string[] {
  if (context?.listFilesCache) return context.listFilesCache;
  const files: string[] = [];
  function visit(directoryPath: string): void {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      } else if (entry.isSymbolicLink()) {
        try {
          if (fs.statSync(entryPath).isFile()) files.push(entryPath);
        } catch {
          // Broken symlinks are handled by listSymlinks; listFiles stays a source-file inventory.
        }
      }
    }
  }
  visit(rootDir);
  const sortedFiles = files.sort((left, right) => left.localeCompare(right));
  if (context) context.listFilesCache = sortedFiles;
  return sortedFiles;
}

export function listSymlinks(rootDir: string): SymlinkEntry[] {
  const symlinks: SymlinkEntry[] = [];
  function visit(directoryPath: string): void {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isSymbolicLink()) {
        try {
          symlinks.push({ path: entryPath, targetPath: fs.realpathSync(entryPath) });
        } catch (error) {
          symlinks.push({ path: entryPath, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }
  visit(rootDir);
  return symlinks.sort((left, right) => left.path.localeCompare(right.path));
}

function buildSourceFilesByCellIndex(rootDir: string, manifest: CellFenceManifest, context: FileIndexContext): Map<string, string[]> {
  if (context.sourceFilesByCellIndex) return context.sourceFilesByCellIndex;
  const index = new Map<string, string[]>();
  for (const cell of manifest.cells) index.set(cell.id, []);
  for (const filePath of listFiles(rootDir, context)) {
    const relativePath = repoPath(rootDir, filePath);
    if (!SOURCE_EXTENSIONS.includes(path.extname(filePath))) continue;
    if (pathExcludedByGovernance(manifest, relativePath)) continue;
    for (const cell of manifest.cells) {
      if (!cell.ownedPaths.some((pattern) => matchesPattern(relativePath, pattern))) continue;
      // Stryker disable next-line OptionalChaining: the map is initialized for every manifest cell before iteration.
      index.get(cell.id)?.push(filePath);
    }
  }
  for (const files of index.values()) files.sort((left, right) => left.localeCompare(right));
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
    return SOURCE_EXTENSIONS.includes(path.extname(filePath)) && cell.ownedPaths.some((pattern) => matchesPattern(relativePath, pattern));
  });
  return files;
}

function pathExcludedByGovernance(manifest: CellFenceManifest, relativePath: string): boolean {
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
    return SOURCE_EXTENSIONS.includes(path.extname(filePath))
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
  return cell.ownedPaths.some((pattern) => matchesPattern(relativePath, pattern));
}

export function patternCoveredByOwnedPaths(pattern: string, ownedPaths: string[]): boolean {
  const normalizedPattern = normalizePath(pattern);
  const targetPrefix = literalPrefix(pattern) || normalizePath(pattern);
  return ownedPaths.some((ownedPath) => {
    if (matchesPattern(targetPrefix, ownedPath)) return true;
    const ownedPrefix = literalPrefix(ownedPath);
    // Stryker disable next-line ConditionalExpression: prefix-less owner patterns fall through to the same false containment result below.
    if (!ownedPrefix) return false;
    if (targetPrefix.startsWith(`${ownedPrefix}/`)) return true;
    // Stryker disable next-line ConditionalExpression: previous exact/prefix guards make the remaining boolean reductions equivalent for supported ownership globs.
    return targetPrefix === ownedPrefix && (normalizedPattern === ownedPrefix || normalizedPattern.startsWith(`${ownedPrefix}/`));
  });
}

export function sourceKindForPath(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  if (extension === ".py") return ts.ScriptKind.Unknown;
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
