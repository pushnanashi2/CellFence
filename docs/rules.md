# Enforced Rules

<!-- Moved from README.md to keep the repository root README concise. -->


| Rule ID | What it detects |
|---|---|
| `CELLFENCE_MANIFEST_INVALID` | Invalid manifest or baseline configuration |
| `CELLFENCE_DUPLICATE_CELL_ID` | Duplicate cell identifiers |
| `CELLFENCE_OWNERSHIP_OVERLAP` | Overlapping declared ownership paths |
| `CELLFENCE_OWNERSHIP_COVERAGE_DISABLED` | Strict ownership coverage is disabled, so source outside ownedPaths can escape checks |
| `CELLFENCE_UNOWNED_SOURCE` | Strict governance found source matched by `governance.include` that no cell owns |
| `CELLFENCE_UNOWNED_IMPORT_TARGET` | A cell imports governed source that no cell owns |
| `CELLFENCE_PUBLIC_ENTRY_OUTSIDE_OWNERSHIP` | A public entry is outside the declaring cell's owned paths |
| `CELLFENCE_ARTIFACT_OUTSIDE_OWNERSHIP` | A produced artifact lane is outside the producer's owned paths |
| `CELLFENCE_SYMLINK_TARGET_OUTSIDE_OWNERSHIP` | A governed symlink points outside its owning cell, outside the repository, or cannot be resolved |
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
| `CELLFENCE_CLAIM_INVALID` | Claim store or claim request is malformed, expired metadata is invalid, or a claim references unknown cells |
| `CELLFENCE_ACTIVE_CLAIM_CONFLICT` | Two active claim leases reserve overlapping cells, paths, symbols, resources, or artifact lanes |
| `CELLFENCE_UNCLAIMED_CHANGE` | `claim check --agent` found a changed file outside that agent's active claim |
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
| `CELLFENCE_BASELINE_SEAL_INVALID` | A baseline seal is missing or does not match when Ed25519 or HMAC baseline verification is configured |
| `CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE` | Computed CommonJS `require()` cannot be resolved statically; emitted as a fail-closed required-rule finding |
| `CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT` | Computed dynamic import cannot be resolved statically; emitted as a fail-closed required-rule finding |
| `CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX` | Python source could not be parsed by the configured Python AST inspector; emitted as a fail-closed required-rule finding |



CellFence v0.x analyzes:

- ES module imports;
- `export ... from` declarations;
- CommonJS `require(...)` calls;
- type-only imports;
- dynamic imports with a static string specifier;
- exact package-name imports declared with `packageName`;
- tsconfig `compilerOptions.paths` aliases, including aliases inherited through `extends`, that resolve to repository files;
- Python `.py` source ownership, AST-extracted `import` and `from ... import ...` module references, common package roots from `pyproject.toml`, `setup.cfg`, and static `setup.py`, and public entries described by literal `__all__` or top-level declarations;
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
- common TypeScript export declarations and named exports;
- common Python public symbols from `__all__`, top-level functions/classes/assignments, and simple re-export imports.

Computed dynamic imports, computed CommonJS `require()` calls, and Python files that the configured Python AST inspector cannot parse are reported as unsupported fail-closed findings rather than silently ignored.

NodeNext-style runtime `.js`, `.jsx`, `.mjs`, and `.cjs` relative specifiers are remapped to TypeScript source candidates such as `.ts`, `.tsx`, `.mts`, and `.cts` before boundary checks. Python imports are resolved from known source roots such as `src/`, manifest-derived package roots, and common Python packaging metadata. Relative imports that still cannot be resolved produce `CELLFENCE_UNRESOLVED_IMPORT` errors instead of being ignored.

The repository CI includes a synthetic scale benchmark for 10,000 files / 20 cells, 50,000 files / 100 cells, and 100,000 files / 300 cells. It is a regression tripwire for file discovery, ownership indexing, and low-signal source scanning; it is not a universal performance guarantee for every monorepo shape.

Static resource analysis is intentionally limited. It detects simple string-literal calls, SQL literals, selected Prisma delegate calls, selected TypeORM, Drizzle, and query-builder calls, selected BullMQ/KafkaJS calls, selected NestJS/Fastify HTTP route declarations, selected FastAPI route decorators, Django URLConf routes and model manager calls, SQLAlchemy declarative/Table/query/text calls, and Celery task declarations and literal publish calls. It does not infer arbitrary ORM metadata, runtime broker topology, framework plugin behavior, or values assembled through general dataflow.

ORMs, query builders, HTTP frameworks, and broker clients require explicit CellFence adapters. Prisma, TypeORM, Drizzle, BullMQ, KafkaJS, selected string-literal query builders, selected NestJS routes, selected Fastify routes, and selected Django, FastAPI, SQLAlchemy, and Celery Python patterns have built-in coverage; that does not imply support for Sequelize, every Knex/Kysely expression, every Drizzle expression, every NestJS/Fastify plugin, every Python framework extension, or a project-local database wrapper. Each adapter must document:

- the API shapes it recognizes;
- how model, entity, table, topic, or queue names are resolved;
- which unresolved or dynamic forms fail closed;
- which cases remain outside static inference and must be supplied as runtime evidence.

Unsupported adapters are not treated as implicitly safe. If a resource access cannot be resolved by a built-in adapter, an explicit `resourceContracts` entry, baseline evidence, runtime evidence, or a fail-closed unresolved finding is required depending on the access shape.

Repositories can disable unused built-in resource adapters so CellFence does not infer framework contracts for stacks the repository does not run:

```json
{
  "governance": {
    "resourceAdapters": {
      "prisma": "off",
      "typeorm": "off",
      "drizzle": "off",
      "bullmq": "off",
      "kafkajs": "off",
      "nestjs": "off",
      "fastify": "off",
      "django": "off",
      "fastapi": "off",
      "sqlalchemy": "off",
      "celery": "off",
      "queue": "off",
      "sql-literal": "off"
    }
  }
}
```

Supported keys are `file`, `http`, `queue`, `sql-literal`, `prisma`, `typeorm`, `drizzle`, `query-builder`, `bullmq`, `kafkajs`, `nestjs`, `fastify`, `django`, `fastapi`, `sqlalchemy`, and `celery`. Omitted adapters default to `on`.
