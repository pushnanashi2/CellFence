# Implementation Status

| mechanism | status | enforcement location | limitations | verification method |
|---|---|---|---|---|
| Manifest shape validation | enforced | `@cellfence/schema` and `@cellfence/engine` | JSON schema is implemented by TypeScript validators, not a standalone schema file | fixture tests and `cellfence check` |
| Duplicate cell ID detection | enforced | `@cellfence/engine` | Detects IDs inside one manifest file | invalid fixture |
| Owned path overlap detection | partially_enforced | `@cellfence/engine` | Prefix overlap is detected; full glob intersection is conservative | invalid fixture |
| Private cross-cell import rejection | enforced | `@cellfence/engine` | Static analysis only; computed dynamic imports are warnings; NodeNext runtime `.js` specifiers and root tsconfig path aliases are resolved before boundary checks | invalid fixture |
| Undeclared consumer rejection | enforced | `@cellfence/engine` | Applies to repository-local cells | invalid fixture |
| Public entry existence | enforced | `@cellfence/engine` | One public entry per cell in v0.x | invalid fixture |
| Public symbol match | enforced | `@cellfence/engine` | Export forms are limited to common TypeScript declarations and named exports | invalid fixture |
| Artifact lane declaration | enforced | `@cellfence/engine` | File path lanes only in v0.x | invalid fixture |
| Static resource contract declaration | partially_enforced | `@cellfence/engine` | Detects selected string-literal file, SQL table, queue/topic, HTTP patterns, Prisma delegates, TypeORM entities/repositories/query builders, Drizzle table operations, string-literal query builders, BullMQ, KafkaJS, NestJS routes, and Fastify routes; general dynamic dataflow is not inferred | valid and invalid resource fixtures |
| Adapter-scoped resource detection | partially_enforced | `@cellfence/engine` | ORM, query builder, HTTP-framework, and broker-client coverage is per adapter; unsupported libraries require a dedicated adapter or runtime evidence | adapter fixtures and documentation |
| Unresolved resource access fail-closed | enforced | `@cellfence/engine` | Unsafe raw SQL, selected dynamic SQL assembly, TypeORM query-builder dynamic tables, and Drizzle dynamic table arguments fail instead of becoming silent blind spots | invalid dynamic SQL and adapter fixtures |
| Runtime resource evidence | enforced | `@cellfence/schema`, `@cellfence/engine`, and `cellfence evidence check` | Requires explicit evidence JSON; CellFence does not observe live infrastructure by itself | evidence fixtures and CLI tests |
| Runtime trace hook | partially_enforced | `@cellfence/trace` | Node.js fs read/write and fetch tracing plus explicit database/HTTP/queue helper records in v0.x; source-code module loading is ignored | trace tests |
| Resource access baseline inventory | enforced | `@cellfence/engine` baseline metrics | Captures selected static and supplied runtime evidence inventory; arbitrary ORM and broker coupling remain outside v0.x inference | baseline resource fixtures |
| Baseline ratchets | enforced | `@cellfence/engine` | Counts are intentionally coarse in v0.x | baseline fixture tests |
| Locked baseline update protection | enforced | `@cellfence/engine` and `cellfence baseline update` | Enforces locked cells; locked resource contracts are context and resolution metadata in v0.x | CLI tests |
| Agent context projection | enforced | `@cellfence/engine` and `cellfence context` | Projects manifest and baseline state; it does not grant permissions or approve contract expansion | CLI tests |
| Agent auto-allocation projection | enforced | `@cellfence/engine` and `cellfence context --auto-allocate` | Heuristic task-to-cell matching from manifest text; empty selections require a human-selected cell or clearer task | CLI tests |
| Coupling graph output | enforced | `@cellfence/engine` and `cellfence graph` | Emits observed and declared coupling as JSON or Mermaid; visualization is not an enforcement substitute | CLI tests |
| Suggested resolutions | enforced | `@cellfence/engine` JSON findings | Nonbinding; callers choose whether to apply code, manifest, baseline, or human-review paths | CLI tests |
| Changed findings diff | enforced | `@cellfence/engine` and `cellfence check --changed` | Uses a temporary Git worktree and compares finding identities; it still performs full repository analysis in v0.x | CLI tests |
| Expiring waivers | enforced | `@cellfence/engine` and `cellfence waivers list` | Line-local source comments only; missing expiry, approver, concrete rule, or reason fails the check | CLI tests |
| Waiver request generation | enforced | `@cellfence/engine` and `cellfence waivers request` | Generates approval text only; it never edits source or grants an exception by itself | CLI tests |
| TypeScript compiler API source analysis | enforced | `@cellfence/engine` | Static string dynamic imports only; computed imports are reported as unsupported | fixture tests |
| CLI exit codes | enforced | `cellfence` package | Internal errors are grouped under exit code 3 | CLI tests |
| Human-readable and JSON output | enforced | `cellfence` package | SARIF output deferred | CLI tests |
| GitHub Actions support | partially_enforced | `.github/workflows` and action wrapper | Required-check configuration must be set externally; action wrapper invokes the published CLI with `npx` | workflow files and self-check |
| npm package smoke verification | enforced | `scripts/pack-smoke.mjs` and CI `pack-smoke` job | Uses local tarballs to validate npm install, CLI execution, README/LICENSE inclusion, and forbidden generated metadata exclusion before registry publish | `npm run pack:smoke` |
| CODEOWNERS | documented | `.github/CODEOWNERS` | Enforcement requires repository settings | root-of-trust document |
| Protected branches | documented | external repository settings | Not enforceable by repository files alone | root-of-trust document |
| External immutable checker | planned | external service or pinned workflow | Not implemented in v0.x | root-of-trust document |
| Sealed hash ledger | planned | external ledger | Not implemented in v0.x | root-of-trust document |
| Credential separation | documented | external repository and npm settings | Not enforceable by package code | root-of-trust document |
| npm trusted publishing | planned | npm and GitHub OIDC settings | Publishing workflow is intentionally absent | release verification |
| Provenance or forbidden-source scan | enforced | `scripts/forbidden-source-scan.mjs` | Term list is conservative and project-owned | lint and CI |
