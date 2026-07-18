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

export type InferManifestOptions = {
  rootDir?: string;
  scope?: InferManifestScope;
};

const PUBLIC_ENTRY_BASENAMES = ["public", "index"];
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
  return sourceFilesInRoot(rootDir, relativeRoot, scope)[0];
}

function publicEntryForCandidateRoot(rootDir: string, relativeRoot: string, packageRoot?: string, scope?: InferManifestScope): string | undefined {
  if (packageRoot) {
    const packageEntry = publicEntryFromPackageJson(rootDir, packageRoot, relativeRoot, scope);
    if (packageEntry) return packageEntry;
  }
  return publicEntryForRoot(rootDir, relativeRoot, scope);
}

function createCandidate(rootDir: string, relativeRoot: string, idHint: string, usedIds: Set<string>, packageName?: string, packageRoot?: string, scope?: InferManifestScope): CellCandidate | undefined {
  const publicEntry = publicEntryForCandidateRoot(rootDir, relativeRoot, packageRoot, scope);
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

function discoverCandidates(rootDir: string, options: InferManifestOptions = {}): CellCandidate[] {
  const usedIds = new Set<string>();
  const candidates: CellCandidate[] = [];
  const seenRoots = new Set<string>();

  function addCandidate(relativeRoot: string, idHint: string, packageName?: string, packageRoot?: string): void {
    const normalizedRoot = normalizePath(relativeRoot).replace(/\/+$/, "");
    if (seenRoots.has(normalizedRoot)) return;
    const candidate = createCandidate(rootDir, normalizedRoot, idHint, usedIds, packageName, packageRoot, options.scope);
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
  for (const dependencyName of packageDependencyNames(rootDir, candidate.packageRoot)) {
    for (const dependencyCandidate of packageCandidates.get(dependencyName) || []) {
      if (dependencyCandidate.id !== candidate.id) consumedCells.add(dependencyCandidate.id);
    }
  }
  const pathAliases = readPathAliases(rootDir);
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
      const targetPath = resolveRelativeImport(rootDir, relativePath, reference.specifier)
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
