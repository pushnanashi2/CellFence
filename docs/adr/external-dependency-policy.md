# ADR: External Dependency Policy

## Status

Accepted for manifest v1.

## Context

CellFence already gates cross-cell imports, public surfaces, resources, and baseline growth, but external package use was only visible as an unresolved outside-repository import. That left two common governance questions outside the manifest:

- which cell is allowed to introduce a new third-party dependency;
- which cells are the only approved users of a dependency with domain ownership, licensing, precision, or supply-chain sensitivity.

The resolver already distinguishes local relative imports, TypeScript path aliases, `package.json#imports`, workspace package imports, package self imports, Node built-ins, Python local modules, and unresolved local imports. Creating a separate resolver for dependency policy would duplicate behavior and risk drift.

## Decision

CellFence supports per-cell `externalDependencies` with two sets:

- `allow`: this cell may use the dependency, without restricting other cells.
- `claim`: this cell may use the dependency, and the dependency may only be used by the set of cells that claim it.

Dependency IDs are ecosystem-qualified. npm dependencies use package roots such as `npm:zod` and `npm:@scope/pkg`; Python dependencies use import roots such as `python-import:yaml`.

External dependency observation reuses the existing module resolver. Alias, workspace, package import, package self, Node built-in, and unresolved local specifiers are not counted as external dependencies. Node built-ins are classified separately from resource access: importing `fs` or `path` is not itself a resource access, while actual API calls remain the resource detectors' responsibility.

The policy order is:

1. Claim violations are stronger than baseline entries.
2. Existing unclaimed use is allowed by `externalDependencySet` in the baseline.
3. Locked cells reject dependency-set growth, even when the manifest declares `allow` or `claim`.
4. Declared `allow` or `claim` accepts reviewed new use in unlocked cells.
5. Unclaimed, undeclared, non-baseline additions are reported as ratchet findings when a baseline is present.

Migration from existing non-claiming use to a claiming owner uses the existing waiver mechanism on the import finding; the baseline does not authorize a claim violation.

## Consequences

The baseline stores `externalDependencySet` per cell. This makes dependency addition ratchetable without requiring every legacy dependency to be hand-written into the manifest before adoption.

Unused `claim` entries are permitted because a claim can be a preventive policy before code starts using the dependency. Unused-declaration hygiene belongs in `doctor`, not in the normal `check` gate.

Lockfile or package-manager manifest reconciliation is intentionally out of scope for this decision. Direct-dependency declaration checks can be added later as a doctor-style hygiene report.
