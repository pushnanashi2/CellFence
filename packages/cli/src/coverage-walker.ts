// Coverage walker — fills out the 0.4.0 coverage command. The
// prototype in 0.3.0 just rolled an empty list into a report; the
// real implementation walks the repository through the same engine
// pipeline `cellfence check` uses, then buckets every finding that
// the existing rules already raised as either "import unresolved",
// "resource unresolved", or "public-surface unresolved" so a user
// can see the shape of the blind spots without re-running a second
// analysis pass.

import path from "node:path";

import {
  checkRepository,
  loadManifestFromFile,
  repoPath,
  sourceFilesForCell,
  sourceFilesUnderGovernance,
  type CheckOptions,
  type CheckResult,
} from "@cellfence/engine";

import {
  recordUnresolved,
  type CoverageKind,
  type CoverageUnresolved,
} from "@cellfence/engine";

const IMPORT_UNRESOLVED_RULES = new Set([
  "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
  "CELLFENCE_UNSUPPORTED_TYPESCRIPT_SYNTAX",
  "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX",
  "CELLFENCE_UNRESOLVED_IMPORT",
  "CELLFENCE_UNRESOLVED_REQUIRE",
]);

const RESOURCE_UNRESOLVED_RULES = new Set([
  "CELLFENCE_UNRESOLVED_RESOURCE_ACCESS",
  "CELLFENCE_RESOURCE_EVIDENCE_INVALID",
  "CELLFENCE_RESOURCE_EVIDENCE_TRANSCRIPT_INACTIVE",
  "CELLFENCE_RESOURCE_EVIDENCE_TRANSCRIPT_INCOMPLETE",
]);

const PUBLIC_SURFACE_UNRESOLVED_RULES = new Set([
  "CELLFENCE_PUBLIC_ENTRY_MISSING",
]);

function bucketForRule(ruleId: string): CoverageKind | undefined {
  if (IMPORT_UNRESOLVED_RULES.has(ruleId)) return "import";
  if (RESOURCE_UNRESOLVED_RULES.has(ruleId)) return "resource";
  if (PUBLIC_SURFACE_UNRESOLVED_RULES.has(ruleId)) return "public-surface";
  return undefined;
}

function shapeForRule(ruleId: string, message: string): string {
  // Try to surface the most useful token from the message so the
  // report reads like a useful diagnostic rather than a flat list
  // of rule ids.
  const match = message.match(/`([^`]+)`/);
  if (match) return match[1];
  return ruleId;
}

export type WalkOptions = CheckOptions & {
  rootDir: string;
};

export type WalkResult = {
  unresolved: CoverageUnresolved[];
  /** Files the walker successfully walked (any cellfence check). */
  analyzedFiles: string[];
  /** Total files the walker tried to analyse, if available. */
  totalFiles: number;
  /** Raw check result, in case the caller wants to surface it. */
  check: CheckResult;
};

export function walkCoverage(options: WalkOptions): WalkResult {
  const check = checkRepository(options);
  const unresolved: CoverageUnresolved[] = [];
  for (const finding of [...check.findings, ...check.warnings]) {
    const kind = bucketForRule(finding.ruleId);
    if (!kind) continue;
    recordUnresolved(unresolved, {
      kind,
      cellId: undefined,
      filePath: finding.filePath ? path.resolve(options.rootDir, finding.filePath) : options.rootDir,
      line: undefined,
      shape: shapeForRule(finding.ruleId, finding.message),
      reason: finding.message,
      suggestion: undefined,
    });
  }
  const manifestPath = path.resolve(options.rootDir, options.manifestPath || "cellfence.manifest.json");
  const sourceInventory = new Set<string>();
  try {
    const manifest = loadManifestFromFile(manifestPath);
    for (const cell of manifest.cells) {
      for (const filePath of sourceFilesForCell(options.rootDir, cell)) {
        sourceInventory.add(repoPath(options.rootDir, filePath));
      }
    }
    for (const filePath of sourceFilesUnderGovernance(options.rootDir, manifest)) {
      sourceInventory.add(repoPath(options.rootDir, filePath));
    }
  } catch {
    // The check result already carries the configuration error. Keep coverage
    // computation side-effect-free and let the caller surface the original
    // finding instead of masking it with an inventory failure.
  }
  const unresolvedFiles = new Set(unresolved.map((entry) => repoPath(options.rootDir, entry.filePath)));
  const externalUnresolvedCount = unresolved
    .map((entry) => repoPath(options.rootDir, entry.filePath))
    .filter((filePath) => !sourceInventory.has(filePath)).length;
  const analyzedFiles = [...sourceInventory]
    .filter((filePath) => !unresolvedFiles.has(filePath))
    .sort((left, right) => left.localeCompare(right));
  return {
    unresolved,
    analyzedFiles,
    totalFiles: sourceInventory.size + externalUnresolvedCount,
    check,
  };
}
