# TS/JS Reviewed Pilot 160 Round47 Boundary-Core

Generated: `2026-07-26`

Round47 regenerates the Round46 boundary-core packet after tightening the
production-scope sampling filters. It supersedes Round46 for new external
review handoff, but it does not overwrite or invalidate the sealed Round46
packet. Round46 remains limited-use triage evidence.

## Scope

Claim profile: `ts-js-boundary-core-v1`

Included rules:

- `CELLFENCE_PRIVATE_IMPORT`
- `CELLFENCE_UNDECLARED_CONSUMER`

Resource, loader-safety, public-surface, Python, and inferred-manifest evidence
remain separate claim profiles or studies.

## Source Corpus

Round47 reuses the clean 160-subject corpus run from Round46:

- corpus: `docs/research/corpora/ts-js-reviewed-pilot-160-2026-07-26-boundary-core-candidates.json`
- report: `reports/corpus/ts-js-reviewed-pilot-160-2026-07-26-boundary-core-candidates-study-clean.json`
- harness commit: `94e07d7fe24bb18f33b9dad2832bf967af07e50d`
- harness dirty: `false`
- subjects: 160
- completed: 160
- failed: 0
- total findings: 30,064

## Round47 Packet

Command:

```bash
npm run precision:next-cycle -- \
  --study-id ts-js-reviewed-pilot-160-2026-07-26-round47-boundary-core-balanced-clean \
  --corpus docs/research/corpora/ts-js-reviewed-pilot-160-2026-07-26-boundary-core-candidates.json \
  --report reports/corpus/ts-js-reviewed-pilot-160-2026-07-26-boundary-core-candidates-study-clean.json \
  --out-dir reports/corpus/ts-js-reviewed-pilot-160-2026-07-26-round47-boundary-core-balanced-clean \
  --raters external-human-reviewer-1,external-org-reviewer-1 \
  --rater-types human,organization \
  --claim-profile ts-js-boundary-core-v1 \
  --max-repository-contribution 0.1 \
  --external-claim \
  --force
```

Selected worklist:

- selected findings: 646
- blind assignments: 1,292
- `CELLFENCE_PRIVATE_IMPORT`: 346
- `CELLFENCE_UNDECLARED_CONSUMER`: 300
- repositories with sampled findings: 100
- repository cap: 10%
- `chakra-ui-zag`: 64/646 = 9.9%
- `Gitlawb/openclaude`: 64/646 = 9.9%

The production-scope sampling filter excludes test, fixture, and generated paths
before repository-cap balancing. In this run it excluded 192 candidates from the
sampling population and selected zero excluded findings. Repository-cap pruning
then removed 59 sampled findings from overrepresented repositories:

- `Gitlawb/openclaude`: 53
- `chakra-ui/zag`: 6

Digests:

- pre-label artifact set: `e4ec99a32a73016acf7188714a071d166bdc6bd343ef619681e9dfcf0a7f4d5c`
- unlabeled bundle artifact set: `f617b6fefa7d16620b42e9d9acdcdb04e7e7429c308ab4c028020be248180ade`
- blind worklist artifact set: `7ce0562a52ec2a1c1462342298e9fd415dd67ae9eb22db7e85333c94586682cb`

## External Worklists

Manifest attestation worklist:

- path: `reports/corpus/ts-js-reviewed-pilot-160-2026-07-26-round47-boundary-core-balanced-clean-manifest-attestation-worklist`
- artifact set: `a7a34350b3cdbccb1b8a0979631cb132b2680ae2338150443324f0ab98ea4540`
- subjects: 160
- reviewers: 2
- assignments: 320

Gap worklist:

- path: `reports/corpus/ts-js-reviewed-pilot-160-2026-07-26-round47-boundary-core-balanced-clean-gap-worklist.json`
- task count: 3
- 160 copied manifests need external review attestations
- 646 selected findings need independent manual labels
- 646 selected findings need external human/organization labels

Codex or another agent must not satisfy the external human/organization gates.

## Review Packet

The external review packet is tracked in git:

- path: `docs/research/review-packets/r47-core`
- packet `SHA256SUMS` sha256: `ecd41bfbe1126ef5a266c191d9897fa9fed36b538689aa92c84d4b2eab459e7a`
- selected findings: 646
- blind assignments: 1,292
- manifest attestation assignments: 320
- source bundle harness dirty: `false`

The packet intentionally omits large raw logs and unsampled findings. It
includes the sealed blind worklist, compact path-mapped reviewer assignments,
per-assignment finding details, manifest copies, manifest-attestation
assignments, protocols, preflight output, and the gap worklist.

## Claim Status

Round47 is not a 99% precision claim. It is a clean external review handoff
packet for the narrow boundary-core profile. The remaining blockers are missing
external human/organization labels and missing external human/organization
manifest attestations.
