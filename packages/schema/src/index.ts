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
export type BuiltInResourceAdapter =
  | "file"
  | "http"
  | "queue"
  | "sql-literal"
  | "prisma"
  | "typeorm"
  | "drizzle"
  | "query-builder"
  | "bullmq"
  | "kafkajs"
  | "nestjs"
  | "fastify";
export type ResourceAdapterStatus = "on" | "off";
export type ResourceAdapterMap = Partial<Record<BuiltInResourceAdapter, ResourceAdapterStatus>>;

export type ResourceContractManifest = {
  id: string;
  kind: ResourceContractKind;
  access: ResourceAccessMode[];
  selectors: string[];
  locked?: boolean;
  description?: string;
};

export type ResourceBaselineEntry = {
  kind: ResourceContractKind;
  access: ResourceAccessMode;
  selector: string;
  detectedBy?: string;
  confidence?: ResourceAccessConfidence;
};

export type RuleSeverity = "off" | "warning" | "error";
export type RuleSeverityMap = Record<string, RuleSeverity>;

export type RuleOverride = {
  files: string[];
  rules: RuleSeverityMap;
};

export type PluginReference =
  | string
  | {
    package: string;
    options?: Record<string, unknown>;
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

export type ManifestGovernance = {
  requireOwnership?: boolean;
  include?: string[];
  exclude?: string[];
  requiredRules?: string[];
  resourceAdapters?: ResourceAdapterMap;
};

export type CellManifest = {
  id: string;
  ownedPaths: string[];
  publicEntry: string;
  publicSymbols: string[];
  packageName?: string;
  locked?: boolean;
  consumes?: CellConsumerManifest[];
  producesArtifacts?: ArtifactLaneManifest[];
  resourceContracts?: ResourceContractManifest[];
  budgets?: ArchitecturalBudgets;
  rules?: RuleSeverityMap;
};

export type CellFenceManifest = {
  schemaVersion: typeof CELLFENCE_MANIFEST_SCHEMA_VERSION;
  extends?: string[];
  plugins?: PluginReference[];
  governance?: ManifestGovernance;
  rules?: RuleSeverityMap;
  overrides?: RuleOverride[];
  cells: CellManifest[];
};

export type CellBaselineRecord = {
  ownedPathPatterns: number;
  publicSymbols: number;
  publicSurfaceLines: number;
  crossCellDependencies: number;
  ownedPathSet?: string[];
  publicEntryPath?: string;
  publicSymbolSet?: string[];
  publicSurfaceHash?: string;
  dependencyEdges?: string[];
  artifactContracts?: string[];
  resourceAccesses?: ResourceBaselineEntry[];
};

export type CellFenceBaseline = {
  schemaVersion: typeof CELLFENCE_BASELINE_SCHEMA_VERSION;
  generatedAt: string;
  cellIds?: string[];
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

// Stryker disable all: internal schema validator helpers are exercised through public validateManifest/validateBaseline/validateResourceEvidence black-box tests; mutating individual error strings and type-predicate booleans creates noisy equivalent variants.
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function isRuleSeverity(value: unknown): value is RuleSeverity {
  return value === "off" || value === "warning" || value === "error";
}

const BUILT_IN_RESOURCE_ADAPTERS = new Set([
  "file",
  "http",
  "queue",
  "sql-literal",
  "prisma",
  "typeorm",
  "drizzle",
  "query-builder",
  "bullmq",
  "kafkajs",
  "nestjs",
  "fastify",
]);

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function validateConsumer(value: unknown, location: string, errors: string[]): value is CellConsumerManifest {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object like {"cell":"producer-cell"}`);
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
  if (!optionalBoolean(value.locked)) {
    errors.push(`${location}.locked must be a boolean when present`);
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

function validateGovernance(value: unknown, location: string, errors: string[]): value is ManifestGovernance {
  if (value === undefined) return true;
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  if (!optionalBoolean(value.requireOwnership)) {
    errors.push(`${location}.requireOwnership must be a boolean when present`);
  }
  if (value.include !== undefined && !isStringArray(value.include)) {
    errors.push(`${location}.include must be an array of non-empty strings when present`);
  }
  if (value.exclude !== undefined && !isStringArray(value.exclude)) {
    errors.push(`${location}.exclude must be an array of non-empty strings when present`);
  }
  if (value.requiredRules !== undefined && !isStringArray(value.requiredRules)) {
    errors.push(`${location}.requiredRules must be an array of non-empty strings when present`);
  }
  if (value.resourceAdapters !== undefined) {
    if (!isRecord(value.resourceAdapters)) {
      errors.push(`${location}.resourceAdapters must be an object when present`);
    } else {
      for (const [adapterName, status] of Object.entries(value.resourceAdapters)) {
        if (!BUILT_IN_RESOURCE_ADAPTERS.has(adapterName)) {
          errors.push(`${location}.resourceAdapters.${adapterName} must be a known built-in adapter`);
        }
        if (status !== "on" && status !== "off") {
          errors.push(`${location}.resourceAdapters.${adapterName} must be on|off`);
        }
      }
    }
  }
  if (value.requireOwnership === true && (!Array.isArray(value.include) || value.include.length === 0)) {
    errors.push(`${location}.include must contain at least one pattern when requireOwnership is true`);
  }
  return true;
}

function validateRuleSeverityMap(value: unknown, location: string, errors: string[]): value is RuleSeverityMap {
  if (value === undefined) return true;
  if (!isRecord(value)) {
    errors.push(`${location} must be an object mapping rule ids to off|warning|error`);
    return false;
  }
  for (const [ruleId, severity] of Object.entries(value)) {
    if (ruleId.trim().length === 0) {
      errors.push(`${location} contains an empty rule id`);
    }
    if (!isRuleSeverity(severity)) {
      errors.push(`${location}.${ruleId} must be off|warning|error`);
    }
  }
  return true;
}

function validatePluginReference(value: unknown, location: string, errors: string[]): value is PluginReference {
  if (typeof value === "string" && value.trim().length > 0) return true;
  if (!isRecord(value)) {
    errors.push(`${location} must be a package string or an object like {"package":"plugin-name"}`);
    return false;
  }
  if (typeof value.package !== "string" || value.package.trim().length === 0) {
    errors.push(`${location}.package must be a non-empty string`);
  }
  if (value.options !== undefined && !isRecord(value.options)) {
    errors.push(`${location}.options must be an object when present`);
  }
  return true;
}

function validateRuleOverride(value: unknown, location: string, errors: string[]): value is RuleOverride {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  if (!isStringArray(value.files)) {
    errors.push(`${location}.files must be an array of non-empty strings`);
  }
  if (value.rules === undefined) {
    errors.push(`${location}.rules is required`);
  }
  validateRuleSeverityMap(value.rules, `${location}.rules`, errors);
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
  if (!optionalBoolean(value.locked)) {
    errors.push(`${location}.locked must be a boolean when present`);
  }
  if (value.consumes !== undefined) {
    if (!Array.isArray(value.consumes)) {
      errors.push(`${location}.consumes must be an array of objects like [{"cell":"producer-cell"}] when present`);
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
  validateRuleSeverityMap(value.rules, `${location}.rules`, errors);
  return true;
}
// Stryker restore all

export function validateManifest(value: unknown): ValidationResult<CellFenceManifest> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["manifest must be an object"] };
  }
  if (value.schemaVersion !== CELLFENCE_MANIFEST_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${CELLFENCE_MANIFEST_SCHEMA_VERSION}`);
  }
  if (value.extends !== undefined) {
    if (!isStringArray(value.extends)) {
      errors.push("extends must be an array of non-empty strings when present");
    }
    errors.push("extends is reserved for a future manifest loader and is not supported in manifest v1");
  }
  if (value.plugins !== undefined) {
    if (!Array.isArray(value.plugins)) {
      errors.push("plugins must be an array when present");
    } else {
      value.plugins.forEach((plugin, pluginIndex) => {
        validatePluginReference(plugin, `plugins[${pluginIndex}]`, errors);
      });
    }
    errors.push("plugins is reserved for a future trusted plugin loader and is not supported in manifest v1; pass plugins programmatically");
  }
  validateRuleSeverityMap(value.rules, "rules", errors);
  if (value.overrides !== undefined) {
    if (!Array.isArray(value.overrides)) {
      errors.push("overrides must be an array when present");
    } else {
      value.overrides.forEach((override, overrideIndex) => {
        validateRuleOverride(override, `overrides[${overrideIndex}]`, errors);
      });
    }
  }
  if (!Array.isArray(value.cells)) {
    errors.push("cells must be an array");
  } else {
    value.cells.forEach((cell, cellIndex) => {
      validateCell(cell, `cells[${cellIndex}]`, errors);
    });
  }
  validateGovernance(value.governance, "governance", errors);
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
  if (value.cellIds !== undefined && !isStringArray(value.cellIds)) {
    errors.push("cellIds must be an array of non-empty strings when present");
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
      for (const key of ["ownedPathSet", "publicSymbolSet", "dependencyEdges", "artifactContracts"]) {
        if (record[key] !== undefined && !isStringArray(record[key])) {
          errors.push(`cells.${cellId}.${key} must be an array of non-empty strings when present`);
        }
      }
      if (!optionalString(record.publicEntryPath)) {
        errors.push(`cells.${cellId}.publicEntryPath must be a string when present`);
      }
      if (!optionalString(record.publicSurfaceHash)) {
        errors.push(`cells.${cellId}.publicSurfaceHash must be a string when present`);
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
