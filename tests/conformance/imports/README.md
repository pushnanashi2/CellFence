# Import Syntax Conformance

This directory is CellFence's P0 input-space ledger for JavaScript and
TypeScript import boundary checks.

The goal is not code coverage. The goal is to make each supported import
surface explicit and executable:

- `supported-and-tested`: CellFence claims support and the test runner checks the
  expected boundary finding.
- `unsupported-but-diagnosed`: CellFence does not claim static resolution, but
  must fail closed with an unsupported syntax finding.
- `not-applicable`: Reserved for rows in a wider matrix that do not apply to an
  import boundary check.

`import-syntax-cases.json` is intentionally data driven. The runner builds a
fresh repository for each row, runs `checkRepository`, and compares normalized
semantic fields rather than snapshots:

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

Fingerprints are also checked for presence and determinism. This keeps wording
changes cheap while preserving the boundary contract.

This suite is a conformance and regression floor. It is not a precision or
recall claim over real repositories. Precision still belongs to labeled OSS
corpus runs, and recall belongs to violation injection, history replay, and
independent policy oracles.
