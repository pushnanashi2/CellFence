# Ratchets And Baselines

<!-- Moved from README.md to keep the repository root README concise. -->


A baseline captures both compatibility metrics and normalized architectural contract sets per cell:

- owned path pattern count;
- public symbol count;
- public entry line count;
- cross-cell dependency count.
- accepted cell IDs;
- owned path set;
- public entry path;
- public symbol set;
- exported public surface signature hash;
- dependency edge set;
- artifact contract set;
- static and runtime resource access inventory.

Create the accepted baseline:

```bash
cellfence baseline create
```

Check a change against it:

```bash
cellfence baseline check
```

Reductions pass. Silent expansion or identity changes fail with rules such as:

```text
CELLFENCE_RATCHET_OWNERSHIP_SCOPE_CHANGE
CELLFENCE_RATCHET_PUBLIC_SYMBOL_SET_CHANGE
CELLFENCE_RATCHET_PUBLIC_SURFACE_SIGNATURE_CHANGE
```

Update the baseline only when the architecture expansion is intentional and reviewed:

```bash
cellfence baseline update
```

A baseline update is a governance change, not a routine way to silence a failing check. In a protected repository, review manifest and baseline changes separately from ordinary implementation changes.

If `CELLFENCE_BASELINE_HMAC_KEY` is set, `baseline create` and `baseline update` write a `seal` field using HMAC-SHA256 over the canonical baseline content. `baseline check` verifies that seal and fails with `CELLFENCE_BASELINE_SEAL_INVALID` when the baseline was hand-edited. `CELLFENCE_BASELINE_HMAC_KEY_ID` can be set to label the key used by CI. The key must live outside the repository, for example as a required-check secret; a repository-stored key does not protect against an agent editing both the baseline and the key.

If a cell has `"locked": true`, `baseline check` requires `CELLFENCE_BASELINE_HMAC_KEY` so a hand-edited baseline cannot silently redefine the accepted contract for that locked cell. `baseline update` also fails with `CELLFENCE_LOCKED_BASELINE_EXPANSION` whenever the update would increase or shift ownership scope, add public symbols, change the public entry, change public signatures, add dependency edges, add artifact contracts, increase legacy count metrics, or grandfather new resource access for that cell. A human owner must either reduce the change or explicitly review the contract expansion.

For large repositories, prefer this baseline-first workflow over hand-writing every resource contract:

1. declare cells, public entries, and ownership in the manifest;
2. run `cellfence baseline create` to snapshot existing static file, database, queue, and HTTP resource access;
3. optionally pass runtime evidence with `--evidence resource-evidence.json`;
4. run `cellfence baseline check` in CI;
5. review only new resource access deltas.

`resourceContracts` remains useful for intentional high-value contracts, but the baseline prevents a manifest maintenance treadmill where every historical table, topic, or endpoint must be manually listed before adoption.
