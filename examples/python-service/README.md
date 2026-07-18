# Python Service Example

This fixture shows CellFence as repository evidence governance for a Python service, not as a TypeScript-only import checker.

```bash
npx cellfence check --root examples/python-service --format markdown
```

The `api` cell may call the `domain` and `infra` cells only through their declared public entries. CellFence intentionally does not claim full dynamic-language soundness; it enforces the static repository evidence that can be made deterministic in CI.
