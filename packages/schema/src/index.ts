export const CELLFENCE_MANIFEST_SCHEMA_VERSION = "cellfence.manifest.v1";
export const CELLFENCE_BASELINE_SCHEMA_VERSION = "cellfence.baseline.v1";
export const CELLFENCE_RESOURCE_EVIDENCE_SCHEMA_VERSION = "cellfence.resource-evidence.v1";

export type EnforcementStatus = "enforced" | "partially_enforced" | "documented" | "planned";

export type ArtifactLaneManifest = {
  id: string;
  paths: string[];
  description?: string;
};

export type ResourceContractKind = "file" | "database" | "queue" | "http";

export type ResourceAccessMode = "read" | "write" | "publish" | "subscribe" | "call" | "serve";
export type ResourceAccessConfidence = "high" | "medium" | "low" | "runtime";

export type ResourceContractManifest = {
  id: string;
  kind: ResourceContractKind;
  access: ResourceAccessMode[];
  selectors: string[];
  description?: string;
};

export type ResourceBaselineEntry = {
  kind: ResourceContractKind;
  access: ResourceAccessMode;
  selector: string;
  detectedBy?: string;
  confidence?: ResourceAccessConfidence;
};

export type ResourceEvidenceAccess = ResourceBaselineEntry & {
  cellId?: string;
  observedAt?: string;
};

export type CellFenceResourceEvidence = {
  schemaVersion: typeof CELLFENCE_RESOURCE_EVIDENCE_SCHEMA_VERSION;
  commitSha?: string;
  generatedAt?: string;
  cellId?: string;
  accesses: ResourceEvidenceAccess[];
};

export type CellConsumerManifest = {
  cell: string;
  artifactLanes?: string[];
};

export type ArchitecturalBudgets = {
  ownedPathPatterns?: number;
  publicSymbols?: number;
  publicSurfaceLines?: number;
  crossCellDependencies?: number;
};

export type CellManifest = {
  id: string;
  ownedPaths: string[];
  publicEntry: string;
  publicSymbols: string[];
  packageName?: string;
  consumes?: CellConsumerManifest[];
  producesArtifacts?: ArtifactLaneManifest[];
  resourceContracts?: ResourceContractManifest[];
  budgets?: ArchitecturalBudgets;
};

export type CellFenceManifest = {
  schemaVersion: typeof CELLFENCE_MANIFEST_SCHEMA_VERSION;
  cells: CellManifest[];
};

export type CellBaselineRecord = {
  ownedPathPatterns: number;
  publicSymbols: number;
  publicSurfaceLines: number;
  crossCellDependencies: number;
  resourceAccesses?: ResourceBaselineEntry[];
};

export type CellFenceBaseline = {
  schemaVersion: typeof CELLFENCE_BASELINE_SCHEMA_VERSION;
  generatedAt: string;
  cells: Record<string, CellBaselineRecord>;
};

export type ValidationResult<T> = {
  ok: boolean;
  value?: T;
  errors: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function validateConsumer(value: unknown, location: string, errors: string[]): value is CellConsumerManifest {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  if (typeof value.cell !== "string" || value.cell.trim().length === 0) {
    errors.push(`${location}.cell must be a non-empty string`);
  }
  if (value.artifactLanes !== undefined && !isStringArray(value.artifactLanes)) {
    errors.push(`${location}.artifactLanes must be an array of non-empty strings`);
  }
  return errors.length === 0 || typeof value.cell === "string";
}

function validateArtifactLane(value: unknown, location: string, errors: string[]): value is ArtifactLaneManifest {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    errors.push(`${location}.id must be a non-empty string`);
  }
  if (!isStringArray(value.paths)) {
    errors.push(`${location}.paths must be an array of non-empty strings`);
  }
  if (!optionalString(value.description)) {
    errors.push(`${location}.description must be a string when present`);
  }
  return errors.length === 0 || typeof value.id === "string";
}

