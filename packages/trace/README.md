# @cellfence/trace

Runtime evidence hook for CellFence.

```bash
CELLFENCE_TRACE_CELL=runtime \
CELLFENCE_TRACE_OUT=resource-evidence.json \
node --import @cellfence/trace ./your-test-or-batch.js
```

The hook records selected runtime file access and fetch calls as `cellfence.resource-evidence.v1` JSON. Code can also call `recordDatabaseAccess`, `recordHttpAccess`, or `recordQueueAccess` for driver-level accesses that CellFence cannot safely monkeypatch. Feed the evidence file into `cellfence evidence check --evidence resource-evidence.json`.

See the main CellFence README: https://github.com/pushnanashi2/CellFence#readme
