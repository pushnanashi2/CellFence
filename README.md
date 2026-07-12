# CellFence

> **AI coding agents do not need more prompts. They need enforceable architectural boundaries.**

**CellFence is a manifest-driven repository architecture governance tool for TypeScript and JavaScript codebases changed by parallel AI coding agents.** It turns architectural intent into deterministic CLI and CI checks: non-overlapping cell ownership, declared cross-cell dependencies, public entry points, declared artifact lanes, static resource contracts, and one-way ratchets that reject silent boundary growth.

Use CellFence to show agents the fence before they edit, then detect private cross-module imports, undeclared dependencies, overlapping ownership, public API drift, undeclared artifact imports, undeclared static file/database/queue/HTTP coupling, and architecture expansion before a change reaches `main`.

When CellFence is configured as a required check behind a protected branch, it acts as a **repository architecture firewall** for AI-generated and human-written code. It does not run coding agents, grant permissions, or sandbox tool calls; it verifies the repository state they leave behind.

> **Status: pre-release v0.x.** The schema, plugin API v1 types, analysis engine, CLI, conformance fixtures, ratchets, repository-local CI, npm packages, reusable GitHub Action wrapper, and CellFence self-check are implemented. External root-of-trust controls such as protected-branch rules and trusted publishing must still be configured outside this repository. See [Implementation status](docs/implementation-status.md).

## Why CellFence exists

Coding agents can edit many files, run commands, and work in parallel. That improves throughput, but it also removes a former architectural control: shared human understanding of which module owns what and which dependencies are acceptable.

Prompt files and repository instructions are useful context. They are not enforcement.

A coding agent can still:

- import another module's internal implementation because it is locally convenient;
- add a dependency that was never declared;
- expand a public API to complete one task;
- import generated artifacts through an undeclared lane;
- enlarge a module boundary without making that architectural change explicit;
- make two parallel changes that are textually mergeable but semantically coupled.

CellFence moves those decisions out of prose and into **machine-checkable repository contracts**.

## Use CellFence when

CellFence is designed for questions such as:

- How do I stop AI coding agents from importing private modules?
- How do I enforce package or module boundaries in an AI-assisted monorepo?
- How do I prevent Codex, Claude Code, Cursor, or custom coding agents from silently changing repository architecture?
- How do I declare which module owns which paths?
- How do I require cross-module dependencies to use a public API?
- How do I declare statically imported generated artifacts between batch-oriented components?
- How do I prevent public API, dependency, or ownership scope from growing without review?
- How do I show an agent which paths, imports, resources, and budgets are allowed before it starts editing?
- How do I give coding agents a deterministic completion check instead of another prompt?

CellFence is useful for monorepos, modular monoliths, batch systems, data pipelines, code generators, and repositories where multiple humans or agents work in separate worktrees or branches.

## Do not use CellFence as

CellFence is not:

- an AI agent framework or orchestrator;
- a runtime security sandbox;
- a tool-call permission system;
- a replacement for protected branches or required reviews;
- a replacement for ESLint, dependency graph tools, Nx, Turborepo, or CODEOWNERS;
- a guarantee that generated code is functionally correct;
- protection against a malicious repository administrator or compromised CI runner.

CellFence complements those controls by enforcing **repository architecture**.

## The cell model

A **cell** is a named unit of repository ownership and dependency policy.

```text
Agent or human A                      Agent or human B
       |                                     |
       v                                     v
+--------------------+               +--------------------+
| Cell: parser       |               | Cell: reporting    |
| owned paths        |               | owned paths        |
| private internals  |               | private internals  |
| public.ts          |-------------->| public.ts          |
| artifact lanes     |  declared     | artifact consumers |
+--------------------+  contract     +--------------------+
          ^
          |
          +---- private cross-cell import: rejected
```

Each cell declares:

- **owned paths** — the repository paths assigned to the cell;
- **public entry** — the only source entry other cells may import;
- **public symbols** — the exports expected from that public entry;
- **consumers** — the other cells or artifact lanes this cell depends on;
- **artifact lanes** — declared file paths produced for other cells;
- **resource contracts** — declared static file, database, queue, or HTTP resources accessed by the cell;
- **budgets or baselines** — architectural surface that may shrink but may not silently grow.

