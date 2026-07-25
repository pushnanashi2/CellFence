# TS/JS Reviewed Pilot 105 Round 28 Public Surface Reuse-Before Replay

Date: 2026-07-25

Round28 adds the missing history-replay mechanism needed to study
`CELLFENCE_PUBLIC_SYMBOL_MISMATCH` without pretending that fresh infer-manifest
OSS scans can supply that rule's sample deficit.

## Change

`scripts/history-replay-study.mjs` now supports:

```json
{
  "after": {
    "manifest": {
      "strategy": "reuse-before"
    }
  }
}
```

The mode is after-phase only. It copies the prepared before manifest into the
after phase control directory and runs the after checkout against that stale
contract. This lets a frozen replay ask:

> If this earlier manifest had been the accepted public contract, would
> CellFence have detected the later public-entry drift?

The report records the reuse link through:

- `after.manifest.strategy: "reuse-before"`
- `after.manifest.reusedFromPhase: "before"`
- `after.manifest.reusedFromStrategy`
- `after.manifest.sourceManifestSha256`

Those fields are also included in the canonical evidence-set hash.

## Validation

Targeted tests now cover:

- a single-commit public surface expansion where the repository's after
  manifest accepts the new symbol, but the replay reuses the before manifest and
  produces `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`;
- rejection of `reuse-before` outside the after phase;
- existing history replay behavior and checkout discard behavior.

Commands run:

```bash
node --test tests/history-replay-study.test.mjs
npm run history:replay:smoke --silent
```

Both passed.

## Claim Boundary

This is not a 99% precision claim and does not create external human/org labels.
Rows generated with an inferred before manifest remain onboarding replay only.
Rows generated with a reviewed before manifest become counterfactual candidates
that still need manual event labels and external review before claim use.

## Remaining PUBLIC_SYMBOL_MISMATCH Work

The 105-subject preflight still needs 293 additional selected
`CELLFENCE_PUBLIC_SYMBOL_MISMATCH` findings for the uniform per-rule 99% bound.

The next evidence cycle should build a pre-registered stale-manifest replay
corpus using this mode, preferably from commits that changed package public
entries or declaration barrels. Fresh infer-manifest corpus expansion should not
be counted as a solution for this rule unless it actually contributes sampled
public-symbol findings.
