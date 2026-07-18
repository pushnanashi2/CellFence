# Changelog

## Unreleased

- Add a reproducible corpus precision study harness and protocol for frozen-repository onboarding, failure-inclusive CellFence checks, and manual false-positive labeling.
- Add the first frozen TS/JS workspace corpus pilot report and fix the root-file glob versus nested-directory ownership overlap false positive it exposed.
- Harden the corpus study harness with contained subject and manifest paths, command timeouts, fixed check outputs, manifest hashes, audit-log capture, and explicit configuration/tool/timeout classifications before expanding to larger corpora.

## 0.1.13 - 2026-07-18

- Fix owned path overlap detection so sibling path prefixes such as `src/user/**` and `src/users/**` no longer trigger `CELLFENCE_OWNERSHIP_OVERLAP`, while nested ownership such as `src/shared/**` and `src/shared/narrow/**` still fails.
- Bump all workspace packages and internal `@cellfence/*` dependency pins from `0.1.12` to `0.1.13` for the next pre-release package set.
- Expand README and package README command coverage for shipped `doctor`, `prune`, `task`, `docs`, `mutation`, `manifest verify`, `evidence commit`, and baseline sealing commands.
- Clarify that owned-path prefix overlap is segment-aware, arbitrary glob intersection remains conservative, and npm Trusted Publisher configuration is enabled for the configured publish set while first-time scoped package ownership remains separate.
- Align the reusable GitHub Action wrapper with the published CLI version and add release verification for future Action/MCP version drift.
- Add `cellfence check --format markdown` for PR-ready summaries and `--format sarif` for GitHub Code Scanning ingestion.
- Add `cellfence init --preset python-service` and `--preset polyglot-monorepo` with checked starter source files.
- Add Python service and polyglot monorepo examples to present CellFence as repository change governance beyond TypeScript-only boundary checks.

## 0.1.12 - 2026-07-18

- Bump all workspace packages and internal `@cellfence/*` dependency pins from `0.1.11` to `0.1.12` for the next pre-release package set.
- Split baseline sealing and ratchet comparison internals out of `packages/engine/src/index.ts` without changing the public engine API.
- Add npm pre-publish documentation for trusted publishing, provenance, SBOM generation, GitHub Releases, and the no-publish local release gate.
- Add safer GitHub Actions examples for asymmetric baseline verification on PRs and approval-scoped baseline signing workflows.
- Reframe the A/B friction study as a controlled mechanism validation, not evidence of natural autonomous-agent behavior.
- Add sanitized real-use fixtures for a Cash-style service layout, Python source layout, monorepo package imports, and runtime resource evidence.

## 0.1.11 - 2026-07-18

- Add asymmetric Ed25519 baseline sealing and verification.
- Keep HMAC baseline sealing available for isolated verifier deployments.