CellFence currently enforces these invariants:

1. Declared ownership paths must not overlap.
2. A cross-cell source dependency must be declared.
3. A cross-cell source import must target the producer's declared public entry.
4. An imported artifact lane must be declared by both producer and consumer.
5. The symbols in a cell manifest must match the exports in its public entry.
6. Static file, database, queue, and HTTP resource access must be declared.
7. When strict ownership is enabled, governed source must be owned by exactly one cell.
8. Public entries and produced artifact lanes must live inside the declaring cell's ownership scope.
9. Selected architecture contracts may shrink, but new cells, broader ownership, new public symbols, new dependency edges, public entry changes, artifact contract changes, and public signature changes fail against the accepted baseline.
10. Required rules declared in governance cannot be weakened through repository, cell, override, or CLI severity configuration.

## Thirty-second example

Repository:

```text
src/
  parser/
    public.ts
    internal/tokenizer.ts
  reporting/
    public.ts
cellfence.manifest.json
```

Manifest:

```json
{
  "schemaVersion": "cellfence.manifest.v1",
  "governance": {
    "requireOwnership": true,
    "include": ["src/**", "packages/**", "apps/**"],
    "exclude": ["**/*.test.ts", "generated/**"],
    "requiredRules": ["CELLFENCE_OWNERSHIP_OVERLAP", "CELLFENCE_UNOWNED_SOURCE"]
  },
  "rules": {
    "CELLFENCE_UNRESOLVED_RESOURCE_ACCESS": "warning"
  },
  "overrides": [
    {
      "files": ["**/*.test.ts"],
      "rules": {
        "CELLFENCE_UNDECLARED_RESOURCE_ACCESS": "off"
      }
    }
  ],
  "cells": [
    {
      "id": "parser",
      "ownedPaths": [
        "src/parser/**",
        "artifacts/normalized-document/v1/**"
      ],
      "publicEntry": "src/parser/public.ts",
      "publicSymbols": ["parseDocument"],
      "consumes": [],
      "producesArtifacts": [
        {
          "id": "normalized-document-v1",
          "paths": ["artifacts/normalized-document/v1/**"]
        }
      ]
    },
    {
      "id": "reporting",
      "ownedPaths": ["src/reporting/**"],
      "publicEntry": "src/reporting/public.ts",
      "publicSymbols": ["buildReport"],
      "consumes": [
        {
          "cell": "parser",
          "artifactLanes": ["normalized-document-v1"]
        }
      ],
      "producesArtifacts": []
    }
  ]
}
```

Allowed:

```ts
import { parseDocument } from "../parser/public";
```

Rejected:

```ts
import { tokenizeInternal } from "../parser/internal/tokenizer";
```

Result:

```text
CellFence check failed.
[error] CELLFENCE_PRIVATE_IMPORT src/reporting/public.ts: reporting imports private implementation from parser
```

The consumer declaration is not enough to authorize private imports. It authorizes the dependency; the producer's `publicEntry` defines the source-level contract.

## Quick start

Install the CLI in the repository you want to check:

```bash
npm install --save-dev cellfence
npx cellfence check
npx cellfence check --changed --base origin/main
npx cellfence context --cell example --json
npx cellfence context --auto-allocate --task "change the reporting cell" --json
npx cellfence graph --format mermaid
npx cellfence baseline create
npx cellfence baseline check
npx cellfence waivers list
```

`check` validates the manifest contract only. It is useful before a baseline exists. Once a repository adopts ratchets, use `baseline check` in CI so public surface, ownership, dependency, and resource inventory growth is rejected.

`check --changed` compares findings against a base Git commit or branch and reports only newly introduced findings. It requires Git metadata and a valid base ref; if Git is unavailable, it fails instead of returning a false green result.

`context` projects a single cell's fence before editing: owned paths, allowed public imports, declared or grandfathered resources, current budgets, and short agent guidance. Use `--json` for tools or `--format agents-md` for an AGENTS.md/CLAUDE.md fragment.

