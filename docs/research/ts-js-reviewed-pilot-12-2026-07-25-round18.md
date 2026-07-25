# TS/JS Reviewed Precision Round18

Round18 resolves the round17 policy ambiguity, prepares an external label
worklist, and expands the next reviewed-corpus queue. It is not a public 99%
precision claim.

## Inputs

- Round17 claim report:
  `reports/corpus/ts-js-reviewed-pilot-12-2026-07-24-round17-claim-report.json`
- Clean source bundle:
  `reports/corpus/ts-js-reviewed-pilot-12-2026-07-23-clean-bundle`
- Round18 external worklist protocol:
  `docs/research/protocols/ts-js-reviewed-pilot-12-2026-07-25-round18-external.claim.json`
- Round18 policy decisions:
  `docs/research/ts-js-reviewed-pilot-12-2026-07-25-round18-policy-decisions.json`
- Round18 expanded corpus queue:
  `docs/research/corpora/ts-js-reviewed-pilot-52-2026-07-25.json`

## Needs-Policy Resolution

The 11 round17 `needs_policy` findings are resolved as `manifest_policy`, not
as detector suppressions and not as `out_of_scope`.

The rule is:

- type-only cross-cell imports are source-level consumer edges;
- build-time-erased imports are build-time dependency edges;
- runtime codegen and fake require maps need an explicit dynamic-loader waiver;
- workspace metadata file reads are file-resource accesses;
- database catalog introspection and dynamic SQL are database-resource accesses.

Round17 sealed labels are unchanged. Under a future pre-registered policy that
requires these edge classes to be declared or waived, an undeclared instance is
a detected violation. That future projection would move the strict blocking
metric from `75 / 86` to `86 / 86`, but the one-sided 95% lower bound would
still be only `96.6%`, below the `99%` claim target.

No round17 `needs_policy` finding is excluded from the denominator by this
artifact.

## External Worklist

Generated command:

```bash
node scripts/precision-label-worklist.mjs \
  --bundle reports/corpus/ts-js-reviewed-pilot-12-2026-07-23-clean-bundle \
  --out-dir reports/corpus/ts-js-reviewed-pilot-12-2026-07-25-round18-external-worklist \
  --protocol docs/research/protocols/ts-js-reviewed-pilot-12-2026-07-24-round17.claim.json \
  --raters external-human-reviewer-1,external-org-reviewer-1 \
  --rater-types human,organization \
  --force
```

The generated worklist is ignored by git under `reports/`; regenerate it from
the command above when handing it to external labelers.

Worklist summary:

- artifactSetSha256:
  `e0759d26d8d36556b9308006d33d913ee7063a6300b36d28952e26ed6f91bf56`
- selected findings: `97`
- assignments: `194`
- rounds: `blind_first`, `blind_second`
- existing labels in source bundle: `0`

Preflight command:

```bash
node scripts/precision-claim-preflight.mjs \
  --bundle reports/corpus/ts-js-reviewed-pilot-12-2026-07-23-clean-bundle \
  --protocol docs/research/protocols/ts-js-reviewed-pilot-12-2026-07-25-round18-external.claim.json \
  --worklist reports/corpus/ts-js-reviewed-pilot-12-2026-07-25-round18-external-worklist \
  --out reports/corpus/ts-js-reviewed-pilot-12-2026-07-25-round18-external-preflight.json
```

Preflight result:

- valid: `true`
- claimReady: `false`
- worklist issues: `0`
- fully labeled findings: `0 / 97`
- external human/org coverage: `0 / 97`

The expected blockers remain external labels, per-rule sample size, and
repository balance. The worklist is ready; the labels are not present.

## Corpus Expansion

The expanded corpus queue adds 40 light/medium TS/JS public-OSS subjects to the
12-subject round17 corpus. The selection came from the fixed 200-repo
production-scope candidate bundle, excluding existing round17 repositories and
choosing subjects with 2-12 sampled included findings and no more than 200 total
included findings in the candidate bundle.

Projected balance if the next run samples similarly:

- round17 selected findings: `97`
- added candidate sampled findings: `154`
- projected selected findings: `251`
- previous max repository findings: `25`
- projected max repository contribution: `25 / 251 = 9.96%`
- target max repository contribution: `10%`

Validation:

```bash
node scripts/reviewed-corpus-validate.mjs \
  --corpus docs/research/corpora/ts-js-reviewed-pilot-52-2026-07-25.json \
  --out reports/corpus/ts-js-reviewed-pilot-52-2026-07-25-reviewed-corpus-validation.json
```

Result: `52 / 52` precision-eligible subjects, `0` issues, `0` warnings.

External-claim validation intentionally fails until independent human or
organization manifest review attestations are added:

```bash
node scripts/reviewed-corpus-validate.mjs \
  --corpus docs/research/corpora/ts-js-reviewed-pilot-52-2026-07-25.json \
  --external-claim \
  --out reports/corpus/ts-js-reviewed-pilot-52-2026-07-25-external-corpus-validation.json
```

Result: `208` issues, exactly the missing external manifest-review attestation
fields across 52 subjects.

## Claim Status

No final claim report is regenerated as a pass attempt in this round because no
external labels have been supplied. The only regenerated claim artifact is the
external-label preflight, which is valid and intentionally not claim-ready.

The remaining hard gates are:

- collect sealed non-agent labels for the 97-finding external worklist;
- add external manifest-review attestations before using the 52-subject corpus
  for a public claim;
- rerun the 52-subject corpus and freeze a new evidence bundle;
- create blind and adjudication worklists from that new bundle;
- run preflight and claim only after labels are present.
