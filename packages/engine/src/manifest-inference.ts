import fs from "node:fs";
import path from "node:path";

import {
  CELLFENCE_MANIFEST_SCHEMA_VERSION,
  type CellFenceManifest,
  type CellManifest,
} from "@cellfence/schema";
import {
  listFiles,
  matchesPattern,
  normalizePath,
  repoPath,
  SOURCE_EXTENSIONS,
  type FileIndexContext,
} from "./file-index.js";
import {
  candidateModulePaths,
  extractImports,
  extractPublicSymbols,
  readPathAliases,
  resolvePythonImport,
  resolvePathAliasTarget,
  resolveRelativeImport,
} from "./module-resolution.js";

type CellCandidate = {
  id: string;
  root: string;
  ownedPaths: string[];
  publicEntry: string;
  packageName?: string;
  packageRoot?: string;
};

export type InferManifestScope = "all" | "production";
export type InferManifestPackagePolicyHints = "include" | "ignore";

export type InferManifestOptions = {
  rootDir?: string;
  scope?: InferManifestScope;
  packagePolicyHints?: InferManifestPackagePolicyHints;
};

const PUBLIC_ENTRY_BASENAMES = ["public", "index"];
const PYTHON_PUBLIC_ENTRY_BASENAMES = ["__init__", "api", "main"];
const PACKAGE_ENTRY_FIELDS = ["source", "types", "typings", "module", "main", "browser"];
const PACKAGE_DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"];
const SOURCE_CONTAINER_ROOTS = ["apps", "packages", "libs", "services"];
const TOP_LEVEL_SOURCE_ROOTS = [
  "api",
  "app",
  "client",
  "components",
  "contexts",
  "frontend",
  "hooks",
  "lib",
  "middleware",
  "pages",
  "routes",
  "server",
  "shared",
  "stores",
  "utils",
  "web",
  "website",
];
const PRODUCTION_SCOPE_EXCLUDES = [
  "**/__fixtures__/**",
  "**/__mocks__/**",
  "**/__tests__/**",
  "**/*.bench.*",
  "**/*.benchmark.*",
  "**/*.css",
  "**/*.d.ts",
  "**/*.gen.*",
  "**/*.generated.*",
  "**/*.gif",
  "**/*.jpeg",
  "**/*.jpg",
  "**/*.less",
  "**/*.md",
  "**/*.module.css",
  "**/*.module.scss",
  "**/*.png",
  "**/*.sass",
  "**/*.scss",
  "**/*.spec.*",
  "**/*.stories.*",
  "**/*.story.*",
  "**/*.styl",
  "**/*.svg",
  "**/*.test.*",
  "**/*.vue",
  "**/*.webp",
  "**/bench/**",
  "**/benchmark/**",
  "**/benchmarks/**",
  "**/build/**",
  "**/demo/**",
  "**/demos/**",
  "**/dist/**",
  "**/example/**",
  "**/examples/**",
  "**/fixture/**",
  "**/fixtures/**",
  "**/generated/**",
  "**/test/**",
  "**/tests/**",
  "**/third_party/**",
  "**/vendor/**",
];
const DEFAULT_REQUIRED_RULES = [
  "CELLFENCE_OWNERSHIP_OVERLAP",
  "CELLFENCE_UNOWNED_SOURCE",
  "CELLFENCE_UNOWNED_IMPORT_TARGET",
  "CELLFENCE_PUBLIC_ENTRY_OUTSIDE_OWNERSHIP",
  "CELLFENCE_ARTIFACT_OUTSIDE_OWNERSHIP",
  "CELLFENCE_SYMLINK_TARGET_OUTSIDE_OWNERSHIP",
  "CELLFENCE_PRIVATE_IMPORT",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
  "CELLFENCE_REQUIRED_RULE_DISABLED",
  "CELLFENCE_WAIVER_INVALID",
];

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceFiles(rootDir: string): string[] {
  return listFiles(rootDir).filter((filePath) => SOURCE_EXTENSIONS.includes(path.extname(filePath)));
}

function hasSourceFiles(rootDir: string, relativeRoot: string, scope?: InferManifestScope): boolean {
  const normalizedRoot = normalizePath(relativeRoot).replace(/\/+$/, "");
  return sourceFiles(rootDir).some((filePath) => {
    const relativePath = repoPath(rootDir, filePath);
    return !pathExcludedByScope(scope, relativePath) && (relativePath === normalizedRoot || relativePath.startsWith(`${normalizedRoot}/`));
  });
}

