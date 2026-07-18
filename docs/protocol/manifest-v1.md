# Manifest Protocol v1

The CellFence manifest is JSON and starts with:

```json
{
  "schemaVersion": "cellfence.manifest.v1",
  "governance": {
    "requireOwnership": true,
    "include": ["src/**", "packages/**", "apps/**"],
    "exclude": ["**/*.test.ts", "generated/**"],
    "requiredRules": ["CELLFENCE_OWNERSHIP_OVERLAP"]
  },
  "plugins": [],
  "rules": {},
  "overrides": [],
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

Resource contract: a declared static coupling to a file path, database table, queue or topic, or HTTP route or endpoint.

Baseline: a captured measurement of architectural surface area.

Ratchet: a check that permits reductions but rejects silent growth beyond a baseline.

Claim lease: short-lived coordination state, stored outside the manifest by default, that reserves cells, paths, public symbols, resources, or artifact lanes for one agent before it edits.

Locked cell: a cell whose accepted baseline cannot be expanded by `baseline update`.

Governance coverage: optional manifest-level source coverage rules. When `requireOwnership` is true, every source file matched by `include` and not matched by `exclude` must be owned by exactly one cell.

Rule severity: a rule can be configured as `off`, `warning`, or `error` at repository, cell, or path-override scope. CellFence also has a built-in core required-rule set for boundary integrity. `governance.requiredRules` extends that set. Required rules are normalized to `error`, and attempts to weaken them produce `CELLFENCE_REQUIRED_RULE_DISABLED`.

Plugin reference: a reserved manifest entry for future npm or local plugin loading. In v0.x, the programmatic plugin API is implemented, but manifest-driven arbitrary-code loading is not enabled.

Sealed source: files that require explicit human authorization before modification. In v0.x this is documented, not cryptographically enforced.

Enforcement status: one of `enforced`, `partially_enforced`, `documented`, or `planned`.

## Cell Shape

```json
{
  "id": "engine",
  "packageName": "@cellfence/engine",
  "locked": true,
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
    "publicSurfaceLines": 80,
    "crossCellDependencies": 1
  },
  "rules": {
    "CELLFENCE_UNRESOLVED_RESOURCE_ACCESS": "warning"
  }
}
```

`packageName` is optional. When present, imports of the exact package name are treated as imports of the declared public entry.

`governance` is optional for compatibility. When `requireOwnership` is true, `include` must contain at least one glob-like pattern. Governed source files that are not covered by exactly one cell produce ownership findings, and imports to governed unowned targets are rejected.

`publicEntry` must be covered by the declaring cell's `ownedPaths`. Each produced artifact lane path must also be covered by the producer's `ownedPaths`.

`locked` is optional on a cell or resource contract. In v0.x, locked cells are actively enforced by `baseline update`: if a previous baseline exists, the command refuses to increase or shift owned path scope, add public symbols, change the public entry, change public signatures, add dependency edges, add artifact contracts, increase legacy count metrics, or grandfather resource access for a locked cell. `baseline check` also requires a configured baseline verifier (`CELLFENCE_BASELINE_ED25519_PUBLIC_KEY` or `CELLFENCE_BASELINE_HMAC_KEY`) when any cell is locked, so a hand-edited baseline cannot silently redefine that locked contract. Locked resource contracts are surfaced in context output and suggested resolutions so agents can distinguish self-service changes from human-review changes.

Resource contracts can be declared explicitly in the manifest. For existing large repositories, the recommended adoption path is to generate a baseline first and review only new resource deltas. A baseline stores discovered `resourceAccesses` per cell, so `baseline check` can allow known implicit coupling without requiring every table, topic, endpoint, or file path to be hand-maintained in the manifest. Runtime access can also be supplied through `cellfence.resource-evidence.v1` and included with `--evidence`.

Rule severity precedence is fixed:

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

Path overrides use CellFence's glob-like path matching. A built-in core rule or a rule listed in `governance.requiredRules` must remain `error`; attempts to set it to `warning` or `off` produce `CELLFENCE_REQUIRED_RULE_DISABLED`.

## Active Enforcement

CellFence v0.x enforces:

- manifest shape;
- duplicate cell IDs;
- overlapping owned paths using segment-aware literal prefixes plus conservative glob checks;
- strict governed-source ownership when enabled;
- governed symlinks that point outside the owning cell, outside the repository, or to broken targets;
- public entries outside declared ownership;
- artifact lanes outside declared ownership;
- private cross-cell imports;
- unresolved relative imports as errors;
- computed dynamic imports and computed `require()` calls as fail-closed required-rule findings;
- undeclared consumers;
- missing public entry files;
- declared public symbols versus actual exported symbols;
- undeclared artifact lane consumption;
- undeclared static file, database, queue, and HTTP resource access;
- undeclared runtime resource evidence;
- required rules weakened by repository, cell, override, or CLI configuration;
- programmatic plugin adapter outputs as ordinary resource access records;
- programmatic plugin rule findings as ordinary findings subject to severity policy and waivers;
- active claim lease conflicts and unclaimed agent changes through `cellfence claim create/check`;
- unresolved unsafe raw SQL, dynamic SQL, dynamic query-builder table, and dynamic Drizzle table access;
- missing or mismatched baseline seals when `CELLFENCE_BASELINE_ED25519_PUBLIC_KEY` or `CELLFENCE_BASELINE_HMAC_KEY` is configured;
- missing baseline verifier configuration when locked cells are checked;
- locked baseline expansion during `baseline update`;
- accepted baseline cell set growth;
- semantic baseline changes for ownership scope, public symbol set, dependency edge set, public entry path, artifact contracts, and public surface signatures;
- legacy ratchet growth for owned path counts, public symbol counts, public entry line counts, and cross-cell dependency counts when reading old baselines.

Machine-readable findings can include `suggestedResolutions`. These suggestions are nonbinding, but they classify the safe next moves as code changes, manifest changes, baseline updates, or human approval requests. Agents should prefer non-approval code changes when available.

Machine-readable findings also include a stable `fingerprint` when produced by the engine. The fingerprint is derived from the rule ID, severity, normalized target path, cell IDs, and rule details, not from the human-readable message. `check --changed` compares fingerprints so wording changes do not turn an existing violation into a new one.

Static resource access is deliberately partial. The engine recognizes selected string-literal patterns, selected Prisma delegate calls, selected TypeORM entity/repository/query-builder calls, selected Drizzle table declarations and table operations, selected string-literal query-builder table calls, selected BullMQ/KafkaJS calls, selected NestJS/Fastify HTTP route declarations, selected FastAPI route decorators, Django URLConf routes and model manager calls, SQLAlchemy declarative/Table/query/text calls, and Celery task declarations and literal publish calls. Dynamic paths, arbitrary ORM metadata outside supported adapters, framework plugin behavior, and runtime infrastructure state are outside v0.x static inference unless supplied as runtime evidence.

Relative import resolution supports NodeNext runtime specifiers by remapping `.js`, `.jsx`, `.mjs`, and `.cjs` specifiers to TypeScript source candidates before checking cell boundaries. It uses the TypeScript config parser, so `compilerOptions.paths` inherited through `extends` are included. Python `.py` imports are extracted with Python `ast` and resolved from known source roots such as `src/`, manifest-derived package roots, and common `pyproject.toml`, `setup.cfg`, and static `setup.py` package-root declarations. A relative import that still cannot be resolved is not silently ignored; it produces an unresolved-import error.

ORM, query builder, HTTP-framework, and broker-client support is adapter-scoped. Adding one adapter does not make adjacent libraries supported. For example, Prisma and TypeORM support does not cover Sequelize, Drizzle support does not cover every Drizzle expression, NestJS/Fastify support does not cover every plugin shape, and KafkaJS support does not cover every broker client. Each adapter must define the API forms it recognizes, how it resolves table, route, topic, or queue names, and which dynamic forms produce fail-closed unresolved findings.

Unsupported library access must not be described as covered by CellFence unless it is declared through `resourceContracts`, captured in the baseline, supplied as runtime evidence, or rejected as unresolved.

`governance.resourceAdapters` can disable built-in resource adapters that a repository does not use. Supported keys are `file`, `http`, `queue`, `sql-literal`, `prisma`, `typeorm`, `drizzle`, `query-builder`, `bullmq`, `kafkajs`, `nestjs`, `fastify`, `django`, `fastapi`, `sqlalchemy`, and `celery`; values are `on` or `off`, and omitted adapters default to `on`. Disabling an adapter prevents that detector from emitting resource access records; it does not mark unsupported framework usage as safe.

`@cellfence/trace` can generate runtime evidence for selected Node.js file reads and writes, fetch calls, and explicit database/HTTP/queue helper records via `node --import @cellfence/trace`. In v0.x it is a runtime evidence producer, not a sandbox: it observes supported operations and writes `cellfence.resource-evidence.v1` JSON for later `cellfence evidence check`.

`@cellfence/plugin-api` defines Plugin API v1 for programmatic rules, adapters, and reporters. In v0.x, callers can pass plugin objects directly to `checkRepository`. Manifest `plugins` entries are validated as shape only; the CLI does not auto-load arbitrary npm or local plugin code from the manifest.

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
