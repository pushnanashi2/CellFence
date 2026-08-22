# Changelog

- Breaking changes since 0.2.1 (migration steps below):
  - Evidence schema v1 -> v2 with `commitSha` required. Run
    `npx cellfence evidence rewrite --cell <id>` against existing
    v1 evidence files; the rewrite reads `git rev-parse HEAD`
    and writes a v2 file alongside the original. v1 evidence
    is no longer accepted by the engine. Re-bind every cell
    before running `cellfence check` in CI.
  - Manifest paths now reject glob metacharacters
    (`{...}`, extglob `!`, single-`?`, character classes `[...]`,
    leading `./`, embedded `//`). Manifests that relied on
    `src/**/*.{ts,tsx}` style patterns must be rewritten with
    an explicit alternation in the source. The error message
    names the offending metacharacters.
  - `cellfence-mcp-proxy`'s `--unknown-tool-policy` default is
    now `deny` (was `allow`). Existing deployments that did not
    set the flag now reject previously-allowed tools; pass
    `--unknown-tool-policy=allow` to opt back into the old
    behaviour for the transition period.
  - `cellfence waivers request` now validates the `--expires`
    date against the 90-day cap before rendering a directive.
    Scripts that generated waivers with a longer horizon
    must split the work into multiple waivers within the cap.

## Unreleased

- Align `governance.claimBackend` with manifest validation and published JSON Schema, remove validator-blind nested analysis flags from artifact/resource contract types, make bare owned paths cover the directory itself and descendants, and avoid unnecessary GitHub Action package metadata rewrites during bundling.- Add per-cell external dependency `claim`/`allow` policy, external dependency baseline sets, locked-cell dependency expansion checks, context output, and runtime/schema validation for npm package roots and Python import roots.
- Harden waiver and claim review controls by making generated manifests require key governance rules by default, limiting source waivers to short reviewed identities, and rejecting duplicate `claim create --claim-id` leases instead of replacing existing claims.- Add a fail-closed `mutation:changed` pull-request gate with test/config change detection, isolated incremental caches, machine-readable evidence, and a daily non-incremental full-scope matrix audit while retaining `break: 100` throughout.
- Cache deterministic `check --changed` base analysis outside the worktree using a key bound to the base commit, analyzer implementation, runtime, policy inputs, severity configuration, and explicit plugin identity.
- Keep arbitrary plugin loading out of manifest and CLI configuration, support explicit programmatic plugin cache identity, and remove the research ablation switch from public help.
- Publish Draft 2020-12 JSON Schema subpaths for manifests, baselines, and resource evidence with runtime-validator parity tests for structural contracts.
- Batch Python AST inspection through a bounded, memoized interpreter runner and add a 1,000-file Python scale scenario.
- Add official TypeScript, Python importlib, and OASIS SARIF conformance oracles plus safe exact-commit corpus, competitor-comparison, GitHub collection, and adversarial-evidence harnesses.
- Add closed-surface MCP proxy policy, nested array path extraction, and resource, prompt, completion, subscription, and list-change bridging while preserving the backward-compatible default.
- Turn on explicit-any, unused TypeScript binding, and JavaScript undefined-name linting, and generate the README CLI help block from the built CLI with a drift test.
- Close independent-review gaps by making Python inspector failures fail closed with batch bisection, limiting changed-result cache reuse to non-suppressing base results with complete runtime identity, rejecting empty and prototype-named MCP tool policy inputs, and binding adversarial stdout claims to pinned artifacts.
- Tie release dispatches to the exact-ref full mutation matrix, retain oracle reports on failure, harden action pin verification, and make changed-scope selection preserve deleted and both renamed paths.
- Keep changed-scope mutation testing focused on production/test scope changes instead of widening to every scope for package lock, CI, or mutation runner support-file edits.
- Harden baseline governance gates by preserving skipped-cell fail-closed deltas, diffing artifact contracts, treating CI waiver approvers as an override, binding GitHub Action approvals to the current head commit, requiring an explicit token input, and confining MCP downstream cwd through real paths.
- Remove public baseline HMAC and test waiver identities from workflows, cover every workspace in root typecheck, and harden CLI value parsing plus normal-check baseline/evidence forwarding.
- Refuse baselines that would grandfather active findings, fail closed on missing or tampered locked baselines, make claim backend configuration match the shipped synchronous local-file implementation, and mark unresolved or unsupported source observations as incomplete evidence.

## 0.2.1 - 2026-08-04

- Keep `check --changed` finding identity stable when unchanged violations move to a different source line, while preserving detection of genuinely new violations.
- Parse git paths without corrupting spaces or non-ASCII characters in both changed-file and commit-evidence checks.
- Recover claim operations from stale lock files using validated PID/timestamp metadata or a filesystem-mtime fallback while preserving live-lock exclusion.
- Prefer native Windows executables over batch shims and invoke `.cmd`/`.bat` commands through an explicitly quoted `cmd.exe` command line without `shell: true`, rejecting percent expansion and newline injection.
- Refresh transitive dependencies to patched `brace-expansion`, `fast-uri`, `hono`, and `ip-address` releases after new registry advisories were published.

## 0.2.0 - 2026-08-01

- Align engine and official-plugin path matching plus owned-path overlap analysis with minimatch semantics for standalone and embedded globstars, and enforce the dialect with exhaustive and seeded external-oracle conformance tests.
- Read discovered `tsconfig.*.json` files directly when collecting workspace path aliases instead of falling back to a neighboring `tsconfig.json`.
- Harden package-map, CommonJS alias, readonly `Set`, Python diagnostic, and public-surface resolution against ambiguous or adversarial syntax while preserving fail-closed behavior.
- Add built-in Python framework resource adapters for selected FastAPI route decorators, Django URLConf/model-manager patterns, SQLAlchemy declarative/Table/query/text calls, and Celery task/publish calls.
- Close TypeScript/CommonJS boundary bypasses by extracting `import = require(...)`, selected `module.require(...)`, simple `require` aliases, and selected `createRequire(...)` aliases.
- Report TypeScript/JavaScript parser diagnostics as `CELLFENCE_UNSUPPORTED_TYPESCRIPT_SYNTAX` fail-closed findings under the built-in required-rule profile.
- Reject unknown manifest, baseline, and resource-evidence fields, plus duplicate package names and duplicate nested policy contract identifiers.
- Strengthen TypeScript/JavaScript public surface hashes with isolated normalized declaration output, exported namespaces, local re-export roots, and regression coverage for type-facing changes without class method-body churn.
- Add release-time git identity hygiene checks and a non-destructive mailmap for legacy placeholder commit attribution.

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
