# TS/JS Reviewed Pilot 105 Round 27 Gap-Directed Monorepo Search

Date: 2026-07-25

This round tested a monorepo-focused candidate pool after round26 showed that
generic dynamic-import/code-search candidates do not cover
`CELLFENCE_UNDECLARED_CONSUMER` or `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`.

It does not create labels, external manifest attestations, or a public 99%
precision claim.

## Candidate Corpus

- Corpus:
  `docs/research/corpora/gap-directed-monorepo-18-2026-07-25.json`
- Source:
  GitHub code search seeds for `pnpm-workspace.yaml`, `workspace:*`,
  `turbo.json`, and `nx.json`.
- Exclusions:
  subjects already present in the 105 reviewed corpus, the original 200-subject
  diagnostic corpus, or the round26 gap-directed corpus.
- Safety:
  static CellFence checks only; no target dependency install, package scripts,
  PRs, or issues.
- Interpretation:
  all manifests are `infer` + production scope diagnostics. They are candidate
  sourcing evidence only until copied, reviewed, frozen, labeled, and externally
  attested.

## Run Result

The 18-subject diagnostic corpus completed without clone, configuration, tool,
parse, or timeout failures.

Raw finding counts:

- `CELLFENCE_PRIVATE_IMPORT`: 1233
- `CELLFENCE_UNDECLARED_RESOURCE_ACCESS`: 378
- `CELLFENCE_UNDECLARED_CONSUMER`: 179
- `CELLFENCE_UNRESOLVED_RESOURCE_ACCESS`: 83
- `CELLFENCE_UNRESOLVED_IMPORT`: 63
- `CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE`: 34
- `CELLFENCE_OWNERSHIP_OVERLAP`: 31
- `CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT`: 9
- `CELLFENCE_UNOWNED_IMPORT_TARGET`: 7
- `CELLFENCE_SYMLINK_TARGET_OUTSIDE_OWNERSHIP`: 2

Expansion-plan sampled coverage against the current 105-subject bundle:

- `CELLFENCE_UNDECLARED_CONSUMER`: 179 candidate findings
- `CELLFENCE_UNRESOLVED_IMPORT`: 63 candidate findings
- `CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE`: 34 candidate findings
- `CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT`: 9 candidate findings
- `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`: 0 candidate findings

The selected residual from this plan would reduce
`CELLFENCE_UNDECLARED_CONSUMER` from a 158 finding deficit to 0.

## Combined Round26 + Round27 Gap

Using both diagnostic expansion plans, the known sampled deficits would become:

- `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`: 293 remaining
- `CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT`: 244 remaining
- `CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE`: 106 remaining
- `CELLFENCE_UNRESOLVED_IMPORT`: 87 remaining
- `CELLFENCE_UNDECLARED_CONSUMER`: 0 remaining

The combined plans also provide enough diagnostic sampled findings to address
the current repository-balance dilution target, but only after promotion,
manifest review, corpus freeze, and rerun. They still do not provide claim-ready
labels or external attestations.

## Decision

The monorepo seed is worth promoting into a reviewed-corpus work queue after
manifest copy review. It should not be used as public precision evidence in its
current infer-derived form.

`CELLFENCE_PUBLIC_SYMBOL_MISMATCH` remains the hard blocker for a uniform
per-rule 99% precision claim. Fresh infer-manifest OSS candidates are expected
to contribute little or nothing to that rule because init and check use the same
public-symbol extractor against the same pinned commit. The next cycle needs a
pre-registered public-symbol holdout, stale-manifest replay, or
mutation/conformance source with a protocol that clearly separates mechanism
validation from public-OSS precision.

## Diagnostic Artifacts

- Corpus run:
  `reports/corpus/gap-directed-monorepo-18-2026-07-25.production-scope.json`
- Evidence bundle:
  `reports/corpus/gap-directed-monorepo-18-2026-07-25-production-scope-bundle`
- Expansion plan:
  `reports/corpus/gap-directed-monorepo-18-2026-07-25-expansion-plan.json`
- Combined gap worklist:
  `reports/corpus/gap-directed-combined-58-2026-07-25-gap-worklist.json`
