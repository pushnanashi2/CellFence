# Mutation testing

CellFence keeps two mutation-testing paths with the same `break: 100` threshold.

- `.github/workflows/mutation-audit.yml` is the scheduled, manually dispatched, and reusable full audit. It derives an 18-scope matrix from `stryker.conf.mjs`, disables incremental reuse, and keeps each scope at `high: 100`, `low: 100`, and `break: 100`. The npm publish workflow must complete this audit at the exact tag ref before its approval-controlled publish job can start.
- `npm run mutation` remains the local single-process full audit for machines that can accommodate it.
- `npm run mutation:changed` is the pull-request feedback path. It compares the branch with `origin/main` by default, selects mutation-covered production files and their dedicated tests, and runs each selected target against its fixed dedicated test set.

Each changed scope has its own incremental cache under `reports/mutation/incremental/`. The PR workflow isolates this cache by pull-request number; it is never reused by the full audit. Changing, deleting, or renaming a target or one of its tests invalidates the relevant cached results through Stryker incremental mode. Rename detection is disabled for scope selection so both old and new paths are considered. Changing the mutation runner, mapping, configuration, lockfile, or root package metadata selects every scope. Use `--force` to disregard a cache, `--no-incremental` to run selected scopes without caching, `--files <comma-separated-paths>` to select paths explicitly, or repeat `--scope <id>` for a stable explicit scope selection.

CI checkouts must fetch the comparison ref used by the runner. Pass `--base <ref>` or set `CELLFENCE_MUTATION_BASE` when `origin/main` is unavailable in a shallow checkout.

The target-to-test map lives in `scripts/mutation-scopes.mjs`. Its complete target set is checked against `stryker.conf.mjs` before a changed run or matrix generation starts. Adding a full mutation target without adding a changed scope therefore fails closed instead of silently omitting the target.

Every run writes `reports/mutation/changed/plan.json` and `summary.json`. A successful no-work run records an empty execution list and an explicit reason; executed runs record base/head commits, elapsed time, exit status, and failed scopes. CI uploads the directory even on failure. A killed runner can leave only `plan.json`; treat that as incomplete evidence and rerun the scope.

The changed runner does not replace the full audit and must not be cited as release-wide mutation evidence. Files outside the existing full mutation target set produce no scoped mutation work and still require the normal lint, typecheck, and test gates.
