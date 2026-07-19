import fs from "node:fs";
import path from "node:path";

import {
  CELLFENCE_BASELINE_SCHEMA_VERSION,
  validateBaseline,
  type CellFenceBaseline,
  type CellFenceManifest,
} from "@cellfence/schema";

import { DEFAULT_BASELINE_PATH, DEFAULT_MANIFEST_PATH } from "./constants.js";
import { addFinding, codeResolution, humanResolution } from "./findings.js";
import { patternCoveredByOwnedPaths } from "./file-index.js";
import { readJsonFile } from "./json-file.js";
import {
  BASELINE_ED25519_PRIVATE_KEY_ENV,
  BASELINE_HMAC_KEY_ENV,
  sealBaselineIfConfigured,
  validateBaselineSealFindings,
} from "./baseline-seal.js";
import { resourceBaselineKey } from "./baseline-ratchet.js";
import type {
  BaselineUpdateGuardOptions,
  BaselineUpdateGuardResult,
  CheckOptions,
  CheckResult,
  Finding,
} from "./types.js";

type BaselineOperationDependencies = {
  checkRepository(options?: CheckOptions): CheckResult;
  loadManifestFromFile(manifestPath: string): CellFenceManifest;
};

export function defaultBaselinePath(rootDir = process.cwd()): string {
  return path.resolve(rootDir, DEFAULT_BASELINE_PATH);
}

export function loadBaselineFromFile(baselinePath: string): CellFenceBaseline {
  const baselineValidation = validateBaseline(readJsonFile(baselinePath));
  if (!baselineValidation.ok || !baselineValidation.value) {
    throw new Error(`baseline is invalid: ${baselineValidation.errors.join("; ")}`);
  }
  return baselineValidation.value;
}

export function sealBaselineWithConfiguredKey(baseline: CellFenceBaseline): CellFenceBaseline {
  const sealedBaseline = sealBaselineIfConfigured(baseline);
  if (!sealedBaseline.seal) {
    throw new Error(`baseline signing requires ${BASELINE_ED25519_PRIVATE_KEY_ENV} or ${BASELINE_HMAC_KEY_ENV}`);
  }
  return sealedBaseline;
}

export function writeBaselineFile(filePath: string, baseline: CellFenceBaseline): void {
  fs.writeFileSync(filePath, `${JSON.stringify(sealBaselineIfConfigured(baseline), null, 2)}\n`);
}

export function createBaseline(
  options: CheckOptions = {},
  dependencies: BaselineOperationDependencies,
): CellFenceBaseline {
  const result = dependencies.checkRepository({ ...options, baselinePath: undefined });
  if (result.exitCode === 2 || result.exitCode === 3) {
    throw new Error(result.findings.map((finding) => finding.message).join("; "));
  }
  return {
    schemaVersion: CELLFENCE_BASELINE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    cellIds: Object.keys(result.metrics).sort((left, right) => left.localeCompare(right)),
    cells: result.metrics,
  };
}

export function verifyBaselineSeal(
  options: CheckOptions = {},
  dependencies: BaselineOperationDependencies,
): CheckResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  const baselinePath = path.resolve(rootDir, options.baselinePath || defaultBaselinePath(rootDir));
  const manifest = dependencies.loadManifestFromFile(manifestPath);
  const baseline = loadBaselineFromFile(baselinePath);
  const findings: Finding[] = [];
  for (const finding of validateBaselineSealFindings(manifest, baseline, baselinePath, true)) {
    addFinding(findings, finding);
  }
  return {
    ok: findings.length === 0,
    exitCode: findings.length === 0 ? 0 : 1,
    findings,
    warnings: [],
    metrics: baseline.cells,
  };
}

function addLockedBaselineFinding(
  findings: Finding[],
  cellId: string,
  message: string,
  details: Record<string, unknown>,
): void {
  addFinding(findings, {
    ruleId: "CELLFENCE_LOCKED_BASELINE_EXPANSION",
    severity: "error",
    cellId,
    message,
    details,
    suggestedResolutions: [
      codeResolution("Reduce the change so the locked cell stays within the accepted baseline", details),
      humanResolution("Ask a human owner to review and unlock or manually accept this architectural expansion", details),
    ],
  });
}

