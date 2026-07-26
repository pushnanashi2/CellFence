# TS/JS Reviewed Pilot 160 Round46 Boundary-Core

Generated: `2026-07-26`

Round46 extends the reviewed TS/JS boundary-core work queue to 160 repositories
by promoting two gap-directed monorepo candidates:

- `mufeiyu-ayu-vjade`
- `senegalha-template-monorepo-typescript`

The promoted manifests are copied and single-agent-reviewed only. They are not
external-human/org attested.

## Scope

Claim profile: `ts-js-boundary-core-v1`

Included rules:

- `CELLFENCE_PRIVATE_IMPORT`
- `CELLFENCE_UNDECLARED_CONSUMER`

Resource, loader-safety, public-surface, Python, and inferred-manifest evidence
remain separate claim profiles or studies. They do not contribute to this
boundary-core denominator.

## Clean Corpus Run

Command:

```bash
npm run research:corpus -- \
  --corpus docs/research/corpora/ts-js-reviewed-pilot-160-2026-07-26-boundary-core-candidates.json \
  --out reports/corpus/ts-js-reviewed-pilot-160-2026-07-26-boundary-core-candidates-study-clean.json \
  --workdir tmp/corpus-precision-study-ts-js-reviewed-pilot-160-clean \
  --clone-mode shallow \
  --discard-checkouts \
  --verify-evidence-graphs
```

Result:

- harness commit: `94e07d7fe24bb18f33b9dad2832bf967af07e50d`
- harness dirty: `false`
- subjects: 160
- completed: 160
- failed: 0
- timeouts: 0
- evidence graphs verified: 160
- total findings: 30,064
- `CELLFENCE_PRIVATE_IMPORT`: 24,273
- `CELLFENCE_UNDECLARED_CONSUMER`: 1,776

## Round46 Packet

Command:

```bash
npm run precision:next-cycle -- \
  --study-id ts-js-reviewed-pilot-160-2026-07-26-round46-boundary-core-balanced-clean \
  --corpus docs/research/corpora/ts-js-reviewed-pilot-160-2026-07-26-boundary-core-candidates.json \
  --report reports/corpus/ts-js-reviewed-pilot-160-2026-07-26-boundary-core-candidates-study-clean.json \
  --out-dir reports/corpus/ts-js-reviewed-pilot-160-2026-07-26-round46-boundary-core-balanced-clean \
  --raters external-human-reviewer-1,external-org-reviewer-1 \
  --rater-types human,organization \
  --claim-profile ts-js-boundary-core-v1 \
  --max-repository-contribution 0.1 \
  --external-claim \
  --force
```

Selected worklist:

- selected findings: 650
- blind assignments: 1,300
- `CELLFENCE_PRIVATE_IMPORT`: 349
- `CELLFENCE_UNDECLARED_CONSUMER`: 301
- repositories with sampled findings: 100
- repository cap: 10%
- `Gitlawb/openclaude`: 65/650 = 10.0%
- `rollup/rollup`: 20/650 = 3.1%

The `CELLFENCE_UNDECLARED_CONSUMER` sample-size gap is closed for the zero
false-positive 99% lower-bound plan: the selected count is 301, above the 299
minimum. This does not establish precision without returned labels.

Digests:

- pre-label artifact set: `19dc2132d1c1b43f2d43de95ca9c25d961cf3ab9b423e67811ef653d682c0536`
- unlabeled bundle artifact set: `4780fb960202e4751ba04357501ea1963354dd65bddd3afd6bfb797d94f4d50d`
- blind worklist artifact set: `5dc6ea44f0f5eacc6e86d56219f4efcc27befbdca040d43f4cd32853b2b5f002`

## External Worklists

Manifest attestation worklist:

- path: `reports/corpus/ts-js-reviewed-pilot-160-2026-07-26-round46-boundary-core-balanced-clean-manifest-attestation-worklist`
- artifact set: `5c95bafc35de35b26c7870b5141e19bc60b10a141f4f2a0052a90462e66a7165`
- subjects: 160
- reviewers: 2
- assignments: 320

Gap worklist:

- path: `reports/corpus/ts-js-reviewed-pilot-160-2026-07-26-round46-boundary-core-balanced-clean-gap-worklist.json`
- task count: 3
- 160 copied manifests need external review attestations
- 650 selected findings need independent manual labels
- 650 selected findings need external human/organization labels

Codex or another agent must not satisfy the external human/organization gates.

## Review Packet

The external review packet is now tracked in git:

- path: `docs/research/review-packets/r46-core`
- packet `SHA256SUMS` sha256: `8663aa5b7dba03e959058f6e2d934141a6de75c4446abf295bfd70f6389cb966`
- selected findings: 650
- blind assignments: 1,300
- manifest attestation assignments: 320
- source bundle harness dirty: `false`
- longest packet file path: 129 characters

The packet intentionally omits large raw logs and unsampled findings, but it
includes the source sealed blind worklist, a compact path-mapped worklist for
reviewers, per-assignment finding details, manifest copies,
manifest-attestation assignments, protocols, preflight output, and the gap
worklist. External reviewers can clone each subject at the pinned commit listed
in the assignment and return labels bound to the clean worklist digest.

## Claim Status

Round46 is not a 99% precision claim. The clean packet removes the prior dirty
worktree blocker. The remaining blockers are missing independent labels and
missing external human/org manifest attestations.
