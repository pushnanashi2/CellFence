# Polyglot Monorepo Example

This fixture combines TypeScript packages and a Python service under one CellFence manifest.

```bash
npx cellfence check --root examples/polyglot-monorepo --format sarif
```

The example is deliberately small: the point is that CellFence's contract is cell ownership, public surfaces, and dependency evidence across the repository, while language-specific analyzers supply the evidence they can prove deterministically.
