# TS/JS Reviewed Pilot 105 Round 25 Gap-Directed Promotion Check

Date: 2026-07-25

This round tested whether the remaining diagnostic OSS candidate pool could
extend the 105-subject reviewed TS/JS precision corpus toward the 99% claim
gate. It did not create labels, external attestations, or a public precision
claim.

## Result

The attempted 105 -> 135 corpus expansion was rejected as claim-progress
evidence. The 30 remaining candidate subjects contributed diagnostic sampled
findings only for `CELLFENCE_PRIVATE_IMPORT`, which already exceeded the
299 zero-false-positive sample requirement in the 105-subject preflight.

The promotion tool now rejects zero-deficit-coverage candidates by default
unless they are explicitly selected by the expansion plan's repository
dilution tranche or the caller uses `--allow-zero-deficit-coverage` for a
documented exploratory corpus.

## Current Claim Blockers

- 1386 selected findings still need independent manual labels.
- 1386 selected findings still need at least one external human/organization
  independent label.
- 105 copied manifests still need external review attestations bound to
  `review.reviewedManifestSha256`.
- Repository balance still exceeds the 10% cap for `Gitlawb/openclaude` and
  `Dokploy/dokploy`.
- The remaining candidate pool has no sampled candidate findings for the
  deficient rules:
  - `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`: 293 more selected findings needed.
  - `CELLFENCE_UNDECLARED_CONSUMER`: 158 more selected findings needed.
  - `CELLFENCE_UNRESOLVED_IMPORT`: 160 more selected findings needed.
  - `CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT`: 255 more selected findings needed.
  - `CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE`: 197 more selected findings needed.

## Artifacts

- Gap-directed expansion plan:
  `reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round25-gap-directed-expansion-plan.json`
- Gap-directed worklist:
  `reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round25-gap-directed-worklist.json`

These reports are diagnostic artifacts. The source code change in this round is
the promotion guard that prevents future private-import-heavy expansions from
being mistaken for 99% claim progress.
