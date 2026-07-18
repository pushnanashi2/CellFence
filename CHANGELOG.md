# Changelog

## Unreleased

- Add built-in Python framework resource adapters for selected FastAPI route decorators, Django URLConf/model-manager patterns, SQLAlchemy declarative/Table/query/text calls, and Celery task/publish calls.

## 0.1.14 - 2026-07-18

- Bump all workspace packages and internal `@cellfence/*` dependency pins from `0.1.13` to `0.1.14` because `0.1.13` has already been published.
- Refine the upstream policy oracle study metrics with consumer edge micro and subject-macro precision/recall, null denominator handling, finding-to-question mapping coverage, resolved-manifest rechecks, and path-independent artifact set hashes.
- Clarify that upstream policy oracle v1 is an entry/dependency package-policy-hint ablation and oracle-conditioned mechanism validation, not independent CellFence precision evidence.
- Add shallow corpus clone mode and optional checkout disposal so larger onboarding studies can preserve evidence without retaining every cloned worktree.
- Add production-scope manifest inference for corpus onboarding runs, including package metadata entrypoint inference, workspace dependency consumes, and default excludes for tests, fixtures, generated files, vendored files, build output, styles, and assets.
- Improve inferred manifests for real TS/JS app repositories by discovering common top-level source roots, narrowing parent cells around nested package roots, and treating `packages/@scope/*` entries as packages instead of namespace cells.
- Improve Python manifest inference with `pyproject.toml`, `setup.cfg`, and static `setup.py` package metadata, Python public-entry candidates, and inferred Python absolute-import consumer edges.
- Add a frozen OSS Python 10 onboarding corpus and pilot report: 10/10 completed, 0 configuration/tool/timeout failures, and 121 unlabeled findings reserved for tuning rather than precision claims.
- Report unsupported Python syntax and Python template files as fail-closed findings instead of letting Python AST parse failures abort manifest inference or checks.
- Add frozen Django, FastAPI, SQLAlchemy, and Celery topic corpora with 200 repositories each; after the unsupported-syntax fix, the 800-row Python framework onboarding rerun reached 800/800 completed checks with 0 harness failures.
- Add a history-replay research harness for exact before/after commit pairs, introduced-fingerprint comparison, optional before-baseline replay, and counterfactual evidence reports.
- Disambiguate duplicate corpus evidence finding IDs with stable occurrence indexes when identical audit fingerprints are emitted more than once.
- Fix resource SQL detection so zero-argument `.query()` calls are ignored instead of raising an internal analyzer error.

## 0.1.13 - 2026-07-18

- Reject `cellfence init --output` without a value before writing manifests or scaffold files.
- Add release verification for the current changelog version section, with strict Unreleased checks in the npm publish workflow.
- Add a corpus evidence bundle generator and validator with stable finding IDs, deterministic sampling, manual-label validation, copied manifests/logs, and SHA-256 checksums.
- Add a reproducible corpus precision study harness and protocol for frozen-repository onboarding, failure-inclusive CellFence checks, and manual false-positive labeling.
- Add the first frozen TS/JS workspace corpus pilot report and fix the root-file glob versus nested-directory ownership overlap false positive it exposed.
- Harden the corpus study harness with contained subject and manifest paths, command timeouts, fixed check outputs, manifest hashes, audit-log capture, and explicit configuration/tool/timeout classifications before expanding to larger corpora.
- Add non-destructive `cellfence init --output ... --no-scaffold` support, use it for corpus `infer` manifests, and add npm publish post-smoke checks that reinstall the released CLI from the registry.
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
