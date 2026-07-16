# Governance Core Pre-v1

CellFence still exposes the existing CLI, engine API, manifest schema, baseline schema, finding shape, and exit-code contract. This document records the internal pre-v1 split introduced before a public protocol is frozen.

## Purpose

The governance core separates repository observation from gate evaluation. Filesystem, TypeScript, manifest, baseline, plugin, and evidence readers remain in the current engine runner. The final governance decision is delegated to a deterministic evaluator that receives only normalized data.

## Internal Layers

1. Subject snapshot
   - Captures the authoritative file set for a check.
   - Records normalized path, role, content digest, size, and a snapshot digest.
   - Does not decide whether a finding is valid.

2. Raw observation report
   - Records which observation families processed each subject file.
   - Current families include manifest, ownership, public-surface, imports, resources, baseline, plugins, and waivers.
   - Parse errors and unsupported observations are evidence, not silent absence.

3. Evidence assessment
   - Verifies that the observation report targets the subject snapshot.
   - Fails closed on missing file observations, parse errors, unsupported observations, unknown files, duplicate observations, and missing required families.
   - Produces `COMPLETE` or `INCOMPLETE`.

4. Governance control state
   - Normalizes declared, observed, and accepted intermediate representations.
   - Produces a stable control digest for policy drift detection.

5. Deterministic evaluator
   - Consumes active findings, warnings, metrics, required rules, and evidence assessment.
   - Emits `ALLOW`, `BLOCK`, or `NOT_EVALUATED`.
   - Imports no filesystem, path, process, child process, Git, TypeScript, or environment APIs.

## Compatibility Boundary

The public `checkRepository()` result remains the compatibility surface:

- `ok`
- `exitCode`
- `findings`
- `warnings`
- `metrics`

Existing rule IDs, severities, messages, and baseline behavior are preserved. The pre-v1 evaluator is an internal decision layer, not a new public API.

## Fail-Closed Rules

The evaluator blocks when either of these is true:

- An active error finding remains after severity policy and waiver filtering.
- Required evidence is incomplete.

The evidence layer is allowed to report an internal `CELLFENCE_EVIDENCE_COVERAGE` rule result. It is not currently exposed as a public `Finding` because normal engine checks synthesize complete observations from the existing runner.

## Non-Goals

This pre-v1 layer does not yet:

- Replace the TypeScript import scanner.
- Replace resource adapters.
- Change manifest or baseline schemas.
- Export a new public evaluator API.
- Add new npm dependencies.
- Change package versioning or publish behavior.

## Next Step

The next safe migration step is to move individual rule families from runner-side findings into explicit declared, observed, and accepted IR records, one family at a time, while keeping fixture characterization tests green.
