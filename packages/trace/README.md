# @cellfence/trace

Runtime evidence hook for CellFence.

```bash
CELLFENCE_TRACE_CELL=runtime \
CELLFENCE_TRACE_OUT=resource-evidence.json \
node --import @cellfence/trace ./your-test-or-batch.js
```

The hook records selected runtime file access as `cellfence.resource-evidence.v1` JSON. Feed that file into `cellfence evidence check --evidence resource-evidence.json`.

See the main CellFence README: https://github.com/pushnanashi2/CellFence#readme
