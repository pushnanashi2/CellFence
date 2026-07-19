# Reviewed TS/JS Precision Pilot 10 Round 6

This is a diagnostic rerun after the second review pass on Node fs provenance
and package exports semantics. It is not a public precision claim and does not
create holdout evidence.

## Scope

- Date: 2026-07-19
- Subjects: the same 10 exact-commit public TypeScript/JavaScript repositories
  as `ts-js-reviewed-pilot-10-2026-07-19`
- Corpus: `docs/research/corpora/ts-js-reviewed-pilot-10-2026-07-19.json`
- Report: `reports/corpus/ts-js-reviewed-pilot-10-2026-07-19.round6.json`
- Safety: static CellFence checks only; no dependency install, package scripts,
  issues, PRs, or target repository writes.

## Final Hardening In This Round

Round6 preserves the round5 intent and closes review gaps found by the
second-pass agents:

- scoped `require("node:fs")` and destructured scoped require bindings are now
  treated as fs provenance rather than being shadowed by their own declaration;
- aliases from a proven fs namespace, such as `const read = fs.readFileSync`,
  are tracked as fs-bound direct calls;
- shadowed parameters and later local helpers still suppress confirmed fs
  evidence;
- explicit package export `null` exclusions take precedence over broader
  wildcard exports;
- package target arrays continue past `null` fallback entries;
- exact package-name imports preserve package export state instead of always
  fabricating `PUBLIC_RESOLVED`.

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

The raw finding count matches round4 and round5. The value of this pass is
semantic hardening and regression coverage rather than additional suppression
of the already-tuned diagnostic corpus.

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

The follow-up round7 diagnostic is documented in
[ts-js-reviewed-pilot-10-2026-07-19-round7.md](ts-js-reviewed-pilot-10-2026-07-19-round7.md).