`context --auto-allocate` accepts a task description and returns the smallest manifest-derived editing scope CellFence can infer: selected cells, context cells, source paths to include, public entries to read, and resource selectors. It is a preflight command for agents; an empty `selectedCells` result means the task is too vague or needs a human-selected `--cell`.

`graph` emits the current coupling graph as JSON or Mermaid. It combines declared consumers, observed imports, artifact lanes, resource contracts, static resource detections, and supplied runtime evidence. Use it for review dashboards and architecture drift discussions; use `check` or `baseline check` for enforcement.

Install `@cellfence/trace` when you want tests or batches to generate runtime evidence:

```bash
npm install --save-dev @cellfence/trace
CELLFENCE_TRACE_CELL=runtime \
CELLFENCE_TRACE_OUT=resource-evidence.json \
node --import @cellfence/trace ./your-test-or-batch.js
npx cellfence evidence check --evidence resource-evidence.json
```

Create a starter manifest in a new or disposable repository:

```bash
npx cellfence init
```

`init` creates `cellfence.manifest.json` and a small example cell. For an established repository, writing the manifest manually is usually safer.

## CLI

```text
cellfence init
cellfence check [--manifest <path>] [--root <path>] [--json]
cellfence check --changed [--base <ref>] [--head <ref>] [--manifest <path>] [--root <path>] [--json]
cellfence context --cell <id> [--manifest <path>] [--baseline <path>] [--root <path>] [--json|--format agents-md]
cellfence context --auto-allocate --task <text> [--cell <id>] [--manifest <path>] [--baseline <path>] [--root <path>] [--json|--format agents-md]
cellfence graph [--manifest <path>] [--baseline <path>] [--root <path>] [--evidence <path>] [--json|--format mermaid]
cellfence baseline create [--manifest <path>] [--baseline <path>] [--root <path>]
cellfence baseline check [--manifest <path>] [--baseline <path>] [--root <path>] [--json]
cellfence baseline update [--manifest <path>] [--baseline <path>] [--root <path>]
cellfence evidence check --evidence <path> [--manifest <path>] [--baseline <path>] [--root <path>] [--json]
cellfence waivers list [--manifest <path>] [--root <path>] [--json]
cellfence waivers request --rule <rule> --file <path> --line <n> --expires <YYYY-MM-DD> --reason <text> [--approved-by <name>] [--json]
```

Exit codes are documented automation contracts for the current v0.x implementation:

| Exit code | Meaning |
|---:|---|
| `0` | Check completed with no governance violations |
| `1` | One or more rule findings, including current baseline-validation findings |
| `2` | Manifest read or manifest validation error before repository analysis |
| `3` | Internal tool error |

Use `--json` when another tool or coding agent needs structured output. JSON findings include `suggestedResolutions` when CellFence can identify safe next moves, distinguishing code changes from manifest changes, baseline updates, and human approval paths.

Temporary suppressions must be explicit and expiring:

```ts
// cellfence-ignore CELLFENCE_UNDECLARED_RESOURCE_ACCESS expires:2026-10-01 approved-by:owner reason:documented false positive while adapter support lands
```

Expired, incomplete, wildcard, or reason-free waivers fail the check with `CELLFENCE_WAIVER_INVALID`.

`waivers request` does not edit source. It creates an approval-oriented directive and markdown block so an agent can ask for a precise, expiring exception instead of inventing one inline.

## Manifest reference

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

`governance.requireOwnership` is optional. When true, every source file matched by `governance.include` and not matched by `governance.exclude` must be owned by exactly one cell. Imports to governed but unowned source fail with `CELLFENCE_UNOWNED_IMPORT_TARGET`, and unowned governed files fail with `CELLFENCE_UNOWNED_SOURCE`.

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

## Architectural ratchets

A baseline captures both compatibility metrics and normalized architectural contract sets per cell:

- owned path pattern count;
- public symbol count;
- public entry line count;
- cross-cell dependency count.
- accepted cell IDs;
- owned path set;
- public entry path;
- public symbol set;
- exported public surface signature hash;
- dependency edge set;
- artifact contract set;
- static and runtime resource access inventory.

