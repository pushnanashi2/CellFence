export const DEFAULT_MANIFEST_PATH = "cellfence.manifest.json";
export const DEFAULT_BASELINE_PATH = "cellfence.baseline.json";
export const DEFAULT_CLAIMS_PATH = ".cellfence/claims.json";

/**
 * Rules that the engine refuses to waive. These represent the core claims
 * of the CellFence model: agents cannot silently widen their consumption,
 * cannot rewrite their public surface, and cannot access undeclared
 * resources. `init-presets.ts` and downstream manifests should re-export
 * this list (or extend it) rather than re-derive their own copy.
 */
export const CORE_REQUIRED_RULES = [
  "CELLFENCE_OWNERSHIP_OVERLAP",
  "CELLFENCE_UNOWNED_SOURCE",
  "CELLFENCE_UNOWNED_IMPORT_TARGET",
  "CELLFENCE_IMPORT_TARGET_OUTSIDE_ROOT",
  "CELLFENCE_PUBLIC_ENTRY_OUTSIDE_OWNERSHIP",
  "CELLFENCE_ARTIFACT_OUTSIDE_OWNERSHIP",
  "CELLFENCE_SYMLINK_TARGET_OUTSIDE_OWNERSHIP",
  "CELLFENCE_PRIVATE_IMPORT",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
  "CELLFENCE_UNSUPPORTED_TYPESCRIPT_SYNTAX",
  "CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX",
  "CELLFENCE_UNDECLARED_CONSUMER",
  "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
  "CELLFENCE_UNDECLARED_RESOURCE_ACCESS",
  "CELLFENCE_REQUIRED_RULE_DISABLED",
  "CELLFENCE_WAIVER_INVALID",
];
