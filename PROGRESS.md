# CellFence Development Progress

This file is a public, repository-local progress summary. It intentionally avoids private workstation paths, agent names, local branch names, or unreproducible environment details.

## Current Line

- Current package version: `0.2.1`.
- Active work is tracked under `CHANGELOG.md` `Unreleased`; release publishing must move those notes under a dated version heading before a real npm publish.
- Main CI includes lint, typecheck, build, tests, cross-platform smoke tests, external oracles, self-check, release verification, provenance scan, pack smoke, synthetic scale benchmark, and CI-count telemetry.
- Self-check runs against `cellfence.manifest.json` with all built-in `resourceAdapters` enabled and verifies `cellfence.baseline.json` with an Ed25519 public key.

## Completed Hardening Themes

- **Baseline governance** — baseline seals support Ed25519 verification for public-key PR checks, HMAC only for isolated verifier setups, locked-cell expansion guards, artifact/resource/external-dependency ratchets, and baseline-gate approval checks.
- **Resource governance** — static resource contracts cover selected file, HTTP, queue, SQL, Prisma, TypeORM, Drizzle, BullMQ, KafkaJS, NestJS, Fastify, Django, FastAPI, SQLAlchemy, and Celery patterns, with unresolved dynamic forms reported fail-closed where supported.
- **Import and ownership boundaries** — strict ownership, symlink containment, root-escaping import detection, CommonJS/TypeScript alias coverage, Python import resolution, and public-surface hashing are covered by fixtures and conformance tests.
- **Claims and waivers** — claim leases have local locking/CAS semantics, self-declared agent identity is documented as coordination-only, and waivers require short-lived signed attestations instead of source-local approval text.
- **MCP and Action surfaces** — MCP path inputs are contained beneath the configured root by default, downstream environment variables are allowlisted, and bundled GitHub Actions are rebuilt and checked in CI.
- **Mutation and evidence gates** — pull requests run scoped mutation selection while the scheduled audit remains non-incremental; evidence harnesses bind artifacts to exact commits and avoid target-repository install scripts.

## Known Follow-Ups

- **Trace depth** — `@cellfence/trace` is a runtime evidence producer, not a sandbox. Node.js `fs` and fetch hooks plus explicit helper records are supported; broader ESM/module-loader and framework tracing needs a separate design.
- **Glob package consolidation** — the engine and selected official plugins still carry separate glob helpers because their current project-reference boundaries do not permit direct source sharing. Keep behavior parity covered by tests until a dedicated shared package is introduced.
- **Coverage output** — `cellfence coverage` reports unresolved observations and can gate with `--fail-under`; it remains a visibility report, not proof that unsupported code paths are safe.
- **Distributed claims** — the shipped manifest selector accepts the synchronous `local-file` backend. Redis, object-store, or GitHub-artifact-backed coordination should not be documented as production-ready until they persist state across processes and runners.
- **Root of trust** — repository-local workflow files are not enough on their own. Protected branches, required checks, CODEOWNERS, credential separation, and externally held signing material remain part of a real deployment.

## Verification Shortlist

Before merging governance or documentation changes, prefer:

```bash
npm run docs:cli-help:check
npm run lint
npm run typecheck
npm test
CELLFENCE_BASELINE_ED25519_PUBLIC_KEY="$(cat baseline-ed25519-public.pem)" npm run cellfence:self-check
```

For code changes touching mutation targets, run the applicable `npm run mutation:changed -- --scope <scope>` command or document why a docs-only change did not require mutation execution.
