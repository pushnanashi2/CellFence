import { builtinModules } from "node:module";
import path from "node:path";

import type { CellFenceBaseline, CellManifest } from "@cellfence/schema";

import { addFinding, codeResolution, manifestResolution } from "./findings.js";
import type { AnalysisContext, Finding, ResolvedImport } from "./types.js";
import type { ImportReference } from "./module-resolution.js";

type ExternalDependencyId = string;

const NODE_BUILTINS = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((specifier) => specifier.replace(/^node:/, "")),
]);

const PYTHON_STDLIB_ROOTS = new Set([
  "__future__",
  "abc",
  "argparse",
  "asyncio",
  "base64",
  "bisect",
  "bz2",
  "calendar",
  "collections",
  "concurrent",
  "copy",
  "contextlib",
  "csv",
  "dataclasses",
  "datetime",
  "decimal",
  "email",
  "enum",
  "fnmatch",
  "functools",
  "glob",
  "gzip",
  "hashlib",
  "heapq",
  "http",
  "importlib",
  "inspect",
  "io",
  "itertools",
  "json",
  "logging",
  "math",
  "multiprocessing",
  "os",
  "pathlib",
  "pickle",
  "platform",
  "queue",
  "random",
  "re",
  "shutil",
  "signal",
  "sqlite3",
  "statistics",
  "socket",
  "ssl",
  "string",
  "subprocess",
  "sys",
  "tempfile",
  "threading",
  "time",
  "traceback",
  "typing",
  "unittest",
  "urllib",
  "uuid",
  "xml",
  "zipfile",
]);

export type ExternalDependencyObservation = {
  cellId: string;
  dependencyId: ExternalDependencyId;
  filePath: string;
  line: number;
  specifier: string;
  kind: ImportReference["kind"];
  typeOnly: boolean;
};

export type ExternalDependencyPolicyInput = {
  context: AnalysisContext;
  baseline?: CellFenceBaseline;
  observations: readonly ExternalDependencyObservation[];
};

export function npmPackageRoot(specifier: string): string | undefined {
  const withoutNodePrefix = specifier.replace(/^node:/, "");
  if (withoutNodePrefix.startsWith("@")) {
    const [scope, name] = withoutNodePrefix.split("/");
    if (!scope || !name) return undefined;
    return `${scope}/${name}`;
  }
  const [name] = withoutNodePrefix.split("/");
  return name || undefined;
}

export function isNodeBuiltinSpecifier(specifier: string): boolean {
  const withoutNodePrefix = specifier.replace(/^node:/, "");
  return NODE_BUILTINS.has(specifier) || NODE_BUILTINS.has(withoutNodePrefix) || NODE_BUILTINS.has(`node:${withoutNodePrefix}`);
}

function pythonImportRoot(specifier: string): string | undefined {
  if (specifier.startsWith(".")) return undefined;
  const [root] = specifier.split(".");
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(root || "") ? root : undefined;
}

export function isPythonStdlibSpecifier(specifier: string): boolean {
  const root = pythonImportRoot(specifier);
  return Boolean(root && PYTHON_STDLIB_ROOTS.has(root));
}

function npmDependencyId(specifier: string): ExternalDependencyId | undefined {
  if (isNodeBuiltinSpecifier(specifier)) return undefined;
  const packageRoot = npmPackageRoot(specifier);
  if (!packageRoot) return undefined;
  if (packageRoot.startsWith("@")) {
    return /^@[a-z0-9._~-]+\/[a-z0-9._~-]+$/.test(packageRoot) ? `npm:${packageRoot}` : undefined;
  }
  return /^[a-z0-9._~-]+$/.test(packageRoot) ? `npm:${packageRoot}` : undefined;
}

function pythonDependencyId(specifier: string): ExternalDependencyId | undefined {
  if (isPythonStdlibSpecifier(specifier)) return undefined;
  const root = pythonImportRoot(specifier);
  return root ? `python-import:${root}` : undefined;
}

export function externalDependencyIdForImport(
  reference: ImportReference,
  resolvedImport: ResolvedImport,
): ExternalDependencyId | undefined {
  if (!resolvedImport.isExternal) return undefined;
  if (path.extname(reference.importerPath) === ".py") return pythonDependencyId(reference.specifier);
  return npmDependencyId(reference.specifier);
}

export function externalDependencySetForCell(observations: readonly ExternalDependencyObservation[] | undefined): ExternalDependencyId[] {
  return [...new Set((observations || []).map((observation) => observation.dependencyId))]
    .sort((left, right) => left.localeCompare(right));
}