Create the accepted baseline:

```bash
cellfence baseline create
```

Check a change against it:

```bash
cellfence baseline check
```

Reductions pass. Silent expansion or identity changes fail with rules such as:

```text
CELLFENCE_RATCHET_OWNERSHIP_SCOPE_CHANGE
CELLFENCE_RATCHET_PUBLIC_SYMBOL_SET_CHANGE
CELLFENCE_RATCHET_PUBLIC_SURFACE_SIGNATURE_CHANGE
```

Update the baseline only when the architecture expansion is intentional and reviewed:

```bash
cellfence baseline update
```

A baseline update is a governance change, not a routine way to silence a failing check. In a protected repository, review manifest and baseline changes separately from ordinary implementation changes.

If a cell has `"locked": true`, `baseline update` fails with `CELLFENCE_LOCKED_BASELINE_EXPANSION` whenever the update would increase or shift ownership scope, add public symbols, change the public entry, change public signatures, add dependency edges, add artifact contracts, increase legacy count metrics, or grandfather new resource access for that cell. A human owner must either reduce the change or explicitly review the contract expansion.

For large repositories, prefer this baseline-first workflow over hand-writing every resource contract:

1. declare cells, public entries, and ownership in the manifest;
2. run `cellfence baseline create` to snapshot existing static file, database, queue, and HTTP resource access;
3. optionally pass runtime evidence with `--evidence resource-evidence.json`;
4. run `cellfence baseline check` in CI;
5. review only new resource access deltas.

`resourceContracts` remains useful for intentional high-value contracts, but the baseline prevents a manifest maintenance treadmill where every historical table, topic, or endpoint must be manually listed before adoption.

## Artifact contracts for batch and file-based systems

Not every architecture communicates through functions or HTTP APIs. Batch systems, data pipelines, code generators, and migration tools often communicate through files.

CellFence models these flows as **artifact lanes**:

```json
{
  "id": "normalized-events-v1",
  "paths": ["src/producer/artifacts/normalized-events/v1/**"]
}
```

The producer declares the lane. The consumer declares both the producer cell and the lane ID. In v0.x, the lane path must also fall under the producer's `ownedPaths` so the engine can resolve its owning cell. Importing a statically referenced file under an undeclared lane produces `CELLFENCE_UNDECLARED_ARTIFACT`.

This makes statically imported file-based coupling visible in the same architecture contract as source-code dependencies. For selected string-literal resource access, CellFence can also snapshot current usage into the baseline and reject new static coupling during `baseline check`.

Runtime systems can provide observed resource access as `cellfence.resource-evidence.v1` JSON:

```json
{
  "schemaVersion": "cellfence.resource-evidence.v1",
  "cellId": "research",
  "accesses": [
    {
      "kind": "database",
      "access": "read",
      "selector": "mysql.research_runs",
      "detectedBy": "runtime-evidence",
      "confidence": "runtime"
    }
  ]
}
```

Check runtime evidence without treating a PR body or markdown changelog as the source of truth:

```bash
cellfence evidence check --evidence resource-evidence.json
```

`baseline create` and `baseline update` also accept `--evidence`, so static and runtime resource inventories can be stored in the same baseline.

For Node.js tests and batches, `@cellfence/trace` can generate this evidence automatically:

```bash
CELLFENCE_TRACE_CELL=research \
CELLFENCE_TRACE_OUT=resource-evidence.json \
node --import @cellfence/trace ./scripts/run-research.mjs
```

The v0.x trace hook records selected runtime file reads/writes and fetch calls. Code can also call `recordDatabaseAccess`, `recordHttpAccess`, or `recordQueueAccess` from `@cellfence/trace` for driver-level accesses that cannot be monkeypatched safely. Source-code module loading is intentionally ignored so evidence focuses on application data resources.

## AI-agent integration

CellFence is agent-agnostic. It can be used with Codex, Claude Code, Cursor, custom coding agents, CI bots, or human developers as long as the workflow can run a command before accepting a change.