function sourceFilesInRoot(rootDir: string, relativeRoot: string, scope?: InferManifestScope): string[] {
  const pattern = `${normalizePath(relativeRoot).replace(/\/+$/, "")}/**`;
  return sourceFiles(rootDir)
    .map((filePath) => repoPath(rootDir, filePath))
    .filter((relativePath) => matchesPattern(relativePath, pattern))
    .filter((relativePath) => !pathExcludedByScope(scope, relativePath))
    .sort((left, right) => left.localeCompare(right));
}

function sourceFilesDirectlyUnder(rootDir: string, relativeRoot: string, scope?: InferManifestScope): string[] {
  const normalizedRoot = normalizePath(relativeRoot).replace(/\/+$/, "");
  return sourceFiles(rootDir)
    .map((filePath) => repoPath(rootDir, filePath))
    .filter((relativePath) => path.posix.dirname(relativePath) === normalizedRoot)
    .filter((relativePath) => !pathExcludedByScope(scope, relativePath))
    .sort((left, right) => left.localeCompare(right));
}

function directoryChildrenWithSources(rootDir: string, relativeRoot: string, scope?: InferManifestScope): string[] {
  const absoluteRoot = path.join(rootDir, relativeRoot);
  if (!fs.existsSync(absoluteRoot) || !fs.statSync(absoluteRoot).isDirectory()) return [];
  return fs.readdirSync(absoluteRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => normalizePath(path.posix.join(relativeRoot, entry.name)))
    .filter((childRoot) => hasSourceFiles(rootDir, childRoot, scope))
    .sort((left, right) => left.localeCompare(right));
}

function packageNameFromRoot(rootDir: string, relativeRoot: string): string | undefined {
  const packageJson = readJsonFile(path.join(rootDir, relativeRoot, "package.json"));
  if (!isRecord(packageJson) || typeof packageJson.name !== "string" || packageJson.name.trim().length === 0) return undefined;
  return packageJson.name;
}

function packageJsonFromRoot(rootDir: string, relativeRoot: string): Record<string, unknown> | undefined {
  const packageJson = readJsonFile(path.join(rootDir, relativeRoot, "package.json"));
  return isRecord(packageJson) ? packageJson : undefined;
}

function readTextFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function sanitizeCellId(input: string): string {
  const unscoped = input.includes("/") ? input.split("/").at(-1) || input : input;
  const sanitized = unscoped
    .replace(/^@/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "cell";
}

function pythonImportPackageName(input: string): string {
  return input
    .trim()
    .replace(/[-.]+/g, "_")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function uniqueId(baseId: string, usedIds: Set<string>): string {
  let candidateId = baseId;
  let suffix = 2;
  while (usedIds.has(candidateId)) {
    candidateId = `${baseId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidateId);
  return candidateId;
}

function pythonMetadataNameFromPyproject(rootDir: string): string | undefined {
  const text = readTextFile(path.join(rootDir, "pyproject.toml"));
  if (!text) return undefined;
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (!["project", "tool.poetry"].includes(section)) continue;
    const nameMatch = line.match(/^\s*name\s*=\s*["']([^"']+)["']/);
    if (nameMatch && nameMatch[1].trim().length > 0) return nameMatch[1].trim();
  }
  return undefined;
}

function pythonMetadataNameFromSetupCfg(rootDir: string): string | undefined {
  const text = readTextFile(path.join(rootDir, "setup.cfg"));
  if (!text) return undefined;
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (section !== "metadata") continue;
    const nameMatch = line.match(/^\s*name\s*=\s*([^\s#]+)\s*$/);
    if (nameMatch && nameMatch[1].trim().length > 0) return nameMatch[1].trim();
  }
  return undefined;
}

function pythonMetadataNameFromSetupPy(rootDir: string): string | undefined {
  const text = readTextFile(path.join(rootDir, "setup.py"));
  if (!text) return undefined;
  const match = text.match(/\bsetup\s*\([\s\S]{0,4000}?\bname\s*=\s*["']([^"']+)["']/);
  if (match && match[1].trim().length > 0) return match[1].trim();
  const constants = new Map<string, string>();
  for (const constantMatch of text.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*["']([^"']+)["']/gm)) {
    constants.set(constantMatch[1], constantMatch[2]);
  }
  const identifierMatch = text.match(/\bsetup\s*\([\s\S]{0,4000}?\bname\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\b/);
  if (identifierMatch) return constants.get(identifierMatch[1]);
  return undefined;
}

function addPythonSourceRoot(roots: Set<string>, root: string | undefined): void {
  if (!root) return;
  const normalized = normalizePath(root).replace(/\/+$/, "");
  roots.add(normalized === "." ? "" : normalized);
}

function pythonSourceRootsFromPyproject(rootDir: string): string[] {
  const text = readTextFile(path.join(rootDir, "pyproject.toml"));
  if (!text) return [];
  const roots = new Set<string>();
  for (const match of text.matchAll(/(?:package-dir|package_dir)\s*=\s*\{[^}]*["']{0,1}["']{0,1}\s*=\s*["']([^"']+)["'][^}]*\}/g)) {
    addPythonSourceRoot(roots, match[1]);
  }
  for (const match of text.matchAll(/\bwhere\s*=\s*\[([^\]]+)\]/g)) {
    for (const rootMatch of match[1].matchAll(/["']([^"']+)["']/g)) addPythonSourceRoot(roots, rootMatch[1]);
  }
  for (const match of text.matchAll(/\bfrom\s*=\s*["']([^"']+)["']/g)) {
    addPythonSourceRoot(roots, match[1]);
  }
  return [...roots];
}

function pythonSourceRootsFromSetupCfg(rootDir: string): string[] {
  const text = readTextFile(path.join(rootDir, "setup.cfg"));
  if (!text) return [];
  const roots = new Set<string>();
  let section = "";
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (section === "options" && /^\s*package_dir\s*=\s*$/.test(line)) {
      for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
        const blockLine = lines[blockIndex];
        if (blockLine.trim().length === 0) continue;
        if (/^\S/.test(blockLine)) break;
        const match = blockLine.match(/^\s*=\s*([^\s#]+)\s*$/);
        if (match) addPythonSourceRoot(roots, match[1]);
      }
    }
    if (section === "options.packages.find") {
      const match = line.match(/^\s*where\s*=\s*([^\s#]+)\s*$/);
      if (match) addPythonSourceRoot(roots, match[1]);
    }
  }
  return [...roots];
}

function pythonSourceRootsFromSetupPy(rootDir: string): string[] {
  const text = readTextFile(path.join(rootDir, "setup.py"));
  if (!text) return [];
  const roots = new Set<string>();
  for (const match of text.matchAll(/\bpackage_dir\s*=\s*\{[\s\S]{0,1000}?["']\s*["']\s*:\s*["']([^"']+)["']/g)) {
    addPythonSourceRoot(roots, match[1]);
  }
  for (const match of text.matchAll(/\bfind(?:_namespace)?_packages\s*\(\s*["']([^"']+)["']/g)) {
    addPythonSourceRoot(roots, match[1]);
  }
  for (const match of text.matchAll(/\bfind(?:_namespace)?_packages\s*\([\s\S]{0,500}?\bwhere\s*=\s*["']([^"']+)["']/g)) {
    addPythonSourceRoot(roots, match[1]);
  }
  return [...roots];
}

function pythonPackagingSourceRoots(rootDir: string): string[] {
  const roots = new Set<string>();
  for (const root of pythonSourceRootsFromPyproject(rootDir)) addPythonSourceRoot(roots, root);
  for (const root of pythonSourceRootsFromSetupCfg(rootDir)) addPythonSourceRoot(roots, root);
  for (const root of pythonSourceRootsFromSetupPy(rootDir)) addPythonSourceRoot(roots, root);
  if (fs.existsSync(path.join(rootDir, "src")) && fs.statSync(path.join(rootDir, "src")).isDirectory()) roots.add("src");
  roots.add("");
  return [...roots].sort((left, right) => left.localeCompare(right));
}

function pythonProjectName(rootDir: string): string | undefined {
  return pythonMetadataNameFromPyproject(rootDir) || pythonMetadataNameFromSetupCfg(rootDir) || pythonMetadataNameFromSetupPy(rootDir);
}

function workspacePatterns(rootDir: string): string[] {
  const packageJson = readJsonFile(path.join(rootDir, "package.json"));
  if (!isRecord(packageJson)) return [];
  const workspaces = packageJson.workspaces;
  if (Array.isArray(workspaces)) return workspaces.filter((entry): entry is string => typeof entry === "string");
  if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
    return workspaces.packages.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function expandWorkspacePattern(rootDir: string, pattern: string): string[] {
  const normalized = normalizePath(pattern).replace(/\/+$/, "");
  const wildcardIndex = normalized.indexOf("*");
  if (wildcardIndex === -1) return fs.existsSync(path.join(rootDir, normalized)) ? [normalized] : [];
  const slashBeforeWildcard = normalized.lastIndexOf("/", wildcardIndex);
  const parent = slashBeforeWildcard === -1 ? "." : normalized.slice(0, slashBeforeWildcard);
  const suffix = normalized.slice(wildcardIndex + 1);
  const absoluteParent = path.join(rootDir, parent);
  if (!fs.existsSync(absoluteParent) || !fs.statSync(absoluteParent).isDirectory()) return [];
  return fs.readdirSync(absoluteParent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => normalizePath(path.posix.join(parent, `${entry.name}${suffix}`)))
    .filter((workspaceRoot) => fs.existsSync(path.join(rootDir, workspaceRoot)))
    .sort((left, right) => left.localeCompare(right));
}

function exportValueStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => exportValueStrings(entry));
  if (!isRecord(value)) return [];
  const preferredKeys = ["source", "types", "typings", "import", "require", "default"];
  return preferredKeys.flatMap((key) => exportValueStrings(value[key]));
}

function packageExportEntryStrings(exportsField: unknown): string[] {
  if (typeof exportsField === "string" || Array.isArray(exportsField)) return exportValueStrings(exportsField);
  if (!isRecord(exportsField)) return [];
  if (exportsField["."] !== undefined) return exportValueStrings(exportsField["."]);
  return exportValueStrings(exportsField);
}

function pathWithinRoot(relativeRoot: string, candidatePath: string): boolean {
  const normalizedRoot = normalizePath(relativeRoot).replace(/\/+$/, "");
  const normalizedPath = normalizePath(candidatePath);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function parentPrefix(relativePath: string): string {
  const normalized = normalizePath(relativePath);
  const parent = path.posix.dirname(normalized);
  return parent === "." ? "" : parent;
}

function existingPackageEntry(rootDir: string, packageRoot: string, relativeRoot: string, entryPath: string, scope?: InferManifestScope): string | undefined {
  const withoutLeadingDot = entryPath.replace(/^\.\//, "");
  if (withoutLeadingDot.startsWith("../") || path.isAbsolute(withoutLeadingDot)) return undefined;
  const absoluteBasePath = path.join(rootDir, packageRoot, withoutLeadingDot);
  for (const candidatePath of candidateModulePaths(absoluteBasePath)) {
    if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) continue;
    const relativePath = repoPath(rootDir, candidatePath);
    if (pathExcludedByScope(scope, relativePath)) continue;
    if (pathWithinRoot(relativeRoot, relativePath)) return relativePath;
  }
  return undefined;
}

function publicEntryFromPackageJson(rootDir: string, packageRoot: string, relativeRoot: string, scope?: InferManifestScope): string | undefined {
  const packageJson = packageJsonFromRoot(rootDir, packageRoot);
  if (!packageJson) return undefined;
  const entryStrings = [
    ...packageExportEntryStrings(packageJson.exports),
    ...PACKAGE_ENTRY_FIELDS.flatMap((field) => typeof packageJson[field] === "string" ? [packageJson[field]] : []),
  ];
  for (const entryString of entryStrings) {
    const publicEntry = existingPackageEntry(rootDir, packageRoot, relativeRoot, entryString, scope);
    if (publicEntry) return publicEntry;
  }
  return undefined;
}

function publicEntryForRoot(rootDir: string, relativeRoot: string, scope?: InferManifestScope): string | undefined {
  for (const basename of PUBLIC_ENTRY_BASENAMES) {
    for (const extension of SOURCE_EXTENSIONS) {
      const candidate = normalizePath(path.posix.join(relativeRoot, `${basename}${extension}`));
      if (pathExcludedByScope(scope, candidate)) continue;
      if (fs.existsSync(path.join(rootDir, candidate))) return candidate;
    }
  }
  for (const basename of PYTHON_PUBLIC_ENTRY_BASENAMES) {
    const candidate = normalizePath(path.posix.join(relativeRoot, `${basename}.py`));
    if (pathExcludedByScope(scope, candidate)) continue;
    if (fs.existsSync(path.join(rootDir, candidate))) return candidate;
  }
  return sourceFilesInRoot(rootDir, relativeRoot, scope)[0];
}

function publicEntryForCandidateRoot(rootDir: string, relativeRoot: string, packageRoot?: string, scope?: InferManifestScope, packagePolicyHints?: InferManifestPackagePolicyHints): string | undefined {
  if (packageRoot && packagePolicyHints !== "ignore") {
    const packageEntry = publicEntryFromPackageJson(rootDir, packageRoot, relativeRoot, scope);
    if (packageEntry) return packageEntry;
  }
  return publicEntryForRoot(rootDir, relativeRoot, scope);
}

function createCandidate(
  rootDir: string,
  relativeRoot: string,
  idHint: string,
  usedIds: Set<string>,
  packageName?: string,
  packageRoot?: string,
  scope?: InferManifestScope,
  packagePolicyHints?: InferManifestPackagePolicyHints,
): CellCandidate | undefined {
  const publicEntry = publicEntryForCandidateRoot(rootDir, relativeRoot, packageRoot, scope, packagePolicyHints);
  /* c8 ignore next -- addCandidate only calls this for roots where source files exist, so publicEntryForRoot returns at least the first source file. */
  if (!publicEntry) return undefined;
  return {
    id: uniqueId(sanitizeCellId(packageName || idHint), usedIds),
    root: normalizePath(relativeRoot),
    ownedPaths: [`${normalizePath(relativeRoot).replace(/\/+$/, "")}/**`],
    publicEntry,
    packageName,
    packageRoot,
  };
}

function sourceRootForWorkspace(rootDir: string, workspaceRoot: string, scope?: InferManifestScope): string | undefined {
  if (!fs.existsSync(path.join(rootDir, workspaceRoot, "package.json"))) return undefined;
  const srcRoot = normalizePath(path.posix.join(workspaceRoot, "src"));
  if (hasSourceFiles(rootDir, srcRoot, scope)) return srcRoot;
  if (sourceFilesDirectlyUnder(rootDir, workspaceRoot, scope).length > 0) return normalizePath(workspaceRoot);
  return undefined;
}

function sourceRootForPackageLikeRoot(rootDir: string, packageRoot: string, scope?: InferManifestScope): string | undefined {
  const workspaceSourceRoot = sourceRootForWorkspace(rootDir, packageRoot, scope);
  if (workspaceSourceRoot) return workspaceSourceRoot;
  if (hasSourceFiles(rootDir, packageRoot, scope)) return normalizePath(packageRoot);
  return undefined;
}

function packageLikeRootsInContainer(rootDir: string, containerRoot: string): string[] {
  const absoluteContainerRoot = path.join(rootDir, containerRoot);
  if (!fs.existsSync(absoluteContainerRoot) || !fs.statSync(absoluteContainerRoot).isDirectory()) return [];
  const packageRoots: string[] = [];
  for (const entry of fs.readdirSync(absoluteContainerRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = normalizePath(path.posix.join(containerRoot, entry.name));
    if (entry.name.startsWith("@") && !fs.existsSync(path.join(rootDir, packageRoot, "package.json"))) {
      for (const scopedEntry of fs.readdirSync(path.join(rootDir, packageRoot), { withFileTypes: true })) {
        if (scopedEntry.isDirectory()) packageRoots.push(normalizePath(path.posix.join(packageRoot, scopedEntry.name)));
      }
      continue;
    }
    packageRoots.push(packageRoot);
  }
  return packageRoots.sort((left, right) => left.localeCompare(right));
}

function pythonPackageRootForProject(rootDir: string, sourceRoot: string, projectName: string, scope?: InferManifestScope): string | undefined {
  const importName = pythonImportPackageName(projectName);
  if (importName.length === 0) return undefined;
  const candidateRoot = normalizePath(path.posix.join(sourceRoot, importName));
  if (fs.existsSync(path.join(rootDir, candidateRoot)) && hasSourceFiles(rootDir, candidateRoot, scope)) return candidateRoot;
  return undefined;
}

function pythonPackageRootsInSourceRoot(rootDir: string, sourceRoot: string, scope?: InferManifestScope): string[] {
  if (sourceRoot === "") return [];
  const absoluteSourceRoot = path.join(rootDir, sourceRoot);
  if (!fs.existsSync(absoluteSourceRoot) || !fs.statSync(absoluteSourceRoot).isDirectory()) return [];
  return fs.readdirSync(absoluteSourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => normalizePath(path.posix.join(sourceRoot, entry.name)))
    .filter((packageRoot) => fs.existsSync(path.join(rootDir, packageRoot, "__init__.py")) || sourceFilesDirectlyUnder(rootDir, packageRoot, scope).some((filePath) => path.extname(filePath) === ".py"))
    .filter((packageRoot) => hasSourceFiles(rootDir, packageRoot, scope))
    .sort((left, right) => left.localeCompare(right));
}

function discoverCandidates(rootDir: string, options: InferManifestOptions = {}): CellCandidate[] {
  const usedIds = new Set<string>();
  const candidates: CellCandidate[] = [];
  const seenRoots = new Set<string>();

  function addCandidate(relativeRoot: string, idHint: string, packageName?: string, packageRoot?: string): void {
    const normalizedRoot = normalizePath(relativeRoot).replace(/\/+$/, "");
    if (seenRoots.has(normalizedRoot)) return;
    const candidate = createCandidate(rootDir, normalizedRoot, idHint, usedIds, packageName, packageRoot, options.scope, options.packagePolicyHints);
    /* c8 ignore next -- createCandidate only returns undefined for roots without source files, which are filtered before addCandidate. */
    if (!candidate) return;
    seenRoots.add(normalizedRoot);
    candidates.push(candidate);
  }

  for (const pattern of workspacePatterns(rootDir)) {
    for (const workspaceRoot of expandWorkspacePattern(rootDir, pattern)) {
      const sourceRoot = sourceRootForWorkspace(rootDir, workspaceRoot, options.scope);
      if (sourceRoot) addCandidate(sourceRoot, path.posix.basename(workspaceRoot), packageNameFromRoot(rootDir, workspaceRoot), workspaceRoot);
    }
  }

  for (const containerRoot of SOURCE_CONTAINER_ROOTS) {
    for (const packageRoot of packageLikeRootsInContainer(rootDir, containerRoot)) {
      const sourceRoot = sourceRootForPackageLikeRoot(rootDir, packageRoot, options.scope);
      if (sourceRoot) addCandidate(sourceRoot, path.posix.basename(packageRoot), packageNameFromRoot(rootDir, packageRoot), packageRoot);
    }
  }

  const pythonName = pythonProjectName(rootDir);
  for (const sourceRoot of pythonPackagingSourceRoots(rootDir)) {
    if (pythonName) {
      const packageRoot = pythonPackageRootForProject(rootDir, sourceRoot, pythonName, options.scope);
      if (packageRoot) addCandidate(packageRoot, pythonName, pythonName, sourceRoot || ".");
    }
    for (const packageRoot of pythonPackageRootsInSourceRoot(rootDir, sourceRoot, options.scope)) {
      const packageName = pythonName && packageRoot.endsWith(`/${pythonImportPackageName(pythonName)}`) ? pythonName : undefined;
      addCandidate(packageRoot, path.posix.basename(packageRoot), packageName, sourceRoot || ".");
    }
  }

  for (const childRoot of directoryChildrenWithSources(rootDir, "src", options.scope)) {
    addCandidate(childRoot, path.posix.basename(childRoot));
  }

  for (const topLevelRoot of TOP_LEVEL_SOURCE_ROOTS) {
    if (hasSourceFiles(rootDir, topLevelRoot, options.scope)) addCandidate(topLevelRoot, topLevelRoot, undefined, ".");
  }

  const directRootSources = sourceFilesDirectlyUnder(rootDir, "src", options.scope);
  if (directRootSources.length > 0) {
    const publicEntry = directRootSources.find((relativePath) => /\/(?:public|index)\.[cm]?[jt]sx?$/.test(relativePath))
      || directRootSources[0];
    candidates.push({
      id: uniqueId("src-root", usedIds),
      root: "src",
      ownedPaths: ["src/*"],
      publicEntry,
      packageRoot: ".",
    });
  }

  return narrowAncestorCandidates(rootDir, candidates, options.scope).sort((left, right) => left.id.localeCompare(right.id));
}

function narrowAncestorCandidates(rootDir: string, candidates: readonly CellCandidate[], scope?: InferManifestScope): CellCandidate[] {
  const narrowed: CellCandidate[] = [];
  for (const candidate of candidates) {
    const childRoots = candidates
      .filter((other) => other.id !== candidate.id && pathWithinRoot(candidate.root, other.root))
      .map((other) => other.root)
      .sort((left, right) => left.localeCompare(right));
    if (childRoots.length === 0) {
      narrowed.push(candidate);
      continue;
    }

    const ownedPaths = ownedPathsOutsideChildRoots(rootDir, candidate.root, childRoots, scope);
    if (ownedPaths.length === 0) continue;
    const publicEntry = ownedPaths.some((ownedPath) => matchesPattern(candidate.publicEntry, ownedPath))
      ? candidate.publicEntry
      : firstSourceFileMatchingOwnedPaths(rootDir, ownedPaths, scope);
    if (!publicEntry) continue;
    narrowed.push({ ...candidate, ownedPaths, publicEntry });
  }
  return narrowed;
}

function ownedPathsOutsideChildRoots(rootDir: string, relativeRoot: string, childRoots: readonly string[], scope?: InferManifestScope): string[] {
  const normalizedRoot = normalizePath(relativeRoot).replace(/\/+$/, "");
  const ownedPaths = new Set<string>();
  for (const relativePath of sourceFilesInRoot(rootDir, normalizedRoot, scope)) {
    if (childRoots.some((childRoot) => pathWithinRoot(childRoot, relativePath))) continue;
    const remainder = relativePath.slice(normalizedRoot.length).replace(/^\/+/, "");
    if (remainder.length === 0) continue;
    if (!remainder.includes("/")) {
      ownedPaths.add(`${normalizedRoot}/*`);
      continue;
    }
    ownedPaths.add(`${normalizedRoot}/${remainder.split("/")[0]}/**`);
  }
  return [...ownedPaths].sort((left, right) => left.localeCompare(right));
}

function firstSourceFileMatchingOwnedPaths(rootDir: string, ownedPaths: readonly string[], scope?: InferManifestScope): string | undefined {
  return sourceFiles(rootDir)
    .map((filePath) => repoPath(rootDir, filePath))
    .filter((relativePath) => !pathExcludedByScope(scope, relativePath))
    .find((relativePath) => ownedPaths.some((ownedPath) => matchesPattern(relativePath, ownedPath)));
}

function ownerForPath(candidates: readonly CellCandidate[], relativePath: string): CellCandidate | undefined {
  return candidates.find((candidate) => candidate.ownedPaths.some((ownedPath) => matchesPattern(relativePath, ownedPath)));
}

function pathExcludedByScope(scope: InferManifestScope | undefined, relativePath: string): boolean {
  return scope === "production" && PRODUCTION_SCOPE_EXCLUDES.some((pattern) => matchesPattern(relativePath, pattern));
}

function sourceFilesOwnedByCandidate(rootDir: string, candidate: CellCandidate, scope?: InferManifestScope): string[] {
  return sourceFiles(rootDir)
    .map((filePath) => repoPath(rootDir, filePath))
    .filter((relativePath) => candidate.ownedPaths.some((ownedPath) => matchesPattern(relativePath, ownedPath)))
    .filter((relativePath) => !pathExcludedByScope(scope, relativePath))
    .sort((left, right) => left.localeCompare(right));
}

function packageDependencyNames(rootDir: string, packageRoot: string | undefined): string[] {
  if (!packageRoot) return [];
  const packageJson = packageJsonFromRoot(rootDir, packageRoot);
  if (!packageJson) return [];
  const names = new Set<string>();
  for (const field of PACKAGE_DEPENDENCY_FIELDS) {
    const dependencies = packageJson[field];
    if (!isRecord(dependencies)) continue;
    for (const dependencyName of Object.keys(dependencies)) names.add(dependencyName);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function inferredConsumes(rootDir: string, candidate: CellCandidate, candidates: readonly CellCandidate[], options: InferManifestOptions): { cell: string }[] {
  const consumedCells = new Set<string>();
  const packageCandidates = new Map<string, CellCandidate[]>();
  for (const packageCandidate of candidates) {
    if (!packageCandidate.packageName) continue;
    const existing = packageCandidates.get(packageCandidate.packageName) || [];
    existing.push(packageCandidate);
    packageCandidates.set(packageCandidate.packageName, existing);
  }
  if (options.packagePolicyHints !== "ignore") {
    for (const dependencyName of packageDependencyNames(rootDir, candidate.packageRoot)) {
      for (const dependencyCandidate of packageCandidates.get(dependencyName) || []) {
        if (dependencyCandidate.id !== candidate.id) consumedCells.add(dependencyCandidate.id);
      }
    }
  }
  const pathAliases = readPathAliases(rootDir);
  const pythonSourceRoots = [
    ...new Set([
      ...pythonPackagingSourceRoots(rootDir),
      ...candidates.map((entry) => parentPrefix(entry.root)),
    ]),
  ].sort((left, right) => left.localeCompare(right));
  const context: FileIndexContext = {
    rootDir,
    manifest: { schemaVersion: CELLFENCE_MANIFEST_SCHEMA_VERSION, cells: [] },
    sourceFilesForCellCache: new Map<string, string[]>(),
    sourceTextCache: new Map<string, string>(),
    sourceFileCache: new Map(),
  };
  for (const relativePath of sourceFilesOwnedByCandidate(rootDir, candidate, options.scope)) {
    const warnings: never[] = [];
    for (const reference of extractImports(context, path.join(rootDir, relativePath), warnings)) {
      const targetPath = path.extname(relativePath) === ".py"
        ? resolvePythonImport(rootDir, relativePath, reference.specifier, pythonSourceRoots)
        : resolveRelativeImport(rootDir, relativePath, reference.specifier)
          || resolvePathAliasTarget({ rootDir, pathAliases }, reference.specifier);
      if (!targetPath) continue;
      const targetOwner = ownerForPath(candidates, targetPath);
      if (targetOwner && targetOwner.id !== candidate.id) consumedCells.add(targetOwner.id);
    }
  }
  return [...consumedCells].sort((left, right) => left.localeCompare(right)).map((cell) => ({ cell }));
}

function manifestFromCandidatesWithOptions(rootDir: string, candidates: readonly CellCandidate[], options: InferManifestOptions): CellFenceManifest {
  const include = [...new Set(candidates.flatMap((candidate) => candidate.ownedPaths.map((ownedPath) => {
    if (ownedPath.startsWith("src/")) return "src/**";
    return ownedPath;
  })))].sort((left, right) => left.localeCompare(right));
  return {
    schemaVersion: CELLFENCE_MANIFEST_SCHEMA_VERSION,
    governance: {
      requireOwnership: true,
      include,
      exclude: options.scope === "production" ? PRODUCTION_SCOPE_EXCLUDES : [],
      requiredRules: DEFAULT_REQUIRED_RULES,
    },
    cells: candidates.map((candidate): CellManifest => ({
      id: candidate.id,
      ownedPaths: candidate.ownedPaths,
      publicEntry: candidate.publicEntry,
      publicSymbols: [...extractPublicSymbols(path.join(rootDir, candidate.publicEntry))].sort((left, right) => left.localeCompare(right)),
      ...(candidate.packageName ? { packageName: candidate.packageName } : {}),
      consumes: inferredConsumes(rootDir, candidate, candidates, options),
      producesArtifacts: [],
    })),
  };
}

export function inferManifest(options: InferManifestOptions = {}): CellFenceManifest {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const candidates = discoverCandidates(rootDir, options);
  if (candidates.length > 0) return manifestFromCandidatesWithOptions(rootDir, candidates, options);
  return {
    schemaVersion: CELLFENCE_MANIFEST_SCHEMA_VERSION,
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: options.scope === "production" ? PRODUCTION_SCOPE_EXCLUDES : [],
      requiredRules: DEFAULT_REQUIRED_RULES,
    },
    cells: [
      {
        id: "example",
        ownedPaths: ["src/example/**"],
        publicEntry: "src/example/public.ts",
        publicSymbols: ["example"],
        consumes: [],
        producesArtifacts: [],
      },
    ],
  };
}
