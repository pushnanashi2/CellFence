# Round33 Valid Frontier

Round33 reran the 105-subject TS/JS reviewed work queue and turned the next
99% precision attempt into a valid-but-not-ready preflight artifact. It does
not claim 99% precision and does not add external human/organization labels.

## What Ran

```bash
npm run research:corpus -- \
  --corpus docs/research/corpora/ts-js-reviewed-pilot-105-2026-07-25.json \
  --workdir tmp/corpus-precision-study/ts-js-reviewed-pilot-105-2026-07-25-round33 \
  --out reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33-study.json \
  --clone-mode shallow \
  --discard-checkouts \
  --infer-scope production \
  --verify-evidence-graphs

node scripts/corpus-evidence-bundle.mjs \
  --study-id ts-js-reviewed-pilot-105-2026-07-25-round33 \
  --corpus docs/research/corpora/ts-js-reviewed-pilot-105-2026-07-25.json \
  --report reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33-study.json \
  --out-dir reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33-bundle \
  --max-repository-contribution 0.1 \
  --balance-rules CELLFENCE_PRIVATE_IMPORT,CELLFENCE_UNDECLARED_CONSUMER,CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT,CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE,CELLFENCE_UNRESOLVED_IMPORT,CELLFENCE_UNDECLARED_RESOURCE_ACCESS,CELLFENCE_UNRESOLVED_RESOURCE_ACCESS,CELLFENCE_PUBLIC_SYMBOL_MISMATCH

node scripts/precision-label-worklist.mjs \
  --bundle reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33-bundle \
  --out-dir reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33-external-worklist \
  --protocol reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33.claim.json \
  --raters external-human-reviewer-1,external-org-reviewer-1 \
  --rater-types human,organization

node scripts/precision-bind-worklists.mjs \
  --protocol reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33.claim.json \
  --worklist reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33-external-worklist \
  --in-place

node scripts/precision-claim-preflight.mjs \
  --bundle reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33-bundle \
  --protocol reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33.claim.json \
  --worklist reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33-external-worklist \
  --out reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33-preflight.json

node scripts/precision-frontier-report.mjs \
  --reviewed-claim-report reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33-preflight.json \
  --candidate-bundle reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33-bundle \
  --include-rules CELLFENCE_PRIVATE_IMPORT,CELLFENCE_UNDECLARED_CONSUMER,CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT,CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE,CELLFENCE_UNRESOLVED_IMPORT,CELLFENCE_UNDECLARED_RESOURCE_ACCESS,CELLFENCE_UNRESOLVED_RESOURCE_ACCESS,CELLFENCE_PUBLIC_SYMBOL_MISMATCH \
  --out reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33-frontier.json \
  --markdown reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33-frontier.md
```

## Results

- Corpus run: 105/105 completed, 0 failed, 105 evidence graphs verified.
- Raw findings: 21,188 total; 20,621 included by the eight-rule blocking
  protocol.
- Sealed bundle: 1,564 sampled findings.
- External worklist: 1,260 selected findings, 2,520 blind assignments.
- Preflight: `valid=true`, `claimReady=false`, `issues=0`,
  `gateFailures=375`.
- Repository balance: no selected repository exceeds the 10% contribution cap.

## 99% Claim Gaps

At 99% minimum precision with a one-sided 95% lower bound, each included rule
needs 299 zero-false-positive labeled trials.

| Rule | Selected | Need More Selected | Need Labels |
| --- | ---: | ---: | ---: |
| `CELLFENCE_PRIVATE_IMPORT` | 299 | 0 | 299 |
| `CELLFENCE_UNDECLARED_CONSUMER` | 141 | 158 | 141 |
| `CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT` | 44 | 255 | 44 |
| `CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE` | 100 | 199 | 100 |
| `CELLFENCE_UNRESOLVED_IMPORT` | 119 | 180 | 119 |
| `CELLFENCE_UNDECLARED_RESOURCE_ACCESS` | 299 | 0 | 299 |
| `CELLFENCE_UNRESOLVED_RESOURCE_ACCESS` | 253 | 46 | 253 |
| `CELLFENCE_PUBLIC_SYMBOL_MISMATCH` | 5 | 294 | 5 |

External evidence gaps are now split by work type:

- external independent label rows still needed: 1,260;
- candidate subjects needing external manifest attestation: 97;
- candidate findings blocked on external manifest attestation: 20,621.

The candidate subject count is narrower than the claim-preflight manifest
review gate. The frontier counts only subjects that currently contribute
included candidate findings, while the preflight requires external manifest
review attestations for every subject in the 105-subject claim corpus.

## Round34 Gap Worklist Check

```bash
npm run precision:claim:gaps -- \
  --preflight reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33-preflight.json \
  --bundle reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33-bundle \
  --out tmp/round33-gap-bundle.json \
  --markdown tmp/round33-gap-bundle.md
```

After the gap-worklist repair, this reports:

- task count: 9;
- external manifest attestation subjects: 105;
- manual label worklist:
  `reports/corpus/ts-js-reviewed-pilot-105-2026-07-25-round33-external-worklist`
  when rendered relative to the repository root;
- manifest attestation rows include repository, exact commit, manifest copy
  path, manifest copy SHA256, and an external review attestation template.

## Round35 Manifest Attestation Return Gate

`precision:manifest-attestations:validate` validates returned external
manifest-review attestations before they can be merged into a reviewed corpus.
The validator rejects agent/Codex-style reviewer identities, requires
human/organization reviewer types, requires every 105-subject corpus row to be
covered, and verifies that `review.reviewedManifestSha256` matches the sealed
manifest copy hash in the evidence bundle.

This closes the mechanical return path for manifest review attestations. It
does not add external human/organization labels and does not make the Round33
claim preflight pass by itself.

## Round36 Manifest Attestation Worklist

`precision:manifest-attestations:worklist` now creates sealed per-subject
manifest-review assignment packages from the evidence bundle. Each assignment
contains the repository, exact commit, sealed manifest copy path and SHA-256,
and an empty attestation template for one declared human/organization reviewer.

This improves the external handoff path, but it still does not create external
review evidence or change the current precision numbers.

## Tooling Change

`precision-claim-preflight` now treats missing external manifest review fields
as claim-readiness gate failures, while malformed or non-binding supplied
attestations remain invalid input. This keeps a clean distinction between
"evidence not collected yet" and "evidence artifact is broken".

`precision-bind-worklists` writes sealed worklist `artifactSetSha256` values
back into a claim protocol after worklist generation. This avoids manual JSON
edits in the protocol/worklist binding step.
