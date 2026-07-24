# External Precision Labeling Frontier

This note fixes the next evidence step after round17. It is not a claim that
external review has happened.

## Current Blockers

- External labels: round17 has agent labels only. A public 99% precision claim
  requires at least one `human` or `organization` independent label per selected
  finding.
- Repository balance: `floating-ui`, `jest`, `vue`, and `remix` exceed the 10%
  repository contribution cap in the 97-finding round17 sample.
- Sample size: the current blocking sample is 75 / 86. With the current labels,
  the report needs roughly 1732 additional true-positive blocking trials to
  reach a 99% one-sided 95% lower bound.

## External Label Packet

Generate a sealed external worklist from a pre-label bundle. Do not give
reviewers `labels.jsonl`, previous labels, claim reports, or adjudication
results during blind labeling.

```bash
npm run precision:labels:worklist -- \
  --bundle reports/corpus/ts-js-reviewed-pilot-12-2026-07-23-clean-bundle \
  --out-dir reports/corpus/ts-js-reviewed-pilot-12-external-blind-worklist \
  --raters external-reviewer-a,external-reviewer-b \
  --rater-types human,human \
  --protocol docs/research/protocols/ts-js-reviewed-pilot-12-2026-07-24-round17.claim.json
```

Each returned label row must declare:

- `raterType: "human"` or `raterType: "organization"`;
- `role: "independent"`;
- `round: "blind_first"` or `round: "blind_second"`;
- `sawPeerLabels: false`;
- `sourceBundleContainsLabels: false`;
- `claimUse: "blind_labeling"`.

If the two external labels disagree, create a sealed adjudication worklist with
a third independent external adjudicator.

## Balance Expansion

The next reviewed corpus should add new repositories with small to medium
finding counts before adding more findings from already-heavy subjects. The
preflight report's `repositoryContribution.repositories[*].additionalOtherFindingsNeeded`
field is the mechanical guide for how many findings must be added outside each
over-limit repository.

For a defensible 99% claim, track all three gates together:

- per-rule zero-false-positive sample target;
- repository contribution cap;
- external independent label coverage.

An agent-only or unbalanced run can remain useful mechanism-validation evidence,
but it must report `insufficient_evidence` for a public precision claim.
