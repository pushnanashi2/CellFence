# TS/JS Reviewed Pilot 105 Round 26 Gap-Directed Code Search

Date: 2026-07-25

This round tested whether a fresh GitHub code-search candidate pool can reduce
the remaining 99% precision-claim sample deficits for the 105-subject reviewed
TS/JS corpus. It does not create labels, external manifest attestations, or a
public precision claim.

## Candidate Corpus

- Corpus:
  `docs/research/corpora/gap-directed-ts-js-40-2026-07-25.json`
- Source:
  GitHub code search seeds for dynamic `import(`, computed `require(...)`,
  `package.json` exports, and workspaces.
- Safety:
  static CellFence checks only; no target dependency install, package scripts,
  PRs, or issues.
- Interpretation:
  all manifests are `infer` + production scope diagnostics. They are candidate
  sourcing evidence only until copied, reviewed, frozen, labeled, and externally
  attested.

## Run Result

The 40-subject diagnostic corpus completed without clone, configuration, tool,
parse, or timeout failures.

Raw finding counts:

- `CELLFENCE_PRIVATE_IMPORT`: 500
- `CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE`: 57
- `CELLFENCE_UNRESOLVED_RESOURCE_ACCESS`: 27
- `CELLFENCE_UNRESOLVED_IMPORT`: 10
- `CELLFENCE_PUBLIC_ENTRY_MISSING`: 9
- `CELLFENCE_UNSUPPORTED_TYPESCRIPT_SYNTAX`: 6
- `CELLFENCE_UNDECLARED_RESOURCE_ACCESS`: 3
- `CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT`: 2

Expansion-plan sampled coverage against the current 105-subject bundle:

- `CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE`: 57 candidate findings
- `CELLFENCE_UNRESOLVED_IMPORT`: 10 candidate findings
- `CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT`: 2 candidate findings
- `CELLFENCE_UNDECLARED_CONSUMER`: 0 candidate findings
- `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`: 0 candidate findings

## Decision

This candidate pool is useful for dynamic-require follow-up review, but it is
not sufficient for a 99% precision claim. After applying the diagnostic
expansion plan, the unresolved deficits would still include:

- `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`: 293 remaining
- `CELLFENCE_UNDECLARED_CONSUMER`: 158 remaining
- `CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT`: 253 remaining
- `CELLFENCE_UNRESOLVED_IMPORT`: 150 remaining
- `CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE`: 140 remaining

The zero coverage for public-symbol mismatch and undeclared consumer confirms
that more generic OSS harvesting is not enough. The next real cycle needs a
pre-registered rule-specific holdout or a new candidate-sourcing strategy aimed
at package boundary drift and workspace consumer edges.

## Diagnostic Artifacts

- Corpus run:
  `reports/corpus/gap-directed-ts-js-40-2026-07-25.production-scope.json`
- Evidence bundle:
  `reports/corpus/gap-directed-ts-js-40-2026-07-25-production-scope-bundle`
- Expansion plan:
  `reports/corpus/gap-directed-ts-js-40-2026-07-25-expansion-plan.json`
- Gap worklist:
  `reports/corpus/gap-directed-ts-js-40-2026-07-25-gap-worklist.json`
