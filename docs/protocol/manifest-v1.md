# Manifest Protocol v1

The CellFence manifest is JSON and starts with:

```json
{
  "schemaVersion": "cellfence.manifest.v1",
  "cells": []
}
```

## Concepts

Cell: a named unit of repository ownership.

Owned path: a glob-like path pattern that declares which files a cell may own.

Public surface: the one entry file and symbol list a consumer may depend on.

Private implementation: any cell-owned source that is not the public entry and not a declared artifact lane.

Consumer: a cell that imports another cell or reads one of its artifact lanes.

Producer: a cell that exposes a public entry or artifact lane.

Artifact lane: a versioned path contract for generated or runtime files that may be consumed across cells.

Baseline: a captured measurement of architectural surface area.

Ratchet: a check that permits reductions but rejects silent growth beyond a baseline.

Sealed source: files that require explicit human authorization before modification. In v0.x this is documented, not cryptographically enforced.

Enforcement status: one of `enforced`, `partially_enforced`, `documented`, or `planned`.

## Cell Shape

```json
{
  "id": "engine",
  "packageName": "@cellfence/engine",
  "ownedPaths": ["packages/engine/**"],
  "publicEntry": "packages/engine/src/index.ts",
  "publicSymbols": ["checkRepository"],
  "consumes": [{ "cell": "schema" }],
  "producesArtifacts": [
    {
      "id": "report-v1",
      "paths": ["artifacts/engine/report-v1/**"]
    }
  ],
  "budgets": {
    "ownedPathPatterns": 1,
    "publicSymbols": 10,
    "publicSurfaceLines": 80,
    "crossCellDependencies": 1
  }
}
```

`packageName` is optional. When present, imports of the exact package name are treated as imports of the declared public entry.

## Active Enforcement

CellFence v0.x enforces:

- manifest shape;
- duplicate cell IDs;
- overlapping owned path prefixes;
- private cross-cell imports;
- undeclared consumers;
- missing public entry files;
- declared public symbols versus actual exported symbols;
- undeclared artifact lane consumption;
- ratchet growth for owned paths, public symbols, public entry line count, and cross-cell dependencies.

## Planned or Environment-Dependent Enforcement

CellFence v0.x documents but does not fully enforce:

- protected branches;
- required checks;
- CODEOWNERS review;
- external immutable checker execution;
- sealed hash ledger;
- credential separation;
- human-only merge path;
- break-glass procedure.

Those controls require repository or organization settings outside the repository content.
