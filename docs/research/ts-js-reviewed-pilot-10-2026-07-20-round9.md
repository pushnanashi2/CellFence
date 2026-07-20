# Reviewed TS/JS Precision Pilot 10 Round 9

This is a diagnostic rerun of the same reviewed TS/JS 10-repository corpus after
the precision evidence pipeline was hardened. It is not a public precision claim
and does not create holdout evidence.

## Scope

- Date: 2026-07-20
- Subjects: the same 10 exact-commit public TypeScript/JavaScript repositories
  as `ts-js-reviewed-pilot-10-2026-07-19`
- Corpus: `docs/research/corpora/ts-js-reviewed-pilot-10-2026-07-19.json`
- Report: `reports/corpus/ts-js-reviewed-pilot-10-2026-07-20.round9.json`
- Reviewed corpus validation:
  `reports/corpus/ts-js-reviewed-pilot-10-2026-07-20-round9-reviewed-corpus-validation.json`
- Evidence bundle:
  `reports/corpus/ts-js-reviewed-pilot-10-2026-07-20-round9-bundle`
- Label readiness:
  `reports/corpus/ts-js-reviewed-pilot-10-2026-07-20-round9-label-readiness.json`
- Safety: static CellFence checks only; no dependency install, package scripts,
  issues, PRs, or target repository writes.

## Pipeline Hardening In This Round

Round9 keeps the round8 detector behavior and hardens the evidence pipeline
that would be used before any external precision claim:

- evidence bundles now reject missing audit logs for claimed findings;
- audit finding counts must reconcile with the corpus report;
- rejected audit findings feed the blocking-precision denominator, while
  warning-only findings remain in logs and evidence graphs;
- claim evaluation recomputes every file listed in `SHA256SUMS`;
- claim protocols must pre-register `toolCommit`, the pre-label
  `preLabelArtifactSetSha256`, and the final labeled `artifactSetSha256`;
- independent labels must be explicitly split into `blind_first` and
  `blind_second`, with `sawPeerLabels: false`;
- disagreements require a separate adjudicator, and adjudication is rejected
  when the independent labels already agree;
- a `pass` decision now gates pooled occurrence, rule-level, unique-fingerprint,
  repository-macro, and per-repository precision.

## Run Summary

The fixed corpus completed all 10 subjects with no clone, configuration, tool,
timeout, or evidence graph verification failures.

```text
subjects: 10
checks clean: 2
checks with findings: 8
evidence graphs verified: 10
evidence graph failures: 0
raw rejected findings: 75
sampled findings: 75
```

The finding distribution is unchanged from round8:

```text
CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT: 11
CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE: 29
CELLFENCE_UNRESOLVED_IMPORT: 3
CELLFENCE_UNDECLARED_CONSUMER: 25
CELLFENCE_PRIVATE_IMPORT: 2
CELLFENCE_UNRESOLVED_RESOURCE_ACCESS: 3
CELLFENCE_UNDECLARED_RESOURCE_ACCESS: 2
```

## Claim Status

The round9 bundle is intentionally claim-ineligible today. The label readiness
gate reports:

```text
sampled findings: 75
sampled precision-eligible findings: 75
labels: 0
fully labeled findings: 0
issues: 150
ok: false
```

This is the desired failure mode. The current evidence supports pipeline
robustness and regression diagnosis, not an external 99% precision claim.

Even if all 75 findings were labeled true positive, the sample would remain far
below the default power target for a one-sided 95% lower bound of 99% precision:
299 zero-false-positive labeled findings per included rule, plus rule-level,
unique-fingerprint, repository-macro, and per-repository gates.

## Remaining Judgment Required

These remain explicit review decisions, not auto-acceptance targets:

- generated artifacts that are declared public but missing from the checkout
  must be handled by a generated-artifact lane, generation protocol, waiver, or
  exclusion decision;
- Remix/Vue-style internal wiring must be represented by reviewed policy,
  explicit corpus scope, or waiver before entering a precision denominator;
- remaining dynamic import/require findings are mostly fail-closed candidates,
  but they still require blind labels before being counted;
- resource findings require policy review rather than detector suppression.
