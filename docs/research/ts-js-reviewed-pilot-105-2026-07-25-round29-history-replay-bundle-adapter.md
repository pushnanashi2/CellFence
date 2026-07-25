# TS/JS Reviewed Pilot 105 Round 29 History Replay Bundle Adapter

Date: 2026-07-25

Round29 connects the Round28 `reuse-before` history replay mechanism to the
sealed precision evidence pipeline.

## Change

`scripts/corpus-evidence-bundle.mjs` now accepts:

- `cellfence.history-replay.v1` corpus files;
- `cellfence.history-replay-study.v1` reports.

For history replay reports it imports only introduced after-phase findings,
matches each row back to the copied after audit log event index, and preserves
replay provenance on the normalized finding. The bundle copies before/after
manifests and phase logs with phase metadata instead of treating replay output
as a normal one-commit corpus scan.

`scripts/precision-claim-preflight.mjs` and
`scripts/corpus-precision-claim.mjs` now recognize a narrow claim-eligible
history replay shape:

- `before.manifest.strategy: "copy"`;
- `before.manifest.reviewStatus: "reviewed"`;
- external review attestation fields are present and hash-bound to the sealed
  before manifest copy when the protocol requires external manifest review;
- `after.manifest.strategy: "reuse-before"`;
- the normalized finding is a single-commit counterfactual candidate on a
  changed file.

## Claim Boundary

This still is not a 99% precision claim. The adapter only removes a pipeline
blocker for `CELLFENCE_PUBLIC_SYMBOL_MISMATCH` evidence. Public claim use still
needs a pre-registered replay corpus, external manifest attestations, sealed
blind first/second labels, adjudication for disagreements, repository balance,
and enough selected zero-false-positive findings for the requested bound.

## Validation

Commands run:

```bash
node --test tests/corpus-evidence-bundle.test.mjs
node --test tests/precision-claim-preflight.test.mjs
node --test tests/corpus-precision-claim.test.mjs
```

All passed.

## Next Round

Build a small pre-registered public-surface stale-manifest replay corpus and run:

```bash
npm run research:history -- \
  --corpus docs/research/corpora/ts-js-public-symbol-replay-2026-07-25.json \
  --out reports/corpus/ts-js-public-symbol-replay-2026-07-25-round30.json \
  --workdir tmp/ts-js-public-symbol-replay-2026-07-25-round30 \
  --clone-mode full
```

Then seal it with `corpus-evidence-bundle`, generate blind worklists, run claim
preflight, and update the gap worklist. Agent-generated labels remain diagnostic
only.
