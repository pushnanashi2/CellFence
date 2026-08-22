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
      "publicPaths": ["packages/engine/src/public/**"],
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
      "externalDependencies": {
        "claim": ["npm:decimal.js"],
        "allow": ["npm:zod"]
      },
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

`externalDependencies` is optional. `allow` permits the current cell to use a namespaced external dependency such as `npm:zod` or `python-import:pydantic`. `claim` also permits the current cell, and additionally makes the dependency exclusive to the set of cells that claim it. Multiple cells may claim the same dependency to define a closed ownership set. A dependency may not appear in both any `claim` and any `allow` entry in the manifest.

External dependency IDs are ecosystem-qualified. npm dependencies use package roots only (`npm:decimal.js`, `npm:@scope/pkg`); npm subpaths such as `npm:decimal.js/foo` are rejected. Python dependencies use import roots (`python-import:yaml`) rather than distribution names because imports and packages can differ, for example `yaml` versus `PyYAML`.

Baseline checks record the observed external dependency set per cell. Claim violations are stronger than the baseline: if another cell starts claiming `npm:decimal.js`, existing baseline use in a non-claiming cell is still reported until that import is removed or covered by an explicit, expiring waiver. For unclaimed dependencies, the baseline permits existing use, declared `allow`/`claim` permits reviewed new use, and locked cells still reject dependency-set expansion.

Manifest v1 rejects unknown object fields instead of ignoring them. A misspelled policy field such as `requireOwnershp` or `consume` is a configuration error, not a no-op. Duplicate package names, duplicate consumer edges, duplicate artifact lane IDs, duplicate resource contract IDs, and duplicate path class IDs are also rejected where they would make policy ambiguous.

`governance.requireOwnership` is optional for legacy adoption, but `cellfence init` enables it. When true, every source file matched by `governance.include` and not matched by `governance.exclude` must be owned by exactly one cell. Imports to governed but unowned source fail with `CELLFENCE_UNOWNED_IMPORT_TARGET`, and unowned governed files fail with `CELLFENCE_UNOWNED_SOURCE`. When omitted or false, CellFence emits `CELLFENCE_OWNERSHIP_COVERAGE_DISABLED` as a warning.

`locked` is optional on cells and resource contracts. A locked cell marks its architectural surface as human-review sensitive: `baseline update` refuses to expand that cell's accepted baseline. This prevents an agent from resolving a failing ratchet by simply rewriting the ratchet file.

`waiverParsing` is optional on cells. When set to `false`, CellFence keeps checking ownership and imports for the cell but ignores `// cellfence-ignore` directives inside that cell's files and emits `CELLFENCE_WAIVER_PARSING_DISABLED` as a warning. Use `waiverParsingReason` to document why a fixture or generated-test cell contains deliberately invalid waiver text.

`importAnalysis` and `resourceAnalysis` are reserved for forward compatibility. They may only be `true` when present; `false` is a manifest error rather than a way to disable governance checks.

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

`governance.requiredRules` prevents a repository, cell, path override, or CLI caller from weakening selected rules below `error`; line-local waiver comments cannot suppress those findings. `cellfence init` and inferred starter manifests include the core boundary rules plus undeclared consumer, public symbol mismatch, and undeclared resource access rules in this list by default.

Waiver comments are intentionally short-lived review artifacts. A valid directive must name one concrete `CELLFENCE_*` rule, expire within 30 days, include an approval identity in GitHub handle, email address, or `org/team` form, and explain the reason. For hard release gates, put the rule in `governance.requiredRules` instead of relying on reviewer text in source comments.

See [Manifest Protocol v1](docs/protocol/manifest-v1.md) for the current semantics and limitations.

## Path pattern dialect

CellFence path patterns are repository-relative and use this deliberately small dialect:

- `*` matches any sequence of characters within one path segment.
- A standalone `**` segment matches zero or more complete path segments. `src/**/*.ts` matches both `src/a.ts` and `src/x/a.ts`; `src/**` matches paths inside `src` but not `src` itself; and bare `**` matches any path.
- `**` embedded inside a segment behaves as `*`, so `src/**.ts` does not cross a directory boundary.
- `?`, `{}`, `}`, `[`, `]`, and extglob grouping are not pattern syntax. Those characters are literal; a supported `*` inside extglob-looking text remains an ordinary segment wildcard.
- Trailing `/` characters are removed before matching, so `src/core/` is the canonical equivalent of `src/core`.

The `*` and `**` portions of the canonical dialect (after separator normalization) are enforced against minimatch with `{ dot: true }` as the external oracle in `tests/conformance-glob-oracle.test.mjs`. Syntax that minimatch treats as additional operators (`?`, braces, character classes, and extglobs) remains literal in CellFence and is intentionally outside that oracle corpus.