function validateResourceContract(value: unknown, location: string, errors: string[]): value is ResourceContractManifest {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    errors.push(`${location}.id must be a non-empty string`);
  }
  if (!["file", "database", "queue", "http"].includes(String(value.kind))) {
    errors.push(`${location}.kind must be file|database|queue|http`);
  }
  if (!isStringArray(value.access) || !value.access.every((entry) => ["read", "write", "publish", "subscribe", "call", "serve"].includes(entry))) {
    errors.push(`${location}.access must contain read|write|publish|subscribe|call|serve`);
  }
  if (!isStringArray(value.selectors)) {
    errors.push(`${location}.selectors must be an array of non-empty strings`);
  }
  if (!optionalString(value.description)) {
    errors.push(`${location}.description must be a string when present`);
  }
  return errors.length === 0 || typeof value.id === "string";
}

function validateResourceBaselineEntry(value: unknown, location: string, errors: string[]): value is ResourceBaselineEntry {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  if (!["file", "database", "queue", "http"].includes(String(value.kind))) {
    errors.push(`${location}.kind must be file|database|queue|http`);
  }
  if (!["read", "write", "publish", "subscribe", "call", "serve"].includes(String(value.access))) {
    errors.push(`${location}.access must be read|write|publish|subscribe|call|serve`);
  }
  if (typeof value.selector !== "string" || value.selector.trim().length === 0) {
    errors.push(`${location}.selector must be a non-empty string`);
  }
  if (!optionalString(value.detectedBy)) {
    errors.push(`${location}.detectedBy must be a string when present`);
  }
  if (value.confidence !== undefined && !["high", "medium", "low", "runtime"].includes(String(value.confidence))) {
    errors.push(`${location}.confidence must be high|medium|low|runtime when present`);
  }
  return true;
}

function validateResourceEvidenceAccess(value: unknown, location: string, errors: string[]): value is ResourceEvidenceAccess {
  validateResourceBaselineEntry(value, location, errors);
  if (!isRecord(value)) return false;
  if (!optionalString(value.cellId)) {
    errors.push(`${location}.cellId must be a string when present`);
  }
  if (!optionalString(value.observedAt)) {
    errors.push(`${location}.observedAt must be a string when present`);
  }
  return true;
}

function validateBudgets(value: unknown, location: string, errors: string[]): value is ArchitecturalBudgets {
  if (value === undefined) return true;
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  for (const key of ["ownedPathPatterns", "publicSymbols", "publicSurfaceLines", "crossCellDependencies"]) {
    const numericValue = value[key];
    if (numericValue !== undefined && (!Number.isInteger(numericValue) || Number(numericValue) < 0)) {
      errors.push(`${location}.${key} must be a non-negative integer`);
    }
  }
  return true;
}

function validateCell(value: unknown, location: string, errors: string[]): value is CellManifest {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    errors.push(`${location}.id must be a non-empty string`);
  }
  if (!isStringArray(value.ownedPaths)) {
    errors.push(`${location}.ownedPaths must be an array of non-empty strings`);
  }
  if (typeof value.publicEntry !== "string" || value.publicEntry.trim().length === 0) {
    errors.push(`${location}.publicEntry must be a non-empty string`);
  }
  if (!isStringArray(value.publicSymbols)) {
    errors.push(`${location}.publicSymbols must be an array of non-empty strings`);
  }
  if (!optionalString(value.packageName)) {
    errors.push(`${location}.packageName must be a string when present`);
  }
  if (value.consumes !== undefined) {
    if (!Array.isArray(value.consumes)) {
      errors.push(`${location}.consumes must be an array when present`);
    } else {
      value.consumes.forEach((consumer, consumerIndex) => {
        validateConsumer(consumer, `${location}.consumes[${consumerIndex}]`, errors);
      });
    }
  }
  if (value.producesArtifacts !== undefined) {
    if (!Array.isArray(value.producesArtifacts)) {
      errors.push(`${location}.producesArtifacts must be an array when present`);
    } else {
      value.producesArtifacts.forEach((lane, laneIndex) => {
        validateArtifactLane(lane, `${location}.producesArtifacts[${laneIndex}]`, errors);
      });
    }
  }
  if (value.resourceContracts !== undefined) {
    if (!Array.isArray(value.resourceContracts)) {
      errors.push(`${location}.resourceContracts must be an array when present`);
    } else {
      value.resourceContracts.forEach((contract, contractIndex) => {
        validateResourceContract(contract, `${location}.resourceContracts[${contractIndex}]`, errors);
      });
    }
  }
  validateBudgets(value.budgets, `${location}.budgets`, errors);
  return true;
}

