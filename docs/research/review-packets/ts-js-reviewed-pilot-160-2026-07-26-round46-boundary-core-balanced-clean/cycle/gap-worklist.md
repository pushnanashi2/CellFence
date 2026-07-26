# Precision Evidence Gap Worklist

Generated: `2026-07-26T11:53:44.588Z`

Claim ready: `false`
Tasks: 3

## Totals

- Selected findings: 650
- Missing labels: 650
- Missing external labels: 650
- Manifests lacking external attestation: 160
- Max repository contribution: 10.00%

## Rule Evidence

| Rule | Selected | Required | Deficit | Sampled candidates | Raw candidates |
| --- | ---: | ---: | ---: | ---: | ---: |
| `CELLFENCE_PRIVATE_IMPORT` | 349 | 299 | 0 | 0 | 0 |
| `CELLFENCE_UNDECLARED_CONSUMER` | 301 | 299 | 0 | 0 | 0 |

## Tasks

- 10. `external_manifest_attestation`: 160 copied manifests need external review attestations
- 20. `manual_label`: 650 selected findings need independent manual labels
- 30. `external_independent_label`: 650 selected findings need external human/organization labels

## Invariants

- This worklist does not create or infer labels.
- External human/organization labels cannot be satisfied by Codex or another agent.
- Diagnostic or infer-derived candidate manifests remain non-claim-ready until copied, reviewed, and frozen in a reviewed corpus.
- Rule-specific synthetic evidence can validate mechanism behavior, but it is not public-OSS precision evidence unless the protocol says so before inspection.
