# Round31 Public-Surface Rule Cycle

Round31 hardens the path for supplemental
`CELLFENCE_PUBLIC_SYMBOL_MISMATCH` evidence. It does not create public-OSS
precision evidence, external human/org labels, or a 99% claim.

## What changed

- `precision-next-cycle` accepts `--include-rules` and writes the narrowed rule
  set into the sealed worklist protocol.
- Repository-balance sampling uses the same declared rule set when
  `--max-repository-contribution` is enabled.
- Reviewed corpus validation now accepts claim-bound history replay corpora that
  use reviewed `before.manifest.strategy=copy` manifests and
  `after.manifest.strategy=reuse-before`.
- `public-surface-replay-smoke` builds local exact-commit public-surface drift
  fixtures, replays the stale reviewed manifest, seals an unlabeled bundle, and
  confirms that the next-cycle packet selects only
  `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`.

## Claim boundary

This is synthetic mechanism validation. It proves the replay, bundle, worklist,
and preflight machinery can carry public-surface stale-manifest findings without
mixing unrelated rule denominators. It must not be reported as public OSS
precision or as evidence that CellFence has achieved 99% precision.

The remaining public-claim blockers are unchanged:

- real reviewed public OSS replay/corpus subjects;
- external manifest attestations;
- two blind independent labels per selected finding;
- adjudication for disagreements;
- 299 zero-false-positive selected findings for the public-symbol rule, or a
  different pre-registered statistical threshold;
- repository balance under the declared contribution cap;
- final labeled bundle and claim preflight.

## Verification

```bash
npm run build --silent
npm run typecheck --silent
node --test tests/public-surface-replay-smoke.test.mjs
node --test tests/reviewed-corpus-validate.test.mjs tests/precision-next-cycle.test.mjs
node --test tests/corpus-evidence-bundle.test.mjs tests/precision-claim-preflight.test.mjs
npm run history:public-surface:smoke --silent
```
