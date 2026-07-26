# ts-js-reviewed-pilot-160-2026-07-26-round47-boundary-core-balanced-clean Review Packet

This packet is a compact, git-trackable external review packet for the
reviewed TS/JS boundary-core precision study. It gives outside reviewers
the exact blind label assignments, selected finding records, manifest
copies, manifest-attestation assignments, protocols, and digests needed to
return labels or manifest attestations.

It is not a final precision claim. At export time the blocking gates remain:

- external human/org finding labels: 0/646
- external manifest attestations: 0/160
- source bundle dirty: false

The packet intentionally excludes large raw artifacts:

- `source-bundle/findings.raw.jsonl`
- `source-bundle/findings.normalized.jsonl`
- `source-bundle/logs/`

Reviewers should use the assignment's repository URL, exact commit, file
path, line, copied manifest, and finding text. Full raw logs remain local
diagnostic artifacts and are not required for returned label validation.

## Included Paths

- `blind-worklist/`: sealed blind labeling worklist and per-rater assignments.
- `manifest-attestation-worklist/`: per-subject manifest review assignment templates.
- `source-bundle/`: compact selected evidence and manifest copies from the unlabeled bundle.
- `cycle/`: next-cycle summaries, protocols, preflight output, and validation reports.
- `cycle/gap-worklist.json`: remaining evidence tasks for the clean preflight.
- `EXTERNAL_REVIEW_REQUEST.md`: reviewer prompt for human/org review or non-claim agent triage.
- `review-packet.json`: packet metadata.
- `SHA256SUMS`: digest list for the exported packet.

## Current Scope

- claim profile: `ts-js-boundary-core-v1`
- included rules: `CELLFENCE_PRIVATE_IMPORT,CELLFENCE_UNDECLARED_CONSUMER`
- selected findings: 646
- blind assignments: 1292
- manifest subjects: 160
- manifest assignments: 320
- source unlabeledBundleArtifactSetSha256: `f617b6fefa7d16620b42e9d9acdcdb04e7e7429c308ab4c028020be248180ade`
- source blindWorklistArtifactSetSha256: `7ce0562a52ec2a1c1462342298e9fd415dd67ae9eb22db7e85333c94586682cb`
- exported packet digest: run `sha256sum SHA256SUMS` from this directory.

Agent-only labels can be useful for non-claim triage, but they must remain
outside the external human/org claim lane.
