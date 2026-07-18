# Root of Trust

CellFence v0.x implements repository-local checks. Those checks are useful, but they are not a complete root of trust.

## Repository-Local Layer

The repository contains:

- manifest validation;
- import graph checks;
- artifact lane checks;
- baseline ratchets;
- optional baseline HMAC seals when CI supplies `CELLFENCE_BASELINE_HMAC_KEY`;
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

Baseline HMAC seals protect ratchet files when the key is outside the repository. They do not pin the checker, manifest, workflow, or policy itself.

A broader sealed hash ledger is planned. It would record trusted manifest and checker hashes outside the repository so that a proposed change cannot silently weaken the checker and then approve itself. This is not enforced in v0.x.

## Break-Glass

Break-glass should require a named human approver, time-bounded scope, and post-event review. CellFence documents this requirement but does not implement an approval service.
