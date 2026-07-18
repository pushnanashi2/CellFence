# Root of Trust

CellFence v0.x implements repository-local checks. Those checks are useful, but they are not a complete root of trust.

## Repository-Local Layer

The repository contains:

- manifest validation;
- import graph checks;
- artifact lane checks;
- baseline ratchets;
- optional baseline seals, preferably Ed25519 verification with `CELLFENCE_BASELINE_ED25519_PUBLIC_KEY`, or HMAC verification only in isolated verifier setups;
- forbidden source scanning;
- CI workflow definitions.

These mechanisms can fail a build when they run.

## External Layer

The following mechanisms require human configuration outside the repository:

- protected branches;
- required status checks;
- CODEOWNERS enforcement;
- immutable workflow references;
- separated credentials for automation;
- human-only merge path;
- break-glass approval procedure;
- npm trusted publishing through GitHub OIDC.

## Sealed Ledger

Baseline seals protect ratchet files only when signing authority is outside ordinary agent-controlled changes. Ed25519 verification lets PR checks use a public key only; HMAC requires an isolated verifier or secret-bearing trusted workflow. Neither model pins the checker, manifest, workflow, or policy itself.

A broader sealed hash ledger is planned. It would record trusted manifest and checker hashes outside the repository so that a proposed change cannot silently weaken the checker and then approve itself. This is not enforced in v0.x.

## Break-Glass

Break-glass should require a named human approver, time-bounded scope, and post-event review. CellFence documents this requirement but does not implement an approval service.
