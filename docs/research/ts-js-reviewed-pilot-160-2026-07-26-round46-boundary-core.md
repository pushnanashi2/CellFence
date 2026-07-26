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

## Corpus Run

Command:

```bash
npm run research:corpus -- \
  --corpus docs/research/corpora/ts-js-reviewed-pilot-160-2026-07-26-boundary-core-candidates.json \
  --out reports/corpus/ts-js-reviewed-pilot-160-2026-07-26-boundary-core-candidates-study.json \
  --workdir tmp/corpus-precision-study-ts-js-reviewed-pilot-160 \
  --clone-mode shallow \
  --discard-checkouts \
  --infer-scope production \
  --verify-evidence-graphs
```

Result:

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
  --study-id ts-js-reviewed-pilot-160-2026-07-26-round46-boundary-core-balanced \
  --corpus docs/research/corpora/ts-js-reviewed-pilot-160-2026-07-26-boundary-core-candidates.json \
  --report reports/corpus/ts-js-reviewed-pilot-160-2026-07-26-boundary-core-candidates-study.json \
  --out-dir reports/corpus/ts-js-reviewed-pilot-160-2026-07-26-round46-boundary-core-balanced \
  --raters external-human-reviewer-1,external-org-reviewer-1 \
  --rater-types human,organization \
  --claim-profile ts-js-boundary-core-v1 \
  --max-repository-contribution 0.1 \
  --external-claim
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

- pre-label artifact set: `d248579c118dab6d4c0fbd353d4578691f664429f98176e17098cc4d98f0b93f`
- unlabeled bundle artifact set: `ed72fbc1658324cbb73349fe89e9a3ebe5d47746b3f15194610ffbc777fff192`
- blind worklist artifact set: `14305bb8c0fb0ccfe5984f5172afbaa2f78b4991a63f848b92e7bbc421af2724`

## External Worklists

Manifest attestation worklist:

- path: `reports/corpus/ts-js-reviewed-pilot-160-2026-07-26-round46-boundary-core-balanced-manifest-attestation-worklist`
- artifact set: `6694aac2392d3f2931bf6c7776a2a2a18525eefe915045e3e142a9b1219182b8`
- subjects: 160
- reviewers: 2
- assignments: 320

Gap worklist:

- path: `reports/corpus/ts-js-reviewed-pilot-160-2026-07-26-round46-boundary-core-balanced-gap-worklist.json`
- task count: 3
- 160 copied manifests need external review attestations
- 650 selected findings need independent manual labels
- 650 selected findings need external human/organization labels

Codex or another agent must not satisfy the external human/organization gates.

## Claim Status

Round46 is not a 99% precision claim. It is a claim-ready work queue except for
missing labels, missing external manifest attestations, and the pre-label packet
having been generated while the CellFence worktree was dirty. Regenerate the
round46 packet from a clean commit before publishing any public claim bundle.
