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
  extractImports,
  extractPublicSymbols,
  readPathAliases,
  resolvePathAliasTarget,
  resolveRelativeImport,
} from "./module-resolution.js";

type CellCandidate = {
  id: string;
  root: string;
  ownedPath: string;
  publicEntry: string;
  packageName?: string;
};

export type InferManifestOptions = {
  rootDir?: string;
};

const PUBLIC_ENTRY_BASENAMES = ["public", "index"];

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

function hasSourceFiles(rootDir: string, relativeRoot: string): boolean {
  const normalizedRoot = normalizePath(relativeRoot).replace(/\/+$/, "");
  return sourceFiles(rootDir).some((filePath) => {
    const relativePath = repoPath(rootDir, filePath);
    return relativePath === normalizedRoot || relativePath.startsWith(`${normalizedRoot}/`);
  });
}

function sourceFilesInRoot(rootDir: string, relativeRoot: string): string[] {
  const pattern = `${normalizePath(relativeRoot).replace(/\/+$/, "")}/**`;
  return sourceFiles(rootDir)
    .map((filePath) => repoPath(rootDir, filePath))
    .filter((relativePath) => matchesPattern(relativePath, pattern))
    .sort((left, right) => left.localeCompare(right));
}

function sourceFilesDirectlyUnder(rootDir: string, relativeRoot: string): string[] {
  const normalizedRoot = normalizePath(relativeRoot).replace(/\/+$/, "");
  return sourceFiles(rootDir)
    .map((filePath) => repoPath(rootDir, filePath))
    .filter((relativePath) => path.posix.dirname(relativePath) === normalizedRoot)
    .sort((left, right) => left.localeCompare(right));
}

function directoryChildrenWithSources(rootDir: string, relativeRoot: string): string[] {
  const absoluteRoot = path.join(rootDir, relativeRoot);
  if (!fs.existsSync(absoluteRoot) || !fs.statSync(absoluteRoot).isDirectory()) return [];
  return fs.readdirSync(absoluteRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => normalizePath(path.posix.join(relativeRoot, entry.name)))
    .filter((childRoot) => hasSourceFiles(rootDir, childRoot))
    .sort((left, right) => left.localeCompare(right));
}

