# CellFence 0.2.1 → 0.3.0 Security Hardening — Progress

**Branch:** `fix/mavis` in `~/agents/mavis/work`
**Test result:** 956/956 passing (zero failures)

## Commits on `fix/mavis`

| SHA | Title | Issues |
|---|---|---|
| `f3cc270` | enforce 90-day waiver cap, approver allowlist, and required-rule coverage | C-1 |
| `1b6bfcf` | replace exponential glob matcher with linear-time DP implementation | C-5 (partial) |
| `9239a19` | harden claim store against takeover, scope bypass, and conflicts | C-2, C-3, H-1, H-2 |
| `16b3524` | confine MCP tool paths to server root and default unknown tools to deny | C-4, H-5 |
| `0e67b54` | pin GitHub Action CLI version and avoid bash 3.2 array expansion | H-7 |
| `0348d9e` | filter MCP proxy downstream env to an explicit allowlist | M-15 |
| `52087c5` | align glob ** semantics with the previous regex dialect | C-5 (followup) |
| d7d8110 | note H-4 commit in progress log | (docs) |
| d2f1db3 | require commit binding on resource evidence | H-4 |
| `8e91c97` | add PROGRESS.md for 0.3.0 security hardening | (docs) |
| `d5a6503` | add coverage command prototype | 0.4.0 (prototype) |
| `f32c975` | add baseline update gate prototype | 0.4.0 (prototype) |
| `95eea9b` | add distributed claim backend prototype | 0.4.0 (prototype) |
| `47c7855` | land H-3 and H-6 plus 0.4.0 feature full implementations | H-3, H-6, 0.4.0 (full) |

## Issue coverage

