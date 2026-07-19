# Reviewed TS/JS Precision Pilot 10 Round 7

This is the final diagnostic rerun for the fs-provenance and package-exports
hardening loop. It is not a public precision claim and does not create holdout
evidence.

## Scope

- Date: 2026-07-19
- Subjects: the same 10 exact-commit public TypeScript/JavaScript repositories
  as `ts-js-reviewed-pilot-10-2026-07-19`
- Corpus: `docs/research/corpora/ts-js-reviewed-pilot-10-2026-07-19.json`
- Report: `reports/corpus/ts-js-reviewed-pilot-10-2026-07-19.round7.json`
- Safety: static CellFence checks only; no dependency install, package scripts,
  issues, PRs, or target repository writes.

## Final Hardening In This Round

Round7 closes the remaining P1 review gaps from the third loop:

- fs import/require provenance is scoped. A block-local fs binding no longer
  taints same-named helpers or facades outside that lexical scope.
- fs namespace aliases remain detected inside their visible scope, including
  scoped `require("node:fs")` and destructured `fs.promises` aliases.
- inline require calls such as `require("node:fs").readFileSync(...)` and
  `require("node:fs/promises").writeFile(...)` are confirmed fs evidence.
- package target arrays treat `[null, target]` as fallback but `[null]` as an
  explicit exclusion, so more-specific array exclusions cannot fall through to
  broader wildcard exports.

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

The raw finding count matches rounds 4 through 6. This confirms the hardening
did not silently suppress additional findings in the tuned diagnostic corpus;
the value is a narrower detector contract and stronger future regression
coverage.

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

The follow-up round8 diagnostic is documented in
[ts-js-reviewed-pilot-10-2026-07-19-round8.md](ts-js-reviewed-pilot-10-2026-07-19-round8.md).
