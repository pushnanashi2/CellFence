# Threat Model

CellFence is designed to catch architectural drift introduced by humans or coding agents working through ordinary repository changes.

## In Scope

- accidental cross-cell private imports;
- undeclared consumer relationships;
- missing public entries;
- public symbol drift;
- undeclared artifact lane consumption;
- architectural surface growth beyond a baseline;
- accidental inclusion of forbidden source provenance terms.
- hand-edited baseline drift when CI verifies an externally signed baseline with `CELLFENCE_BASELINE_ED25519_PUBLIC_KEY`, or when an isolated verifier holds `CELLFENCE_BASELINE_HMAC_KEY` outside the repository.

## Out of Scope

CellFence does not protect against:

- malicious repository administrators;
- compromised CI runners;
- administrators intentionally disabling protections;
- credentials with direct protected-branch push capability;
- force-push rewriting of accepted history;
- tampering with repository-local checks before those checks run.

Repository-local checks are not a sufficient root of trust because they are themselves part of the repository being protected.

## Expected Controls Around CellFence

A strong deployment uses CellFence with protected branches, required checks, CODEOWNERS review, credential separation, an externally held Ed25519 signing key, `CELLFENCE_BASELINE_ED25519_PUBLIC_KEY` in PR checks, and an externally pinned checker or sealed ledger. HMAC protects baseline files only when the secret is kept away from jobs that execute untrusted code. In v0.x, branch protection, credential separation, and external ledgers remain documented integration points rather than complete built-in enforcement.