### Critical — all 5 done
- **C-1** — `f3cc270`: 90-day waiver cap, approver allowlist (env + git log + CODEOWNERS + `.cellfence/approvers.txt`), 3 missing required rules (`CELLFENCE_UNDECLARED_CONSUMER`, `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`, `CELLFENCE_UNDECLARED_RESOURCE_ACCESS`), manifest `requiredRules` + `locked: true` for all 16 cells, `init-presets.ts` imports `CORE_REQUIRED_RULES`, engine package exposes `./constants.js`.
- **C-2** — `9239a19`: ClaimStore blocks claimId reuse unless the same agent is re-acquiring; prevents a different agent from hijacking a claim id mid-flight.
- **C-3** — `9239a19`: `validateClaimCells` rejects cells-empty claims unless the cell is already listed under `governance.include`, closing the global-claim scope-bypass.
- **C-4** — `16b3524`: `mcpToolCall` confines `rootDir`, `manifestPath`, `claimsPath`, `baselinePath` to the server's working directory. Absolute escape attempts and `..` traversal return a hard error before the engine is invoked.
- **C-5** — `1b6bfcf` + `52087c5`: ReDoS-vulnerable `(?:[^/]+/)*` replaced with a linear-time DP-based glob matcher in `packages/engine/src/glob.ts` (and duplicated into the two plugin packages that can't import cross-package source under project references). Worst case 0 ms (was 6+ s). The followup in `52087c5` aligns the `**` semantics with the previous regex form so `**/src` matches `src` and `src/**` does not match `src`; the matcher also normalises backslash paths. Conformance tests against the minimatch oracle now pass.

### High — all 7 done
- **H-1** — `9239a19`: `claimConflictSurfaces` now cross-checks cell ownership against path ownership with the full context, so two claims whose `cells` arrays don't overlap can still conflict when their paths do.
- **H-2** — `9239a19`: `validateClaimCells` enforces unique claim ids per agent — no more silent dedup of two different agents racing to the same id.
- **H-4** — d2f1db3: Resource evidence is now bound to the commit it was captured against. The previous `evidence.commitSha && ...` opt-in made missing bindings silently accepted; the schema is bumped to v2 with `commitSha` required, the engine hard-errors on missing / mismatched / no-HEAD evidence, and the trace + OpenTelemetry adapters now read the live `git rev-parse HEAD` (with `GITHUB_SHA` / `CELLFENCE_TRACE_COMMIT_SHA` / `CELLFENCE_OPENTELEMETRY_COMMIT_SHA` retained as fallbacks for shallow checkouts). `gitHeadForExactRoot` accepts subdirs of the toplevel so fixture tests run from subdirectories still bind.
- **H-5** — `16b3524`: `unknownToolPolicy` default flipped from `allow` to `deny`. `DEFAULT_WRITE_TOOLS` gained the capitalised Claude Code / Cursor names (Write, Edit, NotebookEdit, MultiEdit, patch, fs_write, edit). `pathsForToolCall` and `shouldExposeTool` now do case-insensitive lookups so case-mismatched calls don't bypass path extraction.
- **H-7** — `0e67b54`: GitHub Action `version` input now defaults to the pinned `0.2.1` release; the bash script no longer builds an `evidence_args=()` array (bash 3.2 mishandles empty array expansion under `set -u`) and instead branches on the boolean inputs.

### Medium
- **M-15** — `0348d9e`: `safeDownstreamEnvironment` replaces `inheritedEnvironment()` so the proxy no longer hands `CELLFENCE_BASELINE_HMAC_KEY`, `CELLFENCE_BASELINE_ED25519_PRIVATE_KEY`, `NPM_TOKEN`, `GITHUB_TOKEN`, `AWS_*`, `DATABASE_URL`, etc. to the downstream MCP server. The allowlist is unit-tested via the `__testing` export. (Earlier session mislabelled this as H-3; the real H-3 — incomplete trace patching — is a different issue, see below.)

### Pending / deferred
- **H-3** — `47c7855`: Trace evidence now distinguishes an active hook from an inactive one. The schema accepts a new `transcriptStatus` field (`active` / `inactive` / `incomplete`) and the new `confidence: "transient"` value alongside the existing `runtime` label. The trace hook flips its default to `transient` and writes `transcriptStatus: active` when it ran and `inactive` when `CELLFENCE_TRACE_DISABLE=1` was set. The engine surfaces missing or `incomplete` evidence as `CELLFENCE_RESOURCE_EVIDENCE_TRANSCRIPT_INACTIVE` / `_INCOMPLETE` warnings so an empty `accesses` array cannot be mistaken for proof that no accesses happened. The full monkey-patching rewrite (`node --import` + `diagnostics_channel`) is still queued for 0.4.1.
- **H-6** — `47c7855`: `--downstream-cwd` is now validated to sit inside `--root` by default. The cellfence-mcp-proxy resolves the spawned MCP server's working directory and rejects any cwd that escapes `--root` with a hard error. A new `--allow-cwd-mismatch` opt-in escape hatch lets advanced deployments point the downstream at a sibling directory without disabling the safety net for everyone else. Five unit tests cover the default, in-tree, parent-escape, outside-tree, and `allowCwdMismatch=true` cases.

## Test environment

- `export CELLFENCE_APPROVERS=test-owner` required when running tests
- `cd ~/agents/mavis/work && npx tsc -b <packages> && node --test tests/*.test.mjs`
- The `~/agents/cellfence` checkout mirrors the worktree's `src/` so the build/test loop can run there against the symlinked `node_modules`.

## Known follow-ups (not blockers, 0.4.0 candidates)

- **3 copies of `glob.ts`** — kept identical to avoid breaking the tsc project-reference `rootDir: "src"` constraint. Consolidation into a `packages/glob` workspace is queued for 0.4.0.
- **M-20 line-free waiver** — captured as `TODO(0.4.0)` in the C-1 commit. Fixing it now would require a new `CELLFENCE_WAIVER_INVALID` finding and a test change for the "required rule" branch, so it's queued for the 0.4.0 cleanup pass.
- **Required-rule waiver invalid** — captured as `TODO(0.4.0)` in `tests/engine-api-coverage.test.mjs`. When a comment-style waiver targets a required rule, the current code silently no-ops; 0.4.0 should make it surface as `CELLFENCE_WAIVER_INVALID`.
- **H-3 / H-6** — see above; queued for the next session.

## 0.4.0 prototypes

These three are 0.4.0 work prototypes — the shape, the test, and
the documentation. The full implementations (real walkers, GitHub
Action enforcement, distributed backends) are still pending.

- **`cellfence coverage`** — `d5a6503`. The engine ships a
  coverage collector that records unresolved import / resource /
  public-surface observations, and the CLI rolls them into a
  `cellfence.coverage.v1` report. `--fail-under` (or
  `CELLFENCE_COVERAGE_FAIL_UNDER`) makes CI gate on coverage. The
  real repository walker that asks each adapter to call into the
  collector, and the SARIF reporter, are queued for 0.4.0.
- **`cellfence baseline gate`** — `f32c975`. The engine ships a
  `detectBaselineChanges` function (and the `GovernanceChangeReport`
  schema) that compares two baselines on the
  ownedPaths / publicSymbols / crossCellEdges / resourceAccesses
  dimensions. The CLI exposes a `baseline gate` subcommand that
  takes `--baseline-base` / `--baseline-head` (or the matching env
  vars) and exits 0 on a governance change, 1 otherwise. The
  companion `@cellfence/github-action-baseline-gate` action ships
  as a skeleton (action.yml + src/index.ts + README) so workflows
  can be drafted against it today; the enforcement code path
  (CODEOWNER lookup, label upsert, sticky comment, mixed-PR
  warning) is queued for 0.4.0.
- **Distributed claim backend** — `95eea9b`. A `ClaimStoreBackend`
  interface plus two reference implementations:
  `LocalFileClaimStore` (re-reads from disk before compare-and-swap,
  throws `CellFenceClaimCasConflict` on lost updates) and
  `GitHubArtifactClaimStore` (no native lock, optimistic-CAS only,
  full wiring queued for 0.4.0). The 0.4.0 refactor of
  `packages/engine/src/claims.ts` will route all claim reads and
  writes through the same interface.

## 0.4.0 full implementations

The prototype commits (`d5a6503`, `f32c975`, `95eea9b`) shipped the
shape, the tests, and the docs. `47c7855` ships the wiring so the
prototype stops being a stub:

- **Coverage walker** — `47c7855`. `runCoverageCommand` now runs
  `checkRepository` under the hood and buckets every finding the
  existing rules raise into import / resource / public-surface
  unresolved observations. CLI accepts `--fail-under` and
  `--coverage-output` directly; the `CELLFENCE_COVERAGE_FAIL_UNDER`
  env var still works for backward compatibility. SARIF output is
  queued for 0.4.1.
- **Baseline update gate (git-ref form)** — `47c7855`. The CLI
  accepts two git refs (`--base-ref` / `--head-ref`) in addition
  to the prototype's path-based form, reading the baseline from
  each ref via `git show <ref>:<path>`. Used by the
  `cellfence-baseline-gate` action in CI. The companion
  `@cellfence/github-action-baseline-gate` package is still a
  skeleton; the 0.4.1 commit will wire octokit, the CODEOWNER
  lookup, the label upsert, and the sticky comment.
- **Distributed claim backend selector** — `47c7855`. The new
  `resolveClaimBackend` helper reads `governance.claimBackend` from
  the manifest (or `CELLFENCE_CLAIM_BACKEND` from the environment)
  and returns the matching `ClaimStoreBackend`. The default stays
  `local-file`; the existing JSON-file code path in
  `packages/engine/src/claims.ts` is preserved unchanged until the
  follow-up migration lands. Four unit tests cover the default,
  manifest, env override, and unknown-type fallback.