function packageNameFromRoot(rootDir: string, relativeRoot: string): string | undefined {
  const packageJson = readJsonFile(path.join(rootDir, relativeRoot, "package.json"));
  if (!isRecord(packageJson) || typeof packageJson.name !== "string" || packageJson.name.trim().length === 0) return undefined;
  return packageJson.name;
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

function publicEntryForRoot(rootDir: string, relativeRoot: string): string | undefined {
  for (const basename of PUBLIC_ENTRY_BASENAMES) {
    for (const extension of SOURCE_EXTENSIONS) {
      const candidate = normalizePath(path.posix.join(relativeRoot, `${basename}${extension}`));
      if (fs.existsSync(path.join(rootDir, candidate))) return candidate;
    }
  }
  return sourceFilesInRoot(rootDir, relativeRoot)[0];
}

function createCandidate(rootDir: string, relativeRoot: string, idHint: string, usedIds: Set<string>, packageName?: string): CellCandidate | undefined {
  const publicEntry = publicEntryForRoot(rootDir, relativeRoot);
  /* c8 ignore next -- addCandidate only calls this for roots where source files exist, so publicEntryForRoot returns at least the first source file. */
  if (!publicEntry) return undefined;
  return {
    id: uniqueId(sanitizeCellId(packageName || idHint), usedIds),
    root: normalizePath(relativeRoot),
    ownedPath: `${normalizePath(relativeRoot).replace(/\/+$/, "")}/**`,
    publicEntry,
    packageName,
  };
}

function discoverCandidates(rootDir: string): CellCandidate[] {
  const usedIds = new Set<string>();
  const candidates: CellCandidate[] = [];
  const seenRoots = new Set<string>();

  function addCandidate(relativeRoot: string, idHint: string, packageName?: string): void {
    const normalizedRoot = normalizePath(relativeRoot).replace(/\/+$/, "");
    if (seenRoots.has(normalizedRoot)) return;
    const candidate = createCandidate(rootDir, normalizedRoot, idHint, usedIds, packageName);
    /* c8 ignore next -- createCandidate only returns undefined for roots without source files, which are filtered before addCandidate. */
    if (!candidate) return;
    seenRoots.add(normalizedRoot);
    candidates.push(candidate);
  }

  for (const pattern of workspacePatterns(rootDir)) {
    for (const workspaceRoot of expandWorkspacePattern(rootDir, pattern)) {
      const srcRoot = normalizePath(path.posix.join(workspaceRoot, "src"));
      if (hasSourceFiles(rootDir, srcRoot)) addCandidate(srcRoot, path.posix.basename(workspaceRoot), packageNameFromRoot(rootDir, workspaceRoot));
    }
  }

  for (const childRoot of directoryChildrenWithSources(rootDir, "src")) {
    addCandidate(childRoot, path.posix.basename(childRoot));
  }

  const directRootSources = sourceFilesDirectlyUnder(rootDir, "src");
  if (directRootSources.length > 0) {
    const publicEntry = directRootSources.find((relativePath) => /\/(?:public|index)\.[cm]?[jt]sx?$/.test(relativePath)) || directRootSources[0];
    candidates.push({
      id: uniqueId("src-root", usedIds),
      root: "src",
      ownedPath: "src/*",
      publicEntry,
    });
  }

  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

function ownerForPath(candidates: readonly CellCandidate[], relativePath: string): CellCandidate | undefined {
  return candidates.find((candidate) => matchesPattern(relativePath, candidate.ownedPath));
}

function inferredConsumes(rootDir: string, candidate: CellCandidate, candidates: readonly CellCandidate[]): { cell: string }[] {
  const consumedCells = new Set<string>();
  const pathAliases = readPathAliases(rootDir);
  const context: FileIndexContext = {
    rootDir,
    manifest: { schemaVersion: CELLFENCE_MANIFEST_SCHEMA_VERSION, cells: [] },
    sourceFilesForCellCache: new Map<string, string[]>(),
    sourceTextCache: new Map<string, string>(),
    sourceFileCache: new Map(),
  };
  for (const relativePath of sourceFilesInRoot(rootDir, candidate.root)) {
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

function manifestFromCandidates(rootDir: string, candidates: readonly CellCandidate[]): CellFenceManifest {
  const include = [...new Set(candidates.map((candidate) => {
    if (candidate.ownedPath.startsWith("src/")) return "src/**";
    return candidate.ownedPath;
  }))].sort((left, right) => left.localeCompare(right));
  return {
    schemaVersion: CELLFENCE_MANIFEST_SCHEMA_VERSION,
    governance: {
      requireOwnership: true,
      include,
      exclude: [],
    },
    cells: candidates.map((candidate): CellManifest => ({
      id: candidate.id,
      ownedPaths: [candidate.ownedPath],
      publicEntry: candidate.publicEntry,
      publicSymbols: [...extractPublicSymbols(path.join(rootDir, candidate.publicEntry))].sort((left, right) => left.localeCompare(right)),
      ...(candidate.packageName ? { packageName: candidate.packageName } : {}),
      consumes: inferredConsumes(rootDir, candidate, candidates),
      producesArtifacts: [],
    })),
  };
}

export function inferManifest(options: InferManifestOptions = {}): CellFenceManifest {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const candidates = discoverCandidates(rootDir);
  if (candidates.length > 0) return manifestFromCandidates(rootDir, candidates);
  return {
    schemaVersion: CELLFENCE_MANIFEST_SCHEMA_VERSION,
    governance: {
      requireOwnership: true,
      include: ["src/**"],
      exclude: [],
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
