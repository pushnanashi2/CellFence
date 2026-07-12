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

A strong deployment uses CellFence with protected branches, required checks, CODEOWNERS review, credential separation, and an externally pinned checker or sealed ledger. In v0.x those controls are documented integration points rather than complete built-in enforcement.
