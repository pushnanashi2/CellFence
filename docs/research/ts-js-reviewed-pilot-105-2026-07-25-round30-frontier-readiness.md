# TS/JS Reviewed Pilot 105 Round 30 Frontier Readiness Guard

Date: 2026-07-25

Round30 tightens the precision frontier report so it cannot describe raw
`precisionEligible` candidate rows as claim-ready evidence.

## Change

`scripts/precision-frontier-report.mjs` now distinguishes:

- raw precision-eligible findings;
- findings that still need external manifest attestations;
- findings that still need sealed blind labels;
- findings that still need external human or organization labels;
- findings whose next required step is claim preflight.

For history replay bundles, the frontier also checks the replay candidate
shape before reporting preflight readiness: `reuse-before`, reviewed before
manifest, `single_commit_intro`, changed-file provenance, and
`counterfactual_candidate_requires_manual_label`.

## Round30 Frontier Output

The regenerated frontier artifact is:

```text
reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round30-frontier.json
reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round30-frontier.md
```

Against the 105-subject bundle:

- included blocking findings: 20,621;
- sampled included findings: 1,386;
- raw precision-eligible included findings: 20,621;
- findings requiring claim preflight: 0;
- requirement count: `external_manifest_attestation_required: 20621`.

This is the intended result. The 105-subject corpus is still useful diagnostic
material, but it is not external-claim-ready until independent human or
organization reviewers attest each copied manifest hash and the selected
findings receive sealed independent labels.

The regenerated preflight-aware frontier also separates selected-sample gaps
from label gaps. For example:

- `CELLFENCE_PRIVATE_IMPORT`: 347 selected findings, 347 unlabeled, no
  selected-sample deficit before labeling;
- `CELLFENCE_UNDECLARED_RESOURCE_ACCESS`: 308 selected findings, 308
  unlabeled, no selected-sample deficit before labeling;
- `CELLFENCE_UNRESOLVED_RESOURCE_ACCESS`: 299 selected findings, 299
  unlabeled, no selected-sample deficit before labeling;
- `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`: 6 selected findings, 293 additional
  selected findings needed before labeling can meet the per-rule zero-failure
  requirement.

It also preserves the repository-balance blockers from the preflight input:

- `https://github.com/Gitlawb/openclaude.git`: 14.2% of selected findings,
  requiring 584 outside-repository selected findings or down-sampling to meet
  the 10% cap;
- `https://github.com/Dokploy/dokploy.git`: 12.3% of selected findings,
  requiring 314 outside-repository selected findings or down-sampling to meet
  the 10% cap.

## Claim Boundary

Round30 does not improve the numerical precision claim. It prevents the next
round from confusing candidate material with claim evidence. The public 99%
claim remains blocked on external manifest review, independent external labels,
repository contribution limits, and the `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`
sample deficit.

## Validation

Commands run:

```bash
node --test tests/precision-frontier-report.test.mjs
node scripts/precision-frontier-report.mjs --reviewed-claim-report reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round24-clean-cycle/claim-preflight.prelabel.json --candidate-bundle reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round24-clean-cycle/bundle-unlabeled --out reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round30-frontier.json --markdown reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round30-frontier.md
```

The frontier command exits `1` because the claim is not ready; that is expected
for an under-attested, unlabeled corpus.

## Next Round

Run the pre-registered public-surface stale-manifest replay corpus once it is
created, then seal it through the evidence bundle path. Agent labels remain
diagnostic only; external human or organization labels are still required for a
public claim.