Add a completion rule to `AGENTS.md` or the equivalent agent instruction file:

```md
## Architecture completion check

Before completing a code change:

1. Run `npx cellfence baseline check --json`.
2. Fix implementation violations; do not weaken CellFence checks.
3. Do not edit `cellfence.manifest.json` or `cellfence.baseline.json` merely to make the check pass.
4. When an architectural boundary must grow, explain the reason and submit the manifest or baseline change for explicit human review.
```

For the current source build, replace `npx cellfence` with:

```text
node /path/to/CellFence/packages/cli/dist/index.js
```

Why this works well for coding agents:

- the contract is repository-local and versioned;
- results are deterministic;
- JSON output is machine-readable;
- exit codes distinguish governance failures from configuration failures;
- the same command runs locally, in an agent loop, and in CI;
- the tool evaluates the resulting repository rather than trusting the agent's explanation.

## GitHub Actions and CI

After the npm package is published, a consuming repository can run CellFence as an ordinary required CI command:

```yaml
name: CellFence

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  architecture:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Enforce CellFence architecture
        run: |
          npx cellfence baseline check \
            --manifest cellfence.manifest.json \
            --baseline cellfence.baseline.json
```

The current repository runs its source-built CLI in `.github/workflows/ci.yml`. A reusable externally pinned GitHub Action remains pre-release.

For real enforcement, configure the architecture job as a required status check on a protected branch. A workflow file inside the repository is not, by itself, a root of trust.

## Enforced rules

| Rule ID | What it detects |
|---|---|
| `CELLFENCE_MANIFEST_INVALID` | Invalid manifest or baseline configuration |
| `CELLFENCE_DUPLICATE_CELL_ID` | Duplicate cell identifiers |
| `CELLFENCE_OWNERSHIP_OVERLAP` | Overlapping declared ownership paths |
| `CELLFENCE_UNOWNED_SOURCE` | Strict governance found source matched by `governance.include` that no cell owns |
| `CELLFENCE_UNOWNED_IMPORT_TARGET` | A cell imports governed source that no cell owns |
| `CELLFENCE_PUBLIC_ENTRY_OUTSIDE_OWNERSHIP` | A public entry is outside the declaring cell's owned paths |
| `CELLFENCE_ARTIFACT_OUTSIDE_OWNERSHIP` | A produced artifact lane is outside the producer's owned paths |
| `CELLFENCE_PRIVATE_IMPORT` | Cross-cell import of private implementation |
| `CELLFENCE_UNDECLARED_CONSUMER` | Cross-cell dependency missing from the consumer manifest |
| `CELLFENCE_PUBLIC_ENTRY_MISSING` | Declared public entry does not exist |
| `CELLFENCE_PUBLIC_SYMBOL_MISMATCH` | Manifest symbols do not match actual public exports |
| `CELLFENCE_UNDECLARED_ARTIFACT` | Artifact lane consumption was not declared |
| `CELLFENCE_UNDECLARED_RESOURCE_ACCESS` | Static file, database, queue, or HTTP resource access was not declared |
| `CELLFENCE_UNRESOLVED_RESOURCE_ACCESS` | Dynamic or unsafe resource access could not be resolved safely |
| `CELLFENCE_RESOURCE_EVIDENCE_INVALID` | Runtime resource evidence JSON is invalid or references an unknown cell |
| `CELLFENCE_PLUGIN_INVALID` | A programmatic plugin has an unsupported API version, throws, or emits invalid references |
| `CELLFENCE_REQUIRED_RULE_DISABLED` | A configured `governance.requiredRules` rule was weakened |
| `CELLFENCE_UNRESOLVED_IMPORT` | Static relative import could not be resolved; fails closed |
| `CELLFENCE_RATCHET_OWNED_PATH_GROWTH` | Owned path pattern count increased |
| `CELLFENCE_RATCHET_PUBLIC_SYMBOL_GROWTH` | Public symbol count increased |
| `CELLFENCE_RATCHET_PUBLIC_SURFACE_LINE_GROWTH` | Public entry line count increased |
| `CELLFENCE_RATCHET_CROSS_CELL_DEPENDENCY_GROWTH` | Cross-cell dependency count increased |
| `CELLFENCE_RATCHET_CELL_SET_GROWTH` | A cell was added outside the accepted baseline cell set |
| `CELLFENCE_RATCHET_OWNERSHIP_SCOPE_CHANGE` | An owned path shifted or broadened outside the accepted baseline scope |
| `CELLFENCE_RATCHET_PUBLIC_SYMBOL_SET_CHANGE` | A new public symbol appeared outside the accepted baseline set |
| `CELLFENCE_RATCHET_DEPENDENCY_EDGE_CHANGE` | A new dependency edge appeared outside the accepted baseline set |
| `CELLFENCE_RATCHET_PUBLIC_ENTRY_CHANGE` | A cell's public entry path changed |
| `CELLFENCE_RATCHET_ARTIFACT_CONTRACT_CHANGE` | A new artifact producer/consumer contract appeared |
| `CELLFENCE_RATCHET_PUBLIC_SURFACE_SIGNATURE_CHANGE` | Exported public signatures changed beyond formatting/comment noise |
| `CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE` | Computed CommonJS `require()` cannot be resolved statically; emitted as a warning |
| `CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT` | Computed dynamic import cannot be resolved statically; emitted as a warning |

