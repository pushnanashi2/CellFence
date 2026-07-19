# Resolution Conformance

This directory is CellFence's P0 resolver ledger for repository boundary checks.

The goal is not full Node, TypeScript, Python, or bundler resolver equivalence.
The goal is to make the resolver semantics CellFence currently claims explicit
and executable:

- relative runtime extensions such as `.js` to `.ts` and `.mjs` to `.mts`;
- root and nearest `tsconfig.json` path aliases;
- `package.json#imports` entries for `#` specifiers;
- manifest `packageName` exact imports and package subpath imports;
- Python imports through discovered source roots;
- fail-closed unresolved relative imports.

`resolution-cases.json` is data driven. The runner builds a fresh repository for
each row, runs `checkRepository`, and compares normalized semantic fields rather
than snapshots:

- `ruleId`
- `severity`
- `filePath`
- `cellId`
- `producerCellId`
- `details.specifier`
- `details.targetPath`
- `details.line`
- `details.kind`
- `details.typeOnly`

Fingerprints are also checked for presence and determinism. This suite is a
conformance and regression floor, not a precision claim over real repositories.