function claimersByDependency(cells: readonly CellManifest[]): Map<ExternalDependencyId, Set<string>> {
  const claimers = new Map<ExternalDependencyId, Set<string>>();
  for (const cell of cells) {
    for (const dependencyId of cell.externalDependencies?.claim || []) {
      const set = claimers.get(dependencyId) || new Set<string>();
      set.add(cell.id);
      claimers.set(dependencyId, set);
    }
  }
  return claimers;
}

function cellDeclaresDependency(cell: CellManifest, dependencyId: ExternalDependencyId): boolean {
  return Boolean(
    cell.externalDependencies?.claim?.includes(dependencyId)
    || cell.externalDependencies?.allow?.includes(dependencyId),
  );
}

function baselineHasDependency(baseline: CellFenceBaseline | undefined, cellId: string, dependencyId: ExternalDependencyId): boolean {
  const baselineRecord = baseline?.cells[cellId];
  if (!baselineRecord) return false;
  if (baselineRecord.externalDependencySet === undefined) return true;
  return baselineRecord.externalDependencySet.includes(dependencyId);
}

function addExternalDependencyFinding(
  findings: Finding[],
  observation: ExternalDependencyObservation,
  ruleId:
    | "CELLFENCE_EXTERNAL_DEPENDENCY_CLAIM_VIOLATION"
    | "CELLFENCE_RATCHET_EXTERNAL_DEPENDENCY_ADDED"
    | "CELLFENCE_LOCKED_EXTERNAL_DEPENDENCY_EXPANSION",
  message: string,
  locked: boolean,
): void {
  addFinding(findings, {
    ruleId,
    severity: "error",
    cellId: observation.cellId,
    filePath: observation.filePath,
    message,
    details: {
      dependencyId: observation.dependencyId,
      specifier: observation.specifier,
      line: observation.line,
      kind: observation.kind,
      typeOnly: observation.typeOnly,
    },
    suggestedResolutions: [
      codeResolution("Remove the external dependency use or route it through the owning cell", {
        dependencyId: observation.dependencyId,
        specifier: observation.specifier,
      }),
      manifestResolution("Declare an external dependency policy entry for this cell", locked, {
        cell: observation.cellId,
        externalDependencies: {
          [ruleId === "CELLFENCE_EXTERNAL_DEPENDENCY_CLAIM_VIOLATION" ? "claim" : "allow"]: [
            observation.dependencyId,
          ],
        },
      }),
    ],
  });
}

export function validateExternalDependencyPolicy(
  input: ExternalDependencyPolicyInput,
  findings: Finding[],
): Map<string, ExternalDependencyObservation[]> {
  const observationsByCell = new Map<string, ExternalDependencyObservation[]>();
  const claimers = claimersByDependency(input.context.manifest.cells);
  for (const observation of input.observations) {
    const cell = input.context.cellsById.get(observation.cellId);
    if (!cell) continue;
    const existing = observationsByCell.get(observation.cellId) || [];
    existing.push(observation);
    observationsByCell.set(observation.cellId, existing);

    const dependencyClaimers = claimers.get(observation.dependencyId);
    if (dependencyClaimers && !dependencyClaimers.has(observation.cellId)) {
      addExternalDependencyFinding(
        findings,
        observation,
        "CELLFENCE_EXTERNAL_DEPENDENCY_CLAIM_VIOLATION",
        `${observation.cellId} uses ${observation.dependencyId}, which is claimed by ${[...dependencyClaimers].sort().join(", ")}`,
        Boolean(cell.locked),
      );
      continue;
    }

    if (baselineHasDependency(input.baseline, observation.cellId, observation.dependencyId)) continue;

    if (cell.locked && input.baseline) {
      addExternalDependencyFinding(
        findings,
        observation,
        "CELLFENCE_LOCKED_EXTERNAL_DEPENDENCY_EXPANSION",
        `${observation.cellId} is locked and added external dependency ${observation.dependencyId}`,
        true,
      );
      continue;
    }

    if (cellDeclaresDependency(cell, observation.dependencyId)) continue;

    if (input.baseline) {
      addExternalDependencyFinding(
        findings,
        observation,
        "CELLFENCE_RATCHET_EXTERNAL_DEPENDENCY_ADDED",
        `${observation.cellId} added external dependency ${observation.dependencyId} outside the accepted baseline`,
        Boolean(cell.locked),
      );
    }
  }
  return observationsByCell;
}
