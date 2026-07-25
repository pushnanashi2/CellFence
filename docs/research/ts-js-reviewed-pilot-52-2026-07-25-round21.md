# TS/JS Reviewed Pilot 52 Round21

Round21 reran the 52-subject reviewed TS/JS diagnostic corpus from a clean
CellFence commit after the declaration-surface and nested checkout fixes.

## Corpus Run

- Corpus: `docs/research/corpora/ts-js-reviewed-pilot-52-2026-07-25.json`
- Report: `reports/corpus/ts-js-reviewed-pilot-52-2026-07-25-round21.json`
- Harness commit: `4292839bc1c71f8e965dbc1446525292693aca98`
- Dirty worktree: `false`
- Subjects: 52 total, 52 completed, 0 failed
- Timeouts: 0
- Unparseable outputs: 0
- Configuration errors: 0
- Evidence graphs verified: 52/52
- Total findings: 2731

The previous round19 failure modes were closed in this run:

- `.d.ts` public-surface declaration roots no longer trigger TypeScript
  declaration-emit debug failures.
- Nested OSS checkouts no longer inherit CellFence's repository-level
  `tsconfig.json` through the parent directory.
- The `alan2207-bulletproof-react` copied manifest no longer contains a
  duplicate package name.

## Balanced Next Cycle

The first clean next-cycle packet had 821 sampled precision-eligible findings
but failed the repository contribution cap because `lfnovo/open-notebook`
contributed 14.1% of selected findings.

Round21 then generated a cap-aware packet with
`--max-repository-contribution 0.1`, using the registered claim-rule set as the
sampling balance set:

- Packet: `reports/corpus/ts-js-reviewed-pilot-52-2026-07-25-round21-cycle-balanced`
- `preLabelArtifactSetSha256`: `98949d9d6f91fedaef61396f9e4db611533280fe7f1b34d54347af1fd8fceefb`
- `unlabeledBundleArtifactSetSha256`: `6d9c9a7c076e2d66292d7131cab74bc000fc22a1878a6feb6179f0f924f04cd2`
- `blindWorklistArtifactSetSha256`: `8a37f7d5d0109ed6f80ab65a9a81ad690a7e286ea62a4ac3d314c4eccf3905aa`
- Selected precision-eligible findings: 782
- Max repository contribution: 9.97%
- Repository-cap gate failures: 0

The cap-aware sampler removed 39 sampled findings from overrepresented
repositories: 38 `CELLFENCE_UNDECLARED_RESOURCE_ACCESS` findings from
`lfnovo/open-notebook` and 1 `CELLFENCE_PRIVATE_IMPORT` finding from
`virattt/dexter`. This fixed the repository-balance blocker without creating
labels or changing any finding outcome.

## Remaining Claim Blockers

Round21 is not a 99% precision claim. The balanced pre-label packet still
reports these blockers:

- 782 selected findings are unlabeled.
- 782 selected findings lack external human/organization independent labels.
- All 52 copied manifests lack external manifest review attestations binding
  `review.reviewedManifestSha256`.
- Rule-level evidence is still underpowered:
  - `CELLFENCE_UNDECLARED_CONSUMER`: 51/299
  - `CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT`: 18/299
  - `CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE`: 63/299
  - `CELLFENCE_UNRESOLVED_IMPORT`: 69/299
  - `CELLFENCE_UNDECLARED_RESOURCE_ACCESS`: 240/299
  - `CELLFENCE_UNRESOLVED_RESOURCE_ACCESS`: 36/299
  - `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`: 1/299

The expansion planner confirms that the existing diagnostic 200-repo candidate
bundle can help several weak rules, but not `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`:

- Plan: `reports/corpus/ts-js-reviewed-pilot-52-2026-07-25-round22-expansion-plan-balanced.json`
- Sampled candidate coverage:
  - `CELLFENCE_UNDECLARED_CONSUMER`: 20
  - `CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT`: 26
  - `CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE`: 22
  - `CELLFENCE_UNRESOLVED_IMPORT`: 33
  - `CELLFENCE_UNDECLARED_RESOURCE_ACCESS`: 42
  - `CELLFENCE_UNRESOLVED_RESOURCE_ACCESS`: 7
  - `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`: 0

The round22 gap worklist makes the remaining evidence tasks explicit:

- Worklist: `reports/corpus/ts-js-reviewed-pilot-52-2026-07-25-round22-gap-worklist.json`
- Total blocking tasks: 10
- Labels still missing: 782
- External human/organization labels still missing: 782
- External manifest review attestations still missing: 52 subjects
- Repository balance: no cap failure after balanced sampling
- Rule deficits remaining after the known diagnostic expansion plan:
  - `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`: 298
  - `CELLFENCE_UNRESOLVED_RESOURCE_ACCESS`: 256
  - `CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT`: 255
  - `CELLFENCE_UNDECLARED_CONSUMER`: 228
  - `CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE`: 214
  - `CELLFENCE_UNRESOLVED_IMPORT`: 197
  - `CELLFENCE_UNDECLARED_RESOURCE_ACCESS`: 17

Next work is therefore split:

- Promote a balanced tranche of diagnostic candidates only after manifest copy
  review, then rerun the reviewed corpus and cap-aware next-cycle packet.
- Build a separate pre-registered public-surface holdout or mutation/conformance
  source for `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`; the current OSS candidate pool
  cannot power that rule.
- Collect non-agent external labels and external manifest attestations before
  any public 99% claim.
