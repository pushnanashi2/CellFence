# @cellfence/trace

Runtime evidence hook for CellFence.

```bash
CELLFENCE_TRACE_CELL=runtime \
CELLFENCE_TRACE_OUT=resource-evidence.json \
node --import @cellfence/trace ./your-test-or-batch.js
```

The hook records selected runtime file access and `globalThis.fetch` HTTP(S) calls as `cellfence.resource-evidence.v2` JSON; it does not patch `node:http` or `node:https`. Plain `import "@cellfence/trace"` does not monkey-patch the process; call `installTrace()`, use `node --import @cellfence/trace`, or use `node --import @cellfence/trace/auto` when automatic tracing is intended. Code can also call `recordDatabaseAccess`, `recordHttpAccess`, or `recordQueueAccess` for driver-level accesses that CellFence cannot safely monkeypatch. Feed the evidence file into `cellfence evidence check --evidence resource-evidence.json`.

See the main CellFence README: https://github.com/pushnanashi2/CellFence#readme
