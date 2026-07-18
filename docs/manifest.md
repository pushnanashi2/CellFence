# Manifest Reference

<!-- Moved from README.md to keep the repository root README concise. -->


```json
{
  "schemaVersion": "cellfence.manifest.v1",
  "cells": [
    {
      "id": "engine",
      "packageName": "@example/engine",
      "locked": true,
      "ownedPaths": ["packages/engine/**"],
      "publicEntry": "packages/engine/src/index.ts",
      "publicSymbols": ["checkRepository"],
      "consumes": [
        {
          "cell": "schema",
          "artifactLanes": []
        }
      ],
      "producesArtifacts": [
        {
          "id": "analysis-report-v1",
          "paths": ["packages/engine/artifacts/analysis-report/v1/**"],
          "description": "Versioned architecture analysis output"
        }
      ],
      "resourceContracts": [
        {
          "id": "runtime-db",
          "locked": true,
          "kind": "database",
          "access": ["read", "write"],
          "selectors": ["app.users", "app.events"]
        }
      ],
      "budgets": {
        "ownedPathPatterns": 1,
        "publicSymbols": 10,
        "publicSurfaceLines": 100,
        "crossCellDependencies": 1
      }
    }
  ]
}
```

`packageName` is optional. When present, importing the exact package name is treated as importing the declared public entry. Package subpath imports into private implementation remain violations.

Manifest v1 rejects unknown object fields instead of ignoring them. A misspelled policy field such as `requireOwnershp` or `consume` is a configuration error, not a no-op. Duplicate package names, duplicate consumer edges, duplicate artifact lane IDs, duplicate resource contract IDs, and duplicate path class IDs are also rejected where they would make policy ambiguous.

`governance.requireOwnership` is optional for legacy adoption, but `cellfence init` enables it. When true, every source file matched by `governance.include` and not matched by `governance.exclude` must be owned by exactly one cell. Imports to governed but unowned source fail with `CELLFENCE_UNOWNED_IMPORT_TARGET`, and unowned governed files fail with `CELLFENCE_UNOWNED_SOURCE`. When omitted or false, CellFence emits `CELLFENCE_OWNERSHIP_COVERAGE_DISABLED` as a warning.

`locked` is optional on cells and resource contracts. A locked cell marks its architectural surface as human-review sensitive: `baseline update` refuses to expand that cell's accepted baseline. This prevents an agent from resolving a failing ratchet by simply rewriting the ratchet file.

Rule severity configuration is optional and follows a fixed precedence:

```text
CLI ruleSeverities
>
path overrides
>
cell rules
>
repository rules
>
rule default
```

`governance.requiredRules` prevents a repository, cell, path override, or CLI caller from weakening selected rules below `error`.

See [Manifest Protocol v1](docs/protocol/manifest-v1.md) for the current semantics and limitations.
