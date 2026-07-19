# Ratchet Conformance

This ledger pins baseline ratchet behavior.

The cases separate repository checks from locked baseline update guards. Regular
checks report concrete ratchet rules such as public symbol growth and dependency
edge growth. Baseline-update guards report locked-cell expansion through
`CELLFENCE_LOCKED_BASELINE_EXPANSION` with details that identify the expanded
metric or newly grandfathered resource.

Run it with:

```sh
npm run conformance:ratchet
```
