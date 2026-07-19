# Reviewed TS/JS Precision Pilot 10 Round 8

This is the final diagnostic rerun after inline fs require support was added to
the fs-provenance hardening loop. It is not a public precision claim and does
not create holdout evidence.

## Scope

- Date: 2026-07-19
- Subjects: the same 10 exact-commit public TypeScript/JavaScript repositories
  as `ts-js-reviewed-pilot-10-2026-07-19`
- Corpus: `docs/research/corpora/ts-js-reviewed-pilot-10-2026-07-19.json`
- Report: `reports/corpus/ts-js-reviewed-pilot-10-2026-07-19.round8.json`
- Safety: static CellFence checks only; no dependency install, package scripts,
  issues, PRs, or target repository writes.

## Final Hardening In This Round

Round8 preserves the round7 scoped provenance behavior and adds direct inline
require support:

- `require("node:fs").readFileSync(...)` and
  `require("node:fs/promises").writeFile(...)` are confirmed file evidence;
- scoped fs aliases remain scoped, so local helpers with the same name outside
  that lexical scope are not tainted;
- exact package export state, wildcard specificity, and array-wrapped `null`
  exclusions remain covered by conformance tests.

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

The raw finding count matches rounds 4 through 7. The result is a narrower
detector contract and stronger future regression coverage, not a new external
precision claim.

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
