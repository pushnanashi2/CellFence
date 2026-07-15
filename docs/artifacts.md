# Artifact Contracts

<!-- Moved from README.md to keep the repository root README concise. -->


Not every architecture communicates through functions or HTTP APIs. Batch systems, data pipelines, code generators, and migration tools often communicate through files.

CellFence models these flows as **artifact lanes**:

```json
{
  "id": "normalized-events-v1",
  "paths": ["src/producer/artifacts/normalized-events/v1/**"]
}
```

The producer declares the lane. The consumer declares both the producer cell and the lane ID. In v0.x, the lane path must also fall under the producer's `ownedPaths` so the engine can resolve its owning cell. Importing a statically referenced file under an undeclared lane produces `CELLFENCE_UNDECLARED_ARTIFACT`.

This makes statically imported file-based coupling visible in the same architecture contract as source-code dependencies. For selected string-literal resource access, CellFence can also snapshot current usage into the baseline and reject new static coupling during `baseline check`.

Runtime systems can provide observed resource access as `cellfence.resource-evidence.v1` JSON:

```json
{
  "schemaVersion": "cellfence.resource-evidence.v1",
  "cellId": "research",
  "accesses": [
    {
      "kind": "database",
      "access": "read",
      "selector": "mysql.research_runs",
      "detectedBy": "runtime-evidence",
      "confidence": "runtime"
    }
  ]
}
```

Check runtime evidence without treating a PR body or markdown changelog as the source of truth:

```bash
cellfence evidence check --evidence resource-evidence.json
```

`baseline create` and `baseline update` also accept `--evidence`, so static and runtime resource inventories can be stored in the same baseline.

For Node.js tests and batches, `@cellfence/trace` can generate this evidence automatically:

```bash
CELLFENCE_TRACE_CELL=research \
CELLFENCE_TRACE_OUT=resource-evidence.json \
node --import @cellfence/trace ./scripts/run-research.mjs
```

The v0.x trace hook records selected runtime file reads/writes and fetch calls. Code can also call `recordDatabaseAccess`, `recordHttpAccess`, or `recordQueueAccess` from `@cellfence/trace` for driver-level accesses that cannot be monkeypatched safely. Source-code module loading is intentionally ignored so evidence focuses on application data resources.
