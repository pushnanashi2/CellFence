# Reviewed TS/JS Precision Pilot Round 17

Round17 labels the clean 12-subject reviewed corpus, including the two subjects
added after round16 (`floating-ui` and `tanstack-table`). It increases the
sealed labeled sample from 71 to 97 findings and adds an independent subagent
review pass for the new `floating-ui` evidence. It is still not a public 99%
precision claim.

## Scope

- Date: 2026-07-24
- Labeled study ID: `ts-js-reviewed-pilot-12-2026-07-23-clean`
- Source clean bundle:
  `reports/corpus/ts-js-reviewed-pilot-12-2026-07-23-clean-bundle`
- Round17 protocol:
  `docs/research/protocols/ts-js-reviewed-pilot-12-2026-07-24-round17.claim.json`
- Blind labels:
  `docs/research/labels/ts-js-reviewed-pilot-12-2026-07-24-round17.agent-blind.labels.jsonl`
- Adjudication labels:
  `docs/research/labels/ts-js-reviewed-pilot-12-2026-07-24-round17.agent-adjudication.labels.jsonl`
- Final labels:
  `docs/research/labels/ts-js-reviewed-pilot-12-2026-07-24-round17.agent-final.labels.jsonl`
- Supplemental independent agent review:
  `docs/research/labels/ts-js-reviewed-pilot-12-2026-07-24-round17.independent-agent-review.json`
- Safety: static CellFence checks only; no dependency install, package scripts,
  upstream issues, PRs, or target repository writes.

## Sealed Label Data

```text
source clean bundle artifactSetSha256: 2332ecafa136454250fe7335a86480852de8946547832f5599b197eaa2c67b7a
pre-label artifact set SHA-256: 3bf98d3139148b198a6fd79b74e1cfbf7b38d231d3a7119e5a361223eb10d2fa
blind worklist artifactSetSha256: e670cba7e99d7efba79b20477939dff827a903968176cfa4b66af4b55c1284e9
blind labeled bundle artifactSetSha256: 270e3075ac19ec31bff36b531b6288fb6dbad41280e88a6f8fc0eda2f589ba64
adjudication worklist artifactSetSha256: 65be2c94ee343136cfa8df0dd5cbf2caa3ca8ab03fb94c86d0cc6f14c7408e34
final labeled bundle artifactSetSha256: 2fd66b15aaed26c4ff9ca3c853638c441d2197ee7c9b56d5a7ebe85b765b1853
```

Label readiness passes against the sealed blind and adjudication worklists:

```text
sampled precision-eligible findings: 97
labels: 201
fully labeled findings: 97
adjudicated findings: 7
worklist issues: 0
readiness issues: 0
true_positive: 75
needs_policy: 11
out_of_scope: 8
invalid_setup: 3
```

The new `floating-ui` findings were independently reviewed by a separate
subagent against the worklist evidence, corpus manifest, and source snapshot.
That review recommended `true_positive` for the `devtools -> extension` private
imports, `website -> react` undeclared consumers, and the `website` write to
`images.json`. This improves independence versus single-pass self-labeling, but
the raters are still declared as `agent`; this is not external human or
organization evidence.

## Claim Result

The round17 claim report is valid but insufficient:

```text
decision: insufficient_evidence
blocking precision: 75 / 86 = 87.2%
blocking one-sided 95% lower bound: 79.7%
semantic correctness: 86 / 86 = 100.0%
semantic one-sided 95% lower bound: 96.6%
repository macro precision: 90.9%
```

`needs_policy` remains a blocking precision failure and a semantic success. This
keeps the claim conservative: CellFence may have identified a real architectural
choice, but the reviewed manifest did not justify blocking it without policy
clarification.

## Balance And Sample Size

The current sample cannot support a 99% blocking precision claim. With zero
false positives, the protocol needs 299 blocking trials to put the one-sided 95%
lower bound at 99%. Round17 has 86 blocking trials and still includes 11
`needs_policy` outcomes.

The per-rule sample is also far below the 99% claim threshold:

```text
private import: 11 / 299 required
undeclared consumer: 33 / 299 required
unsupported dynamic import: 9 / 299 required
unsupported dynamic require: 25 / 299 required
undeclared resource access: 5 / 299 required
unresolved resource access: 2 / 299 required
public symbol mismatch: 1 / 299 required
unresolved import: 0 blocking trials
```

Repository balance is still weak. Four repositories exceed the 10% contribution
limit: `floating-ui` (25.8%), `jest` (24.7%), `vue` (24.7%), and `remix`
(12.4%). The next reviewed corpus round should add many small and medium
repositories, not only more findings from already-heavy subjects.

## Interpretation

Round17 is a useful evidence increment:

- the two 12-corpus additions are now included in sealed labeling;
- all 97 sampled findings have two blind labels;
- all 7 disagreements have sealed adjudication labels;
- the claim preflight now gives concrete deficits for 99% precision, rule
  coverage, and repository balance.

It does not close the external-evidence gap:

- no external human or organization labeler is present;
- no external manifest-review attestations are present;
- old stable findings were rebound into the round17 sealed worklist, so this is
  a diagnostic/mechanism-validation round rather than a public claim artifact;
- a 99% public claim needs a larger balanced reviewed corpus plus non-agent
  raters or independently attested review provenance.
