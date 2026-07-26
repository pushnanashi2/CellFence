# External Review Request: ts-js-reviewed-pilot-160-2026-07-26-round47-boundary-core-balanced-clean

Please review the CellFence external review packet in this directory.

Scope:

- Claim profile: ts-js-boundary-core-v1
- Included rules: CELLFENCE_PRIVATE_IMPORT,CELLFENCE_UNDECLARED_CONSUMER
- Selected findings: 646
- Blind assignments: 1292
- Manifest attestation assignments: 320
- Source bundle harness commit: 94e07d7fe24bb18f33b9dad2832bf967af07e50d
- Source bundle harness dirty: false

Finding labeling task:

1. Open only your assigned files under `blind-worklist/assignments/`.
2. Do not inspect peer labels, adjudication output, or aggregate outcomes before labeling.
3. For each assignment, inspect the embedded `finding`, the copied manifest under `source-bundle/manifests/`, and the pinned upstream repository commit named in the assignment.
4. Return one JSONL label per assignment by filling the assignment's `labelTemplate`.
5. Allowed labels are `true_positive`, `false_positive`, `needs_policy`, `needs_review`, `invalid_setup`, and `out_of_scope`.
6. If the repository, commit, manifest, or code path cannot be inspected, do not guess; use `needs_review` or `invalid_setup` with a concrete rationale.

Manifest attestation task:

1. Open your assigned files under `manifest-attestation-worklist/assignments/`.
2. Compare the copied manifest against the pinned upstream repository's package/workspace boundaries, package names, exports/entry points, and declared workspace dependencies.
3. Return an attestation only when the reviewed manifest hash matches the assignment and the reviewer is willing to attest the stated review scope.

Important claim-lane rules:

- A language model or automated agent is not an external human/org reviewer.
- Agent output is useful only for non-claim triage unless a separate protocol explicitly accepts it.
- Do not mark `raterType` as `human` or `organization` unless that is literally true.
- Do not claim the 99% precision gate is satisfied from this packet alone; the packet currently has no returned external labels or manifest attestations.
- Do not open issues or pull requests against upstream repositories from this review.
