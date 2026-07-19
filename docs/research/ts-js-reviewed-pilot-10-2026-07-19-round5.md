# Reviewed TS/JS Precision Pilot 10 Round 5

This is a diagnostic rerun after adding Node fs provenance to file resource
detection and tightening package exports semantics. It is not a public
precision claim and does not create holdout evidence.

## Scope

- Date: 2026-07-19
- Subjects: the same 10 exact-commit public TypeScript/JavaScript repositories
  as `ts-js-reviewed-pilot-10-2026-07-19`
- Corpus: `docs/research/corpora/ts-js-reviewed-pilot-10-2026-07-19.json`
- Report: `reports/corpus/ts-js-reviewed-pilot-10-2026-07-19.round5.json`
- Safety: static CellFence checks only; no dependency install, package scripts,
  issues, PRs, or target repository writes.

## Detector and Resolver Changes

Round5 adds two hardening changes:

- file resource detection now requires import/require provenance for Node
  `fs`, `node:fs`, `fs/promises`, or `node:fs/promises` before treating
  `readFile`, `writeFile`, stream, append, or directory helpers as confirmed
  file resources. Local helpers, ambient facades, arbitrary receivers,
  shadowed bindings, and fd-backed streams stay out of confirmed file evidence.
- package export resolution now respects explicit `null` exclusions, wildcard
  fallback ordering, root string shorthand, and root conditional shorthand.
  `packageExportState` is preserved on internal and plugin import references so
  generated public targets, private exclusions, and unknown resolver failures
  remain distinguishable after resolution.

## Run Summary

The fixed corpus completed all 10 subjects with no clone, configuration, tool,
timeout, or evidence graph verification failures.

```text
subjects: 10
checks clean: 2
checks with findings: 8
evidence graphs verified: 10
evidence graph failures: 0
raw check findings: 75
```

The raw finding count matches round4. The value of this pass is regression
hardening: the already-tuned 10 subject diagnostic corpus did not need further
resource suppression, but the detector now has narrower provenance boundaries
for future corpora.

```text
CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT: 11
CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE: 29
CELLFENCE_UNRESOLVED_IMPORT: 3
CELLFENCE_UNDECLARED_CONSUMER: 25
CELLFENCE_PRIVATE_IMPORT: 2
CELLFENCE_UNRESOLVED_RESOURCE_ACCESS: 3
CELLFENCE_UNDECLARED_RESOURCE_ACCESS: 2
```

## Remaining Judgment Required

These remain explicit review decisions, not auto-acceptance targets:

- generated artifacts that are declared public but missing from the checkout
  must be handled by a generated-artifact lane, generation protocol, waiver, or
  exclusion decision;
- Remix/Vue-style internal wiring must be represented by reviewed policy,
  explicit corpus scope, or waiver before entering a precision denominator;
- remaining dynamic SQL and package metadata file findings require policy
  review rather than detector suppression;
- wrapper libraries such as `fs-extra`, `graceful-fs`, virtual file systems,
  and application-level file facades are not confirmed Node fs evidence until
  reviewed adapter policy exists for them.

The follow-up round6 diagnostic is documented in
[ts-js-reviewed-pilot-10-2026-07-19-round6.md](ts-js-reviewed-pilot-10-2026-07-19-round6.md).
