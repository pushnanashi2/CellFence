# Reviewed TS/JS Precision Pilot Round 16

Round16 replaces the legacy diagnostic label carry-forward with fresh sealed
agent-label rows, a sealed adjudication worklist, and a clean reviewed-corpus
expansion run. It is still not a public 99% precision claim.

## Scope

- Date: 2026-07-23
- Labeled study ID: `ts-js-reviewed-pilot-10-2026-07-20-round14`
- Round16 protocol:
  `docs/research/protocols/ts-js-reviewed-pilot-10-2026-07-23-round16.claim.json`
- Blind labels:
  `docs/research/labels/ts-js-reviewed-pilot-10-2026-07-23-round16.agent-blind.labels.jsonl`
- Adjudication labels:
  `docs/research/labels/ts-js-reviewed-pilot-10-2026-07-23-round16.agent-adjudication.labels.jsonl`
- Final labels:
  `docs/research/labels/ts-js-reviewed-pilot-10-2026-07-23-round16.agent-final.labels.jsonl`
- Safety: static CellFence checks only; no dependency install, package scripts,
  upstream issues, PRs, or target repository writes.

## Sealed Label Data

The old round14 labels are no longer used as claim rows. They were used only as
diagnostic judgement context while every round16 row was rebound to the sealed
assignment template for its worklist.

```text
pre-label bundle artifactSetSha256: efedbf8e7973677960d3f28438236f4b308b0e93a511c7e144f91b63a9c6e17f
pre-label artifact set SHA-256: ad717885d365c62012ccac1d0b566e06e5049396b9ef0fa904cdd1ee9c65c462
blind worklist artifactSetSha256: b757ed8db0c1cd68d3cfcd35829a1cd317d6b8305c0dda88cd6b15f1cfd17fa1
adjudication worklist artifactSetSha256: 5b4a586ea529717d44797d4f425f3f90f9d0085a4380530eafd0c9b71fe5c752
final labeled bundle artifactSetSha256: 511172396e5d1fd7a876809894cd48f416a0bd733fee82ff339f19580f262fb4
```

Label readiness passes with the sealed blind and adjudication worklists:

```text
sampled precision-eligible findings: 71
labels: 149
fully labeled findings: 71
adjudicated findings: 7
worklist issues: 0
readiness issues: 0
true_positive: 49
needs_policy: 11
out_of_scope: 8
invalid_setup: 3
```

The raters are all declared as `agent`. This is real pipeline data for the
sealed labeling/adjudication mechanism, but it is not independent human or
organization evidence.

## Claim Result

The round16 claim report is valid but insufficient:

```text
decision: insufficient_evidence
blocking precision: 49 / 60 = 81.7%
blocking one-sided 95% lower bound: 71.5%
semantic correctness: 60 / 60 = 100.0%
semantic one-sided 95% lower bound: 95.1%
repository macro precision: 88.3%
```

The result is useful because it separates semantic detector evidence from
blocking policy approval. `needs_policy` remains a blocking precision failure
and a semantic success, which keeps the external claim conservative.

## Reviewed Corpus Expansion

A separate reviewed corpus was expanded from 10 to 12 subjects:

- `floating-ui` at `12d94738472e922e1b3fa31b02b2b61b9ed77e6a`
- `tanstack-table` at `209699ff77b581d2b544d10c3d0d8b46c2398c0a`

Both were promoted from production-scope control manifests into copied reviewed
manifest inputs under:

```text
docs/research/corpora/manifests/ts-js-reviewed-pilot-12-2026-07-23/
docs/research/corpora/ts-js-reviewed-pilot-12-2026-07-23.json
```

The reviewed-corpus validator reports:

```text
subjects: 12
precisionEligibleSubjects: 12
ineligibleSubjects: 0
issues: 0
warnings: 0
corpusSha256: fe290662dccb7fb920ba833184d3b17417f1bf466faa8390b7442d4831228f4d
```

The clean 12-subject run completed with a clean harness:

```text
harnessCommit: 55806073abaf6cd240efd4958aa83932c4892c53
harnessDirty: false
completed: 12 / 12
checks clean: 3
checks with findings: 9
configuration errors: 0
tool errors: 0
timeouts: 0
evidence graphs verified: 12
evidence graph failures: 0
total findings: 97
```

Rule distribution:

```text
CELLFENCE_UNDECLARED_CONSUMER: 40
CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE: 25
CELLFENCE_PRIVATE_IMPORT: 11
CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT: 10
CELLFENCE_UNDECLARED_RESOURCE_ACCESS: 5
CELLFENCE_UNRESOLVED_IMPORT: 3
CELLFENCE_UNRESOLVED_RESOURCE_ACCESS: 2
CELLFENCE_PUBLIC_SYMBOL_MISMATCH: 1
```

Clean 12-subject bundle:

```text
artifactSetSha256: 2332ecafa136454250fe7335a86480852de8946547832f5599b197eaa2c67b7a
preLabelArtifactSetSha256: 3bf98d3139148b198a6fd79b74e1cfbf7b38d231d3a7119e5a361223eb10d2fa
```

## Interpretation

Round16 closes the immediate protocol gap: labels are now fresh rows bound to
sealed worklists, disagreements have sealed adjudication rows, and claim
preflight distinguishes `valid` from `claimReady`.

What it does not close:

- no external human or organization rater provenance;
- no external manifest-review attestations;
- still far below the sample size and repository-balance needed for a 99%
  blocking precision claim;
- the 12-subject expansion is unlabeled and should be used as the next
  worklist source, not as a completed precision result.
