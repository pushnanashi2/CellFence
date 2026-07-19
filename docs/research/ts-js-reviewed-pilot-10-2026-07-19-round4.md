# Reviewed TS/JS Precision Pilot 10 Round 4

This is a diagnostic rerun after tightening package-export resolution state and
removing method-name-only HTTP/queue resource detections. It is not a public
precision claim and does not create holdout evidence.

## Scope

- Date: 2026-07-19
- Subjects: the same 10 exact-commit public TypeScript/JavaScript repositories
  as `ts-js-reviewed-pilot-10-2026-07-19`
- Corpus: `docs/research/corpora/ts-js-reviewed-pilot-10-2026-07-19.json`
- Report: `reports/corpus/ts-js-reviewed-pilot-10-2026-07-19.round4.json`
- Safety: static CellFence checks only; no dependency install, package scripts,
  issues, PRs, or target repository writes.

## Detector and Resolver Changes

Round4 adds two guardrails prompted by the round2/round3 review:

- workspace package export resolution now has explicit internal states:
  `PUBLIC_RESOLVED`, `PUBLIC_DECLARED_GENERATED_TARGET_MISSING`,
  `NOT_EXPORTED_PRIVATE`, and `UNRESOLVED_UNKNOWN`. This keeps generated
  public targets, private subpaths, and unknown resolver failures from being
  collapsed into one interpretation.
- generic HTTP and queue resource detection no longer treats bare calls such as
  `get("/")`, `publish("events.created")`, or `subscribe("events.created")` as
  blocking resource evidence. Property calls with route/server/queue-like
  receivers, such as `router.get("/")` and `bus.publish("events.created")`,
  remain detected.

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

The round4 raw finding count matches round3. That means the new bare-call
guards did not suppress additional findings in this already-tuned 10 subject
diagnostic corpus; their value is regression prevention for method-name-only
false positives.

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
- file resource detection still needs a separate import/binding provenance pass
  before direct `readFile`-style helpers can be treated as confirmed Node fs
  calls rather than ambiguous local functions.

The follow-up round5 diagnostic is documented in
[ts-js-reviewed-pilot-10-2026-07-19-round5.md](ts-js-reviewed-pilot-10-2026-07-19-round5.md).
