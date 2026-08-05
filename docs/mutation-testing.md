# Mutation testing

CellFence keeps two mutation-testing paths with the same `break: 100` threshold.

- `npm run mutation` is the full scheduled and release-candidate audit. It mutates every target listed in `stryker.conf.mjs` and remains the authoritative repository-wide mutation gate.
- `npm run mutation:changed` is the pull-request feedback path. It compares the branch with `origin/main` by default, selects only mutation-covered production files, and runs each selected target against its fixed dedicated test set.

Each changed scope has its own incremental cache under `reports/mutation/incremental/`. Changing a target or one of its tests invalidates the relevant cached results through Stryker incremental mode. Use `--force` to disregard a cache, `--no-incremental` to run selected scopes without caching, or `--files <comma-separated-paths>` to select paths explicitly.

CI checkouts must fetch the comparison ref used by the runner. Pass `--base <ref>` or set `CELLFENCE_MUTATION_BASE` when `origin/main` is unavailable in a shallow checkout.

The target-to-test map lives in `scripts/mutation-scopes.mjs`. Its complete target set is checked against `stryker.conf.mjs` before a changed run starts. Adding a full mutation target without adding a changed scope therefore fails closed instead of silently omitting the target.

The changed runner does not replace the full audit. Files outside the existing full mutation target set produce no scoped mutation work and still require the normal lint, typecheck, and test gates.
