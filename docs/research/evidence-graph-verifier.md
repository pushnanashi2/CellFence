# Evidence Graph Structural Verifier

The evidence graph verifier is a small independent check for CellFence evidence
graph artifacts. It validates graph shape, canonical ordering, node and edge
references, finding witness records, and file anchors.

This is not a formal policy-conformance proof. It does not re-run the boundary
rules or prove that a finding is a true positive. It makes the next layer easier
to trust by rejecting malformed evidence before a human label, corpus claim, or
future pure policy checker consumes it.

## Running

Verify a graph file:

```bash
npm run evidence:graph:verify -- --graph reports/example/evidence-graph.json
```

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

## Claim Boundary

Passing this verifier means the evidence graph is structurally usable. It does
not mean:

- the manifest is reviewed;
- the finding is a true positive;
- the detector has high precision;
- CellFence has complete recall;
- the policy checker is formally verified.

Those stronger claims still require reviewed manifests, corpus labels, history
replay or mutation evidence, and an independent rule-level checker.
