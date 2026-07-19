# Public Surface Conformance

This ledger fixes the public-entry contract between source exports and manifest
`publicSymbols`.

The cases cover TypeScript named/default/re-export forms, Python `__all__`, symbol
mismatches in both directions, and missing public entries.

Run it with:

```sh
npm run conformance:public-surface
```