export function validateManifest(value: unknown): ValidationResult<CellFenceManifest> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["manifest must be an object"] };
  }
  if (value.schemaVersion !== CELLFENCE_MANIFEST_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${CELLFENCE_MANIFEST_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.cells)) {
    errors.push("cells must be an array");
  } else {
    value.cells.forEach((cell, cellIndex) => {
      validateCell(cell, `cells[${cellIndex}]`, errors);
    });
  }
  return errors.length === 0
    ? { ok: true, value: value as CellFenceManifest, errors: [] }
    : { ok: false, errors };
}

export function validateBaseline(value: unknown): ValidationResult<CellFenceBaseline> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["baseline must be an object"] };
  }
  if (value.schemaVersion !== CELLFENCE_BASELINE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${CELLFENCE_BASELINE_SCHEMA_VERSION}`);
  }
  if (typeof value.generatedAt !== "string" || value.generatedAt.trim().length === 0) {
    errors.push("generatedAt must be a non-empty string");
  }
  if (!isRecord(value.cells)) {
    errors.push("cells must be an object");
  } else {
    for (const [cellId, record] of Object.entries(value.cells)) {
      if (!isRecord(record)) {
        errors.push(`cells.${cellId} must be an object`);
        continue;
      }
      for (const key of ["ownedPathPatterns", "publicSymbols", "publicSurfaceLines", "crossCellDependencies"]) {
        const numericValue = record[key];
        if (!Number.isInteger(numericValue) || Number(numericValue) < 0) {
          errors.push(`cells.${cellId}.${key} must be a non-negative integer`);
        }
      }
      if (record.resourceAccesses !== undefined) {
        if (!Array.isArray(record.resourceAccesses)) {
          errors.push(`cells.${cellId}.resourceAccesses must be an array when present`);
        } else {
          record.resourceAccesses.forEach((entry, entryIndex) => {
            validateResourceBaselineEntry(entry, `cells.${cellId}.resourceAccesses[${entryIndex}]`, errors);
          });
        }
      }
    }
  }
  return errors.length === 0
    ? { ok: true, value: value as CellFenceBaseline, errors: [] }
    : { ok: false, errors };
}

export function validateResourceEvidence(value: unknown): ValidationResult<CellFenceResourceEvidence> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["resource evidence must be an object"] };
  }
  if (value.schemaVersion !== CELLFENCE_RESOURCE_EVIDENCE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${CELLFENCE_RESOURCE_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (!optionalString(value.commitSha)) {
    errors.push("commitSha must be a string when present");
  }
  if (!optionalString(value.generatedAt)) {
    errors.push("generatedAt must be a string when present");
  }
  if (!optionalString(value.cellId)) {
    errors.push("cellId must be a string when present");
  }
  if (!Array.isArray(value.accesses)) {
    errors.push("accesses must be an array");
  } else {
    value.accesses.forEach((entry, entryIndex) => {
      validateResourceEvidenceAccess(entry, `accesses[${entryIndex}]`, errors);
      if (isRecord(entry) && typeof entry.cellId !== "string" && typeof value.cellId !== "string") {
        errors.push(`accesses[${entryIndex}].cellId is required when top-level cellId is absent`);
      }
    });
  }
  return errors.length === 0
    ? { ok: true, value: value as CellFenceResourceEvidence, errors: [] }
    : { ok: false, errors };
}
