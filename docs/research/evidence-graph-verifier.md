# Evidence Graph Verifier

The evidence graph verifier is a small independent check for CellFence evidence
graph artifacts. It validates graph shape, canonical ordering, node and edge
references, finding witness records, and file anchors. It also performs a
conservative policy-witness check for a limited set of supported rules.

This is not a full formal policy-conformance proof. It does not re-run every
boundary rule or prove corpus precision. For supported rules, it independently
checks that the graph contains the required observation family and witness facts
needed to make the finding auditable. Unsupported rules are reported as
unsupported rather than silently treated as verified.

## Running

Verify a graph file:

```bash
npm run evidence:graph:verify -- --graph reports/example/evidence-graph.json
```

Generate a graph from the CLI and then verify it with the standalone verifier:

```bash
cellfence check --json --evidence-graph reports/example/evidence-graph.json
npm run evidence:graph:verify -- --graph reports/example/evidence-graph.json
```

`cellfence baseline check` supports the same `--evidence-graph` artifact. The
changed-file mode does not, because the verifier input must represent a full
repository observation envelope rather than a partial diff filter.

Verify a `cellfence check` JSON wrapper that contains `evidenceGraph`:

```bash
npm run evidence:graph:verify -- --check-result reports/example/check.json
```

Run the local smoke against the built-in private-import fixture:

```bash
npm run evidence:graph:smoke
```

The smoke enables `includeEvidenceGraph` through the engine API, writes the graph
to `tmp/evidence-graph-smoke`, and verifies it with
`scripts/evidence-graph-verify.mjs`.

## What It Rejects

- unknown schema versions or invalid snapshot digests;
- duplicate node IDs, duplicate subject-file paths, and duplicate edges;
- dangling edges;
- edge kinds that connect the wrong node kinds;
- observations, defects, or findings whose file anchors are absent from the
  subject-file nodes;
- finding nodes without matching `findingWitnesses`;
- witness file subjects that do not point at a subject file;
- non-canonical node, edge, or witness ordering.
- supported policy witnesses that lack required facts, for example a
  `CELLFENCE_PRIVATE_IMPORT` witness without a `targetPath` detail subject;
- supported policy witnesses without the processed observation family needed by
  the rule, for example an import finding without a processed `imports`
  observation.

## Supported Policy Witness Rules

The v1 policy-witness verifier supports conservative checks for:

- `CELLFENCE_PRIVATE_IMPORT`;
- `CELLFENCE_UNDECLARED_CONSUMER`;
- `CELLFENCE_UNOWNED_IMPORT_TARGET`;
- `CELLFENCE_UNRESOLVED_IMPORT`;
- `CELLFENCE_UNDECLARED_RESOURCE_ACCESS`;
- `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`;
- `CELLFENCE_UNOWNED_SOURCE`;
- `CELLFENCE_UNDECLARED_ARTIFACT`;
- `CELLFENCE_RATCHET_CELL_SET_GROWTH`;
- `CELLFENCE_RATCHET_PUBLIC_ENTRY_CHANGE`;
- `CELLFENCE_RATCHET_OWNERSHIP_SCOPE_CHANGE`;
- `CELLFENCE_RATCHET_PUBLIC_SYMBOL_SET_CHANGE`;
- `CELLFENCE_RATCHET_DEPENDENCY_EDGE_CHANGE`;
- `CELLFENCE_RATCHET_ARTIFACT_CONTRACT_CHANGE`;
- `CELLFENCE_RATCHET_PUBLIC_SURFACE_SIGNATURE_CHANGE`;
- `CELLFENCE_RATCHET_OWNED_PATH_GROWTH`;
- `CELLFENCE_RATCHET_PUBLIC_SYMBOL_GROWTH`;
- `CELLFENCE_RATCHET_PUBLIC_SURFACE_LINE_GROWTH`;
- `CELLFENCE_RATCHET_CROSS_CELL_DEPENDENCY_GROWTH`.

The verifier output includes `policy.supportedFindings`,
`policy.verifiedFindings`, `policy.unsupportedFindings`, and
`policy.unsupportedRules`. A finding for an unsupported rule can still pass the
structural verifier, but it is not counted as independently policy verified.
Ratchet profiles require the concrete baseline delta facts that make the claim
auditable, such as `previous`/`current` metric values, `addedSymbols`,
`addedEdges`, or accepted/current cell sets; a `cellId` alone is not enough to
count a ratchet finding as policy verified.

## Claim Boundary

Passing this verifier means the evidence graph is structurally usable and that
supported finding witnesses contain the required auditable facts. It does not
mean:

- the manifest is reviewed;
- the finding is a true positive;
- unsupported rule findings are independently checked;
- the detector has high precision;
- CellFence has complete recall;
- the policy checker is formally verified end to end.

Those stronger claims still require reviewed manifests, corpus labels, history
replay or mutation evidence, and broader independent rule-level checking.