## Supported source analysis

CellFence v0.x analyzes:

- ES module imports;
- `export ... from` declarations;
- CommonJS `require(...)` calls;
- type-only imports;
- dynamic imports with a static string specifier;
- exact package-name imports declared with `packageName`;
- tsconfig `compilerOptions.paths` aliases, including aliases inherited through `extends`, that resolve to repository files;
- selected static string resource access for file, database, queue, and HTTP patterns;
- Prisma model delegate calls when `schema.prisma` is present;
- selected TypeORM entity, repository, and query builder calls;
- selected Drizzle table declarations and `db.select().from(...)`, `db.insert(...)`, `db.update(...)`, and `db.delete(...)` calls;
- selected Kysely/Knex-style query builder table calls;
- unsafe or dynamic raw SQL calls as fail-closed unresolved resource access;
- selected BullMQ and KafkaJS topic or queue calls;
- selected NestJS controller method decorators;
- selected Fastify route object registrations;
- runtime resource evidence supplied as `cellfence.resource-evidence.v1`;
- common TypeScript export declarations and named exports.

Computed dynamic imports and computed CommonJS `require()` calls are reported as unsupported warnings rather than silently ignored.

NodeNext-style runtime `.js`, `.jsx`, `.mjs`, and `.cjs` relative specifiers are remapped to TypeScript source candidates such as `.ts`, `.tsx`, `.mts`, and `.cts` before boundary checks. Relative imports that still cannot be resolved produce `CELLFENCE_UNRESOLVED_IMPORT` errors instead of being ignored.

The repository CI includes a synthetic scale benchmark for 10,000 files / 20 cells, 50,000 files / 100 cells, and 100,000 files / 300 cells. It is a regression tripwire for file discovery, ownership indexing, and low-signal source scanning; it is not a universal performance guarantee for every monorepo shape.

Static resource analysis is intentionally limited. It detects simple string-literal calls, SQL literals, selected Prisma delegate calls, selected TypeORM, Drizzle, and query-builder calls, selected BullMQ/KafkaJS calls, and selected NestJS/Fastify HTTP route declarations. It does not infer arbitrary ORM metadata, runtime broker topology, or values assembled through general dataflow.

ORMs, query builders, HTTP frameworks, and broker clients require explicit CellFence adapters. Prisma, TypeORM, Drizzle, BullMQ, KafkaJS, selected string-literal query builders, selected NestJS routes, and selected Fastify routes have built-in coverage; that does not imply support for Sequelize, every Knex/Kysely expression, every Drizzle expression, every NestJS/Fastify plugin, or a project-local database wrapper. Each adapter must document:

- the API shapes it recognizes;
- how model, entity, table, topic, or queue names are resolved;
- which unresolved or dynamic forms fail closed;
- which cases remain outside static inference and must be supplied as runtime evidence.

