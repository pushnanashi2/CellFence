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
  | "fastify"
  | "django"
  | "fastapi"
  | "sqlalchemy"
  | "celery";
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

export type PathClassKind = "source" | "runtime" | "generated" | "testFixture" | "locked";

export type PathClassCommitPolicy = {
  allowMixedWith?: PathClassKind[];
  requireTrailer?: string;
  generatedRequiresProvenance?: boolean;
};

export type PathClassManifest = {
  id: string;
  kind: PathClassKind;
  paths: string[];
  description?: string;
  commitPolicy?: PathClassCommitPolicy;
};

export type CheckProfileManifest = {
  description?: string;
  rules?: RuleSeverityMap;
  changedOnly?: boolean;
  reportOnly?: boolean;
  requireEvidenceWithinCommits?: number;
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
  pathClasses?: PathClassManifest[];
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
  profiles?: Record<string, CheckProfileManifest>;
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

export type BaselineSeal =
  | {
      algorithm: "hmac-sha256";
      keyId?: string;
      digest: string;
    }
  | {
      algorithm: "ed25519";
      keyId?: string;
      signature: string;
    };

export type CellFenceBaseline = {
  schemaVersion: typeof CELLFENCE_BASELINE_SCHEMA_VERSION;
  generatedAt: string;
  cellIds?: string[];
  seal?: BaselineSeal;
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

function validateKnownKeys(value: Record<string, unknown>, location: string, allowedKeys: readonly string[], errors: string[]): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${location}.${key} is not a supported field`);
  }
}

function validateUniqueNonEmptyStrings(values: string[], location: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) errors.push(`${location} contains duplicate entry ${value}`);
    seen.add(value);
  }
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
  "django",
  "fastapi",
  "sqlalchemy",
  "celery",
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
  validateKnownKeys(value, location, ["cell", "artifactLanes"], errors);
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
  validateKnownKeys(value, location, ["id", "paths", "description", "locked"], errors);
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
  validateKnownKeys(value, location, ["id", "kind", "access", "selectors", "locked", "description"], errors);
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
  if (!optionalBoolean(value.locked)) {
    errors.push(`${location}.locked must be a boolean when present`);
  }
  return errors.length === 0 || typeof value.id === "string";
}

function validatePathClass(value: unknown, location: string, errors: string[]): value is PathClassManifest {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  validateKnownKeys(value, location, ["id", "kind", "paths", "description", "commitPolicy"], errors);
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    errors.push(`${location}.id must be a non-empty string`);
  }
  if (!["source", "runtime", "generated", "testFixture", "locked"].includes(String(value.kind))) {
    errors.push(`${location}.kind must be source|runtime|generated|testFixture|locked`);
  }
  if (!isStringArray(value.paths)) {
    errors.push(`${location}.paths must be an array of non-empty strings`);
  }
  if (!optionalString(value.description)) {
    errors.push(`${location}.description must be a string when present`);
  }
  if (value.commitPolicy !== undefined) {
    if (!isRecord(value.commitPolicy)) {
      errors.push(`${location}.commitPolicy must be an object when present`);
    } else {
      const policy = value.commitPolicy;
      validateKnownKeys(policy, `${location}.commitPolicy`, ["allowMixedWith", "requireTrailer", "generatedRequiresProvenance"], errors);
      if (policy.allowMixedWith !== undefined && (!Array.isArray(policy.allowMixedWith) || !policy.allowMixedWith.every((entry) => ["source", "runtime", "generated", "testFixture", "locked"].includes(String(entry))))) {
        errors.push(`${location}.commitPolicy.allowMixedWith must contain source|runtime|generated|testFixture|locked`);
      }
      if (!optionalString(policy.requireTrailer)) {
        errors.push(`${location}.commitPolicy.requireTrailer must be a string when present`);
      }
      if (!optionalBoolean(policy.generatedRequiresProvenance)) {
        errors.push(`${location}.commitPolicy.generatedRequiresProvenance must be a boolean when present`);
      }
    }
  }
  return true;
}

function validateResourceBaselineEntry(value: unknown, location: string, errors: string[], extraAllowedKeys: string[] = []): value is ResourceBaselineEntry {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  validateKnownKeys(value, location, ["kind", "access", "selector", "detectedBy", "confidence", ...extraAllowedKeys], errors);
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
  validateResourceBaselineEntry(value, location, errors, ["cellId", "observedAt"]);
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
  validateKnownKeys(value, location, ["ownedPathPatterns", "publicSymbols", "publicSurfaceLines", "crossCellDependencies"], errors);
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
  validateKnownKeys(value, location, ["requireOwnership", "include", "exclude", "requiredRules", "resourceAdapters", "pathClasses"], errors);
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
  if (value.pathClasses !== undefined) {
    if (!Array.isArray(value.pathClasses)) {
      errors.push(`${location}.pathClasses must be an array when present`);
    } else {
      const pathClassIds: string[] = [];
      value.pathClasses.forEach((pathClass, pathClassIndex) => {
        validatePathClass(pathClass, `${location}.pathClasses[${pathClassIndex}]`, errors);
        if (isRecord(pathClass) && typeof pathClass.id === "string" && pathClass.id.trim().length > 0) pathClassIds.push(pathClass.id);
      });
      validateUniqueNonEmptyStrings(pathClassIds, `${location}.pathClasses[].id`, errors);
    }
  }
  if (value.requireOwnership === true && (!Array.isArray(value.include) || value.include.length === 0)) {
    errors.push(`${location}.include must contain at least one pattern when requireOwnership is true`);
  }
  return true;
}

function validateProfile(value: unknown, location: string, errors: string[]): value is CheckProfileManifest {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  validateKnownKeys(value, location, ["description", "rules", "changedOnly", "reportOnly", "requireEvidenceWithinCommits"], errors);
  if (!optionalString(value.description)) {
    errors.push(`${location}.description must be a string when present`);
  }
  validateRuleSeverityMap(value.rules, `${location}.rules`, errors);
  if (!optionalBoolean(value.changedOnly)) {
    errors.push(`${location}.changedOnly must be a boolean when present`);
  }
  if (!optionalBoolean(value.reportOnly)) {
    errors.push(`${location}.reportOnly must be a boolean when present`);
  }
  if (value.requireEvidenceWithinCommits !== undefined && (!Number.isInteger(value.requireEvidenceWithinCommits) || Number(value.requireEvidenceWithinCommits) < 0)) {
    errors.push(`${location}.requireEvidenceWithinCommits must be a non-negative integer when present`);
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
  validateKnownKeys(value, location, ["package", "options"], errors);
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
  validateKnownKeys(value, location, ["files", "rules"], errors);
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
  validateKnownKeys(value, location, [
    "id",
    "ownedPaths",
    "publicEntry",
    "publicSymbols",
    "packageName",
    "locked",
    "consumes",
    "producesArtifacts",
    "resourceContracts",
    "budgets",
    "rules",
  ], errors);
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
      const consumerCells: string[] = [];
      value.consumes.forEach((consumer, consumerIndex) => {
        validateConsumer(consumer, `${location}.consumes[${consumerIndex}]`, errors);
        if (isRecord(consumer) && typeof consumer.cell === "string" && consumer.cell.trim().length > 0) consumerCells.push(consumer.cell);
      });
      validateUniqueNonEmptyStrings(consumerCells, `${location}.consumes[].cell`, errors);
    }
  }
  if (value.producesArtifacts !== undefined) {
    if (!Array.isArray(value.producesArtifacts)) {
      errors.push(`${location}.producesArtifacts must be an array when present`);
    } else {
      const artifactIds: string[] = [];
      value.producesArtifacts.forEach((lane, laneIndex) => {
        validateArtifactLane(lane, `${location}.producesArtifacts[${laneIndex}]`, errors);
        if (isRecord(lane) && typeof lane.id === "string" && lane.id.trim().length > 0) artifactIds.push(lane.id);
      });
      validateUniqueNonEmptyStrings(artifactIds, `${location}.producesArtifacts[].id`, errors);
    }
  }
  if (value.resourceContracts !== undefined) {
    if (!Array.isArray(value.resourceContracts)) {
      errors.push(`${location}.resourceContracts must be an array when present`);
    } else {
      const contractIds: string[] = [];
      value.resourceContracts.forEach((contract, contractIndex) => {
        validateResourceContract(contract, `${location}.resourceContracts[${contractIndex}]`, errors);
        if (isRecord(contract) && typeof contract.id === "string" && contract.id.trim().length > 0) contractIds.push(contract.id);
      });
      validateUniqueNonEmptyStrings(contractIds, `${location}.resourceContracts[].id`, errors);
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
  validateKnownKeys(value, "manifest", ["schemaVersion", "extends", "plugins", "governance", "rules", "overrides", "profiles", "cells"], errors);
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
  if (value.profiles !== undefined) {
    if (!isRecord(value.profiles)) {
      errors.push("profiles must be an object when present");
    } else {
      for (const [profileName, profile] of Object.entries(value.profiles)) {
        if (profileName.trim().length === 0) errors.push("profiles contains an empty profile name");
        validateProfile(profile, `profiles.${profileName}`, errors);
      }
    }
  }
  if (!Array.isArray(value.cells)) {
    errors.push("cells must be an array");
  } else {
    const packageNames: string[] = [];
    value.cells.forEach((cell, cellIndex) => {
      validateCell(cell, `cells[${cellIndex}]`, errors);
      if (isRecord(cell) && typeof cell.packageName === "string" && cell.packageName.trim().length > 0) packageNames.push(cell.packageName);
    });
    validateUniqueNonEmptyStrings(packageNames, "cells[].packageName", errors);
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
  validateKnownKeys(value, "baseline", ["schemaVersion", "generatedAt", "cellIds", "seal", "cells"], errors);
  if (value.schemaVersion !== CELLFENCE_BASELINE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${CELLFENCE_BASELINE_SCHEMA_VERSION}`);
  }
  if (typeof value.generatedAt !== "string" || value.generatedAt.trim().length === 0) {
    errors.push("generatedAt must be a non-empty string");
  }
  if (value.cellIds !== undefined && !isStringArray(value.cellIds)) {
    errors.push("cellIds must be an array of non-empty strings when present");
  }
  if (value.seal !== undefined) {
    if (!isRecord(value.seal)) {
      errors.push("seal must be an object when present");
    } else {
      if (value.seal.algorithm === "hmac-sha256") {
        validateKnownKeys(value.seal, "seal", ["algorithm", "keyId", "digest"], errors);
      } else if (value.seal.algorithm === "ed25519") {
        validateKnownKeys(value.seal, "seal", ["algorithm", "keyId", "signature"], errors);
      } else {
        validateKnownKeys(value.seal, "seal", ["algorithm", "keyId", "digest", "signature"], errors);
      }
      if (!optionalString(value.seal.keyId)) {
        errors.push("seal.keyId must be a string when present");
      }
      if (value.seal.algorithm === "hmac-sha256") {
        if (typeof value.seal.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.seal.digest)) {
          errors.push("seal.digest must be a 64-character lowercase hex string");
        }
      } else if (value.seal.algorithm === "ed25519") {
        if (typeof value.seal.signature !== "string" || value.seal.signature.trim().length === 0) {
          errors.push("seal.signature must be a non-empty base64 string");
        } else if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.seal.signature) || value.seal.signature.length % 4 !== 0) {
          errors.push("seal.signature must be a base64 string");
        }
      } else {
        errors.push("seal.algorithm must be hmac-sha256 or ed25519");
      }
    }
  }
  if (!isRecord(value.cells)) {
    errors.push("cells must be an object");
  } else {
    for (const [cellId, record] of Object.entries(value.cells)) {
      if (!isRecord(record)) {
        errors.push(`cells.${cellId} must be an object`);
        continue;
      }
      validateKnownKeys(record, `cells.${cellId}`, [
        "ownedPathPatterns",
        "publicSymbols",
        "publicSurfaceLines",
        "crossCellDependencies",
        "ownedPathSet",
        "publicEntryPath",
        "publicSymbolSet",
        "publicSurfaceHash",
        "dependencyEdges",
        "artifactContracts",
        "resourceAccesses",
      ], errors);
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
  validateKnownKeys(value, "resource evidence", ["schemaVersion", "commitSha", "generatedAt", "cellId", "accesses"], errors);
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
