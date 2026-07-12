# CellFence

AI agents do not need more prompts.  
They need enforceable architectural boundaries.

CellFence is a manifest-driven governance framework for TypeScript and JavaScript repositories changed by parallel coding agents. It turns architectural intent into repository-local checks: who owns which paths, which public surfaces may be imported, which artifact lanes are declared, and which boundary growth must be ratcheted instead of silently accepted.

CellFence is not an agent runner, dashboard, hosted service, or general policy platform. Version 0.x is intentionally narrow: Node.js 20+, npm workspaces, JSON manifests, a TypeScript engine, a public `cellfence` CLI, and GitHub Actions integration.

## Problem

Prompt instructions fade as agents take local shortcuts. A repository needs a small amount of enforceable terrain: cells own writable paths, consumers use public entries, artifact lanes are declared, and growth in architectural surface is visible through baselines.

## Cell Model

A cell is a named ownership unit. It declares:

- owned path patterns;
- one public entry file;
- the public symbols exported by that entry;
- consumed cells or artifact lanes;
- produced artifact lanes;
- optional budgets used by ratchets.

Private implementation is any file owned by a cell that is not its declared public entry or an explicitly produced artifact lane. Cross-cell private imports are rejected.

## Quick Start

```bash
npm ci
npm run build
npx cellfence check
npx cellfence baseline create
npx cellfence baseline check
```

Local development in this repository uses:

```bash
npm run lint
npm run typecheck
npm test
npm run cellfence:self-check
```

## Violation Example

If cell `web` imports `../core/src/private-cache.ts` while only `core/public.ts` is declared public, CellFence emits `CELLFENCE_PRIVATE_IMPORT`. If `web` does not declare that it consumes `core`, it also emits `CELLFENCE_UNDECLARED_CONSUMER`.

## Artifact Contracts

Artifact lanes are versioned paths produced by a cell. A consumer must declare the lane before importing files under that path. This keeps generated or runtime artifacts distinct from source-level public APIs.

## Ratchets

Baselines record the current size of selected architectural surfaces:

- owned path pattern count;
- public symbol count;
- public surface line count;
- cross-cell dependency count.

`cellfence baseline check` fails when those counts grow beyond the recorded baseline. Reductions pass.

## Threat Model

CellFence catches repository-local drift. It does not provide a complete root of trust. It does not protect against malicious repository administrators, compromised CI runners, intentionally disabled protections, credentials with direct protected-branch push capability, or humans bypassing required checks.

## Non-Goals

- no hosted service in v0.x;
- no dashboard in v0.x;
- no plugin API in v0.x;
- no Python, Go, GitLab, or IDE support in v0.x;
- no agent orchestrator.

## Implementation Status

See [docs/implementation-status.md](docs/implementation-status.md). Mechanisms are marked as `enforced`, `partially_enforced`, `documented`, or `planned`; repository-local checks are not described as complete root-of-trust enforcement.

## SARIF

SARIF output is deferred in v0.x. The engine already returns structured findings, so SARIF can be added without changing the manifest protocol.