export function guardBaselineUpdate(
  options: BaselineUpdateGuardOptions,
  dependencies: BaselineOperationDependencies,
): BaselineUpdateGuardResult {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const manifestPath = path.resolve(rootDir, options.manifestPath || DEFAULT_MANIFEST_PATH);
  const baselinePath = path.resolve(rootDir, options.baselinePath || defaultBaselinePath(rootDir));
  if (!fs.existsSync(baselinePath)) return { ok: true, findings: [] };

  const manifest = dependencies.loadManifestFromFile(manifestPath);
  const existingBaselineValidation = validateBaseline(readJsonFile(baselinePath));
  if (!existingBaselineValidation.ok || !existingBaselineValidation.value) {
    throw new Error(`baseline is invalid: ${existingBaselineValidation.errors.join("; ")}`);
  }

  const findings: Finding[] = [];
  const existingBaseline = existingBaselineValidation.value;
  for (const cell of manifest.cells) {
    if (!cell.locked) continue;
    const current = options.nextBaseline.cells[cell.id];
    const previous = existingBaseline.cells[cell.id];
    if (!previous) {
      if (current) {
        addLockedBaselineFinding(
          findings,
          cell.id,
          `${cell.id} is locked and is absent from the existing baseline`,
          { cell: cell.id, metric: "cellIds", previous: null, current: true },
        );
      }
      continue;
    }
    if (!current) continue;

    for (const metric of ["ownedPathPatterns", "publicSymbols", "publicSurfaceLines", "crossCellDependencies"] as const) {
      if (current[metric] > previous[metric]) {
        addLockedBaselineFinding(
          findings,
          cell.id,
          `${cell.id} is locked and ${metric} would grow from ${previous[metric]} to ${current[metric]}`,
          { cell: cell.id, metric, previous: previous[metric], current: current[metric] },
        );
      }
    }

    const scopeExpansion = current.ownedPathSet && previous.ownedPathSet
      ? current.ownedPathSet.filter((currentPattern) => !patternCoveredByOwnedPaths(currentPattern, previous.ownedPathSet as string[]))
      : [];
    if (scopeExpansion.length > 0) {
      addLockedBaselineFinding(
        findings,
        cell.id,
        `${cell.id} is locked and ownership scope would expand or shift: ${scopeExpansion.join(", ")}`,
        { cell: cell.id, metric: "ownedPathSet", previous: previous.ownedPathSet, current: current.ownedPathSet, scopeExpansion },
      );
    }

    if (current.publicEntryPath && previous.publicEntryPath && current.publicEntryPath !== previous.publicEntryPath) {
      addLockedBaselineFinding(
        findings,
        cell.id,
        `${cell.id} is locked and public entry would change from ${previous.publicEntryPath} to ${current.publicEntryPath}`,
        { cell: cell.id, metric: "publicEntryPath", previous: previous.publicEntryPath, current: current.publicEntryPath },
      );
    }

    const addedPublicSymbols = current.publicSymbolSet && previous.publicSymbolSet
      ? current.publicSymbolSet.filter((symbol) => !(previous.publicSymbolSet as string[]).includes(symbol))
      : [];
    if (addedPublicSymbols.length > 0) {
      addLockedBaselineFinding(
        findings,
        cell.id,
        `${cell.id} is locked and public symbols would be added: ${addedPublicSymbols.join(", ")}`,
        { cell: cell.id, metric: "publicSymbolSet", addedPublicSymbols },
      );
    }

    const addedDependencyEdges = current.dependencyEdges && previous.dependencyEdges
      ? current.dependencyEdges.filter((edge) => !(previous.dependencyEdges as string[]).includes(edge))
      : [];
    if (addedDependencyEdges.length > 0) {
      addLockedBaselineFinding(
        findings,
        cell.id,
        `${cell.id} is locked and dependency edges would be added: ${addedDependencyEdges.join(", ")}`,
        { cell: cell.id, metric: "dependencyEdges", addedDependencyEdges },
      );
    }

    const addedArtifacts = current.artifactContracts && previous.artifactContracts
      ? current.artifactContracts.filter((artifact) => !(previous.artifactContracts as string[]).includes(artifact))
      : [];
    if (addedArtifacts.length > 0) {
      addLockedBaselineFinding(
        findings,
        cell.id,
        `${cell.id} is locked and artifact contracts would be added: ${addedArtifacts.join(", ")}`,
        { cell: cell.id, metric: "artifactContracts", addedArtifacts },
      );
    }

    if (current.publicSurfaceHash && previous.publicSurfaceHash && current.publicSurfaceHash !== previous.publicSurfaceHash) {
      addLockedBaselineFinding(
        findings,
        cell.id,
        `${cell.id} is locked and public surface signature hash would change`,
        { cell: cell.id, metric: "publicSurfaceHash", previous: previous.publicSurfaceHash, current: current.publicSurfaceHash },
      );
    }

    const previousResourceKeys = new Set((previous.resourceAccesses || []).map(resourceBaselineKey));
    for (const resourceAccess of current.resourceAccesses || []) {
      const resourceKey = resourceBaselineKey(resourceAccess);
      if (previousResourceKeys.has(resourceKey)) continue;
      addLockedBaselineFinding(
        findings,
        cell.id,
        `${cell.id} is locked and baseline update would grandfather ${resourceAccess.kind} ${resourceAccess.access} ${resourceAccess.selector}`,
        { cell: cell.id, resourceAccess },
      );
    }
  }

  return { ok: findings.length === 0, findings };
}