Unsupported adapters are not treated as implicitly safe. If a resource access cannot be resolved by a built-in adapter, an explicit `resourceContracts` entry, baseline evidence, runtime evidence, or a fail-closed unresolved finding is required depending on the access shape.

## Plugin API v1

CellFence v0.x includes `@cellfence/plugin-api`, a small stable API for programmatic rules, resource adapters, and reporters. The default CLI still works without plugin configuration:

```bash
npx cellfence check
```

Programmatic callers can pass plugins to `checkRepository`:

```ts
import { checkRepository } from "@cellfence/engine";
import { defineAdapter, definePlugin } from "@cellfence/plugin-api";

const companyDatabase = defineAdapter({
  name: "company-database",
  detect(context) {
    const accesses = [];
    // Inspect context.sourceFile with context.helpers and return CellFenceResourceAccess records.
    return accesses;
  }
});

const result = checkRepository({
  plugins: [
    definePlugin({
      apiVersion: 1,
      name: "@company/cellfence-plugin",
      version: "1.0.0",
      capabilities: { needsAst: true },
      adapters: [companyDatabase]
    })
  ]
});
```

Plugin adapters only translate framework-specific code into common resource access records. CellFence core still performs ownership, baseline, waiver, severity, and resource-contract enforcement. Plugin rules receive a read-only repository model containing file indexes, observed imports, detected resources, metrics, baseline, and changed files.

External npm/local plugin auto-loading from manifest `plugins` is intentionally not enabled in v0.x; loading arbitrary code from config needs a separate trust decision. The manifest shape already reserves `plugins`, `rules`, `overrides`, and `governance.requiredRules` so repositories can adopt the policy model without changing the CLI contract later.

## CellFence and adjacent tools

CellFence is intentionally complementary to existing tooling.

| Tool category | Primary concern | Where CellFence differs |
|---|---|---|
| ESLint and import-rule plugins | Source-level lint rules | CellFence uses a repository manifest that combines ownership, public surfaces, artifact contracts, and ratchets |
| Dependency graph tools such as dependency-cruiser | Dependency discovery and rule checking | CellFence adds cell contracts and accepted architectural baselines |
| Nx and Turborepo | Workspace graph, task orchestration, caching, builds | CellFence does not orchestrate builds; it verifies architecture governance |
| CODEOWNERS | Reviewer routing by path | CellFence checks dependency semantics; CODEOWNERS remains useful for human approval |
| Agent sandboxes, hooks, and permission systems | What an agent may do while running | CellFence checks the repository state after or during a change |
| Unit and integration tests | Functional behavior | CellFence checks ownership and architecture contracts |

CellFence should normally be used alongside linting, type checking, tests, protected branches, and code review.

## Boundary engineering

CellFence is a reference implementation of **boundary engineering for AI-assisted software development**: moving architectural rules from prompt guidance and tribal knowledge into explicit, versioned, machine-verifiable repository contracts.

The core principle is:

> Architecture may shrink. Architecture must not silently expand.

This does not make coding agents trustworthy. It makes selected architectural violations observable and rejectable under documented trust assumptions.

## Threat model

CellFence protects against ordinary repository changes that introduce:

- accidental private cross-cell imports;
- undeclared dependencies;
- missing or drifting public surfaces;
- undeclared artifact consumption;
- architecture growth beyond an accepted baseline.

CellFence does **not** protect against:

- malicious repository administrators;
- compromised CI runners;
- administrators disabling required checks or branch protection;
- credentials that can push directly to a protected branch;
- tampering with repository-local checks before those checks execute;
- functionally incorrect code that happens to respect architecture boundaries.

Repository-local checks cannot be their own complete root of trust because the checker and its configuration are part of the repository being protected.

A stronger deployment combines CellFence with:

- protected branches;
- required status checks;
- CODEOWNERS review;
- separated automation credentials;
- immutable external checker references or a sealed ledger;
- documented break-glass procedures.

See [Threat model](docs/threat-model.md) and [Root of trust](docs/root-of-trust.md).

