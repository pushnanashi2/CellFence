# Semantic Event Detector v3.2

Status: frozen reference detector
Frozen on: 2026-07-17

This document defines the v3.2 semantic event detector contract used by CellFence research. It is a detector-validation artifact, not a global market-prevalence claim.

## Scope

v3.2 detects diff-backed events that require semantic interpretation beyond file names and commit messages:

| event | CellFence candidate |
|---|---|
| `cross_boundary_rename_source` | `CELLFENCE_CROSS_CELL_MOVE` |
| `workflow_and_governance_control_event` | `protectedPaths` / `requiresApprovalPaths` |
| `workflow_action_reference_change` | `protectedPaths` / `requiresApprovalPaths` |
| `entrypoint_export_declaration_change` | entrypoint declaration ratchet |
| `threshold_decrease` | threshold-down detector |

## Workflow Control Rules

Workflow controls are compared as normalized semantic records, not raw YAML text. The v3.2 freeze requires:

- workflow file deletion emits removals for triggers, permissions, secrets, action references, and repository publish operations;
- action references use structural identity from the action name without the version ref, not display name or step index;
- `cmd || true`, `cmd || :`, and `cmd || exit 0` emit one `failure_enforcement` record per normalized suppressed command;
- suppression replacement is represented as removed old command plus added new command, not as one large run-block replacement;
- `set +e` is detected as `errexit-disabled` and remains nonblocking unless a stricter policy classifies it as blocking;
- records outside the same recent-head comparison window are excluded from recall-regression denominators.

## Freeze Fixtures

The frozen fixture corpus lives in `tests/fixtures/semantic-event-detector-v32/`.

Required cases:

- `workflow-deletion.before.yml` to `workflow-deletion.after.yml`
  - must remove at least one trigger, permission, secret, action reference, and publish operation.
- `suppression-replacement.before.yml` to `suppression-replacement.after.yml`
  - must remove `sudo systemctl stop myapp`;
  - must add `sudo docker stop trippiece-container`;
  - must add `sudo docker rm trippiece-container`.

## Limitations

The reference implementation in `@cellfence/engine` is intentionally small and dependency-free. It is used to freeze the v3.2 regression surface, not to claim complete GitHub Actions YAML coverage. Production rule expansion should preserve the fixture behavior and may replace the parser with a richer YAML-aware implementation.
