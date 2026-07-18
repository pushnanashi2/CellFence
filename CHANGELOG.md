# Changelog

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
