# TS/JS Reviewed Pilot 105 Round23

Round23 expands the reviewed TS/JS precision work queue from 52 to 105 subjects
by promoting 53 diagnostic candidates from the frozen 200-repo corpus into a
single-agent-reviewed corpus. This is a corpus/readiness round, not a public
99% precision claim.

## Inputs

- Corpus: `docs/research/corpora/ts-js-reviewed-pilot-105-2026-07-25.json`
- Promotion report:
  `reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-promotion.json`
- Corpus validation:
  `reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-reviewed-corpus-validation.json`
- Corpus execution:
  `reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round22.json`
- Next-cycle summary:
  `reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round23-cycle/summary.json`
- Gap worklist:
  `reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round23-gap-worklist.json`

The promoted corpus keeps the limitation explicit: the added manifests are
single-agent reviewed and are not external human/organization attestations.
The stale selection policy from the 52-subject corpus is not carried forward.

## Corpus Run

The 105-subject corpus completed with no harness failures:

```text
completed: 105 / 105
toolErrors: 0
timeouts: 0
configurationErrors: 0
evidenceGraphsVerified: 105
evidenceGraphFailures: 0
totalFindings: 21188
```

Rule distribution:

```text
CELLFENCE_PRIVATE_IMPORT: 18958
CELLFENCE_UNDECLARED_RESOURCE_ACCESS: 826
CELLFENCE_UNSUPPORTED_TYPESCRIPT_SYNTAX: 562
CELLFENCE_UNRESOLVED_RESOURCE_ACCESS: 405
CELLFENCE_UNDECLARED_CONSUMER: 141
CELLFENCE_UNRESOLVED_IMPORT: 139
CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE: 102
CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT: 44
CELLFENCE_PUBLIC_SYMBOL_MISMATCH: 6
CELLFENCE_UNOWNED_IMPORT_TARGET: 2
CELLFENCE_SYMLINK_TARGET_OUTSIDE_OWNERSHIP: 2
CELLFENCE_UNOWNED_SOURCE: 1
```

During this round, two evidence-graph verifier failures exposed a graph
anchoring bug for finding paths outside the source snapshot. The engine now emits
digestless `subject-file` anchors for finding, witness, observation, and defect
paths that need to be named but are not canonical snapshot members. This does
not hide `UNKNOWN_OBSERVED_FILE`; the assessment defect remains visible and
anchored in the graph.

## Next-Cycle Artifacts

The round23 next-cycle build produced an unlabeled bundle and sealed blind
worklist:

```text
preLabelArtifactSetSha256:
  0b4ff89d9b4beefb11aa8a6b8e0d3af4b5e229c5d677b3be435fe954a6eef9ee
unlabeledBundleArtifactSetSha256:
  16a595edfce540df06a4bb50995970048e9437cad6a7067132f77bb9021218c5
blindWorklistArtifactSetSha256:
  082ce1b1b51670f6c41a2a4e86b3b1789e18b1773a9423c5436ec13a42923e25
selected findings: 1386
blind assignments: 2772
```

The first next-cycle run hit the old 120-second internal step timeout while
building the large blind worklist. `precision-next-cycle` now gives large
artifact steps a 30-minute timeout.

## Claim Status

Round23 remains not claim-ready. The blocker list is intentionally explicit:

- the bundle was produced from a dirty CellFence worktree and must be regenerated
  after the implementation is committed;
- 1386 selected findings have no independent labels yet;
- 1386 selected findings lack an external human/organization independent label;
- 105 copied manifests lack external review attestations;
- `Gitlawb/openclaude` contributes 14.2% of selected findings and `Dokploy`
  contributes 12.3%, above the 10% repository cap;
- five included rules still have sample deficits before a 99% one-sided 95%
  lower-bound claim is possible.

Rule deficits before labeling:

```text
CELLFENCE_PUBLIC_SYMBOL_MISMATCH: needs 293 more selected zero-FP findings
CELLFENCE_UNDECLARED_CONSUMER: needs 158 more selected zero-FP findings
CELLFENCE_UNRESOLVED_IMPORT: needs 160 more selected zero-FP findings
CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT: needs 255 more selected zero-FP findings
CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE: needs 197 more selected zero-FP findings
```

The known 200-repo expansion plan only partially helps those deficits. Public
symbol mismatch has no known candidate coverage in that plan, so it needs either
a preregistered rule-specific reviewed holdout or a separately declared
mechanism-validation source.

## Invariants

- This round does not create or infer labels.
- External human/organization labels cannot be satisfied by Codex or another
  agent.
- Diagnostic or infer-derived candidate manifests remain non-claim-ready until
  copied, reviewed, and frozen in a reviewed corpus.
- Rule-specific synthetic evidence can validate mechanism behavior, but it is
  not public-OSS precision evidence unless the protocol says so before
  inspection.