## Current limitations

Version 0.x is deliberately narrow:

- Node.js 20 or later;
- TypeScript and JavaScript repositories only;
- one public entry per cell;
- repository-local cells only;
- file-path artifact lanes only;
- selected static resource access and imported runtime evidence only; dynamic dataflow, arbitrary runtime broker behavior, and live database schema drift are not inferred;
- ORM, query builder, and broker-client support is adapter-scoped; unsupported libraries require a dedicated adapter or runtime evidence;
- ownership overlap detection is conservative and does not solve arbitrary glob intersection;
- public symbol analysis supports common TypeScript forms, not every possible re-export pattern;
- computed dynamic imports cannot be resolved statically;
- SARIF output is not implemented;
- a reusable externally pinned GitHub Action is not yet released;
- CellFence does not identify which particular agent wrote a changed file;
- CellFence does not prevent an agent from editing a path at runtime.

To enforce per-agent write permissions, combine CellFence with worktree isolation, filesystem or sandbox permissions, path-scoped task policy, and protected-branch CI.

## Self-governance

CellFence uses CellFence to check its own architecture.

```text
schema <- engine <- cli
          ^
          |
    github-action
```

Run the self-check:

```bash
npm run cellfence:self-check
```

Reverse private dependencies fail the same engine and rule set used for example repositories and conformance fixtures.

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run cellfence:self-check
npm run pack:smoke
npm run provenance:scan
npm run release:verify
```

The fixture suite covers valid and invalid repositories, including ES imports, CommonJS imports, type-only imports, dynamic imports, package subpaths, artifact lanes, ownership overlap, symbol mismatch, and ratchet growth.

## Documentation

- [Manifest Protocol v1](docs/protocol/manifest-v1.md)
- [Architecture](docs/architecture.md)
- [Implementation status](docs/implementation-status.md)
- [Threat model](docs/threat-model.md)
- [Root of trust](docs/root-of-trust.md)
- [Minimal example](examples/minimal/README.md)
- [Parallel agents example](examples/parallel-agents/README.md)

## FAQ

### Is CellFence only for AI-generated code?

No. The checks are deterministic and apply equally to human-written code. Parallel coding agents make the need more visible because change throughput can exceed human architectural review capacity.

### Does CellFence stop a coding agent from editing the wrong path?

Not by itself. CellFence declares cell ownership and rejects selected architectural violations in the resulting repository. Per-agent write prevention requires an execution-layer control such as worktree isolation, sandbox permissions, or a path-scoped agent policy.

### How do I stop an AI agent from importing an internal module?

Declare the producer cell's `ownedPaths`, `publicEntry`, and `publicSymbols`; declare the consumer relationship; then run `cellfence check` or `cellfence baseline check` as a required CI job. A cross-cell import that resolves anywhere other than the declared public entry produces `CELLFENCE_PRIVATE_IMPORT`.

### Why not put these rules only in `AGENTS.md`, `CLAUDE.md`, or a system prompt?

Instruction files provide context to the model. CellFence provides a deterministic check against the repository state. Use both: instructions describe intent; CellFence verifies selected invariants.

### Is CellFence a security product?

No. It is repository architecture governance. The firewall analogy applies only when CellFence is combined with protected branches and required checks under the documented threat model.

### Can CellFence replace CODEOWNERS?

No. CODEOWNERS routes review based on changed paths. CellFence verifies architecture relationships such as private imports, declared consumers, artifact lanes, and boundary growth. They solve different parts of the governance problem.

### Can I use CellFence in a modular monolith or monorepo?

Yes. Those are primary use cases. A cell can map to a package, bounded context, subsystem, batch stage, or another repository ownership unit.

### Is the root-of-trust design fully implemented?

No. Repository-local checks are implemented. Protected branches, required reviews, credential separation, external immutable checking, and sealed ledgers depend on external configuration or remain planned. The repository does not describe those mechanisms as enforced until they are verifiable.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Do not weaken checks, rewrite expected fixture outcomes to match faulty behavior, or expand the public protocol without an explicit design reason.

Report security issues according to [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
