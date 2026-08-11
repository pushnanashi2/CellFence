# CellFence 0.2.1 → 0.3.0 Security Hardening — Progress

**Branch:** `fix/mavis` in `~/agents/mavis/work`
**Test result:** 934/934 passing (zero failures)

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
| d2f1db3 | require commit binding on resource evidence | H-4 |
| `8e91c97` | add PROGRESS.md for 0.3.0 security hardening | (docs) |

## Issue coverage

### Critical — all 5 done
- **C-1** — `f3cc270`: 90-day waiver cap, approver allowlist (env + git log + CODEOWNERS + `.cellfence/approvers.txt`), 3 missing required rules (`CELLFENCE_UNDECLARED_CONSUMER`, `CELLFENCE_PUBLIC_SYMBOL_MISMATCH`, `CELLFENCE_UNDECLARED_RESOURCE_ACCESS`), manifest `requiredRules` + `locked: true` for all 16 cells, `init-presets.ts` imports `CORE_REQUIRED_RULES`, engine package exposes `./constants.js`.
- **C-2** — `9239a19`: ClaimStore blocks claimId reuse unless the same agent is re-acquiring; prevents a different agent from hijacking a claim id mid-flight.
- **C-3** — `9239a19`: `validateClaimCells` rejects cells-empty claims unless the cell is already listed under `governance.include`, closing the global-claim scope-bypass.
- **C-4** — `16b3524`: `mcpToolCall` confines `rootDir`, `manifestPath`, `claimsPath`, `baselinePath` to the server's working directory. Absolute escape attempts and `..` traversal return a hard error before the engine is invoked.
- **C-5** — `1b6bfcf` + `52087c5`: ReDoS-vulnerable `(?:[^/]+/)*` replaced with a linear-time DP-based glob matcher in `packages/engine/src/glob.ts` (and duplicated into the two plugin packages that can't import cross-package source under project references). Worst case 0 ms (was 6+ s). The followup in `52087c5` aligns the `**` semantics with the previous regex form so `**/src` matches `src` and `src/**` does not match `src`; the matcher also normalises backslash paths. Conformance tests against the minimatch oracle now pass.

### High — 6 of 7 done
- **H-1** — `9239a19`: `claimConflictSurfaces` now cross-checks cell ownership against path ownership with the full context, so two claims whose `cells` arrays don't overlap can still conflict when their paths do.
- **H-2** — `9239a19`: `validateClaimCells` enforces unique claim ids per agent — no more silent dedup of two different agents racing to the same id.
- **H-4** — d2f1db3: Resource evidence is now bound to the commit it was captured against. The previous `evidence.commitSha && ...` opt-in made missing bindings silently accepted; the schema is bumped to v2 with `commitSha` required, the engine hard-errors on missing / mismatched / no-HEAD evidence, and the trace + OpenTelemetry adapters now read the live `git rev-parse HEAD` (with `GITHUB_SHA` / `CELLFENCE_TRACE_COMMIT_SHA` / `CELLFENCE_OPENTELEMETRY_COMMIT_SHA` retained as fallbacks for shallow checkouts). `gitHeadForExactRoot` accepts subdirs of the toplevel so fixture tests run from subdirectories still bind.
- **H-5** — `16b3524`: `unknownToolPolicy` default flipped from `allow` to `deny`. `DEFAULT_WRITE_TOOLS` gained the capitalised Claude Code / Cursor names (Write, Edit, NotebookEdit, MultiEdit, patch, fs_write, edit). `pathsForToolCall` and `shouldExposeTool` now do case-insensitive lookups so case-mismatched calls don't bypass path extraction.
- **H-7** — `0e67b54`: GitHub Action `version` input now defaults to the pinned `0.2.1` release; the bash script no longer builds an `evidence_args=()` array (bash 3.2 mishandles empty array expansion under `set -u`) and instead branches on the boolean inputs.

### Medium
- **M-15** — `0348d9e`: `safeDownstreamEnvironment` replaces `inheritedEnvironment()` so the proxy no longer hands `CELLFENCE_BASELINE_HMAC_KEY`, `CELLFENCE_BASELINE_ED25519_PRIVATE_KEY`, `NPM_TOKEN`, `GITHUB_TOKEN`, `AWS_*`, `DATABASE_URL`, etc. to the downstream MCP server. The allowlist is unit-tested via the `__testing` export. (Earlier session mislabelled this as H-3; the real H-3 — incomplete trace patching — is a different issue, see below.)

### Pending / deferred
- **H-3** (trace evidence structurally incomplete) — the `cellfence-trace` hook uses runtime monkey-patching that misses ESM named imports of `node:fs` / `node:http`; an evidence file that says "no accesses" is not equivalent to "the hook observed no accesses". Options under discussion: (a) downgrade the `confidence: "runtime"` label to `confidence: "transient"`, (b) replace monkey-patching with `node --import` + `diagnostics_channel`, (c) split the two cases in the report. Deferred to a follow-up session per scope.
- **H-6** (downstream-cwd validation) — `--downstream-cwd` is passed straight to the spawned MCP server without verifying it sits inside `rootDir`, so a confused-deputy symlink or a parent-directory escape could redirect the server's filesystem. Deferred; needs design discussion on whether the default should be `rootDir` (hard) or `--allow-cwd-mismatch` (explicit opt-in).

## Test environment

- `export CELLFENCE_APPROVERS=test-owner` required when running tests
- `cd ~/agents/mavis/work && npx tsc -b <packages> && node --test tests/*.test.mjs`
- The `~/agents/cellfence` checkout mirrors the worktree's `src/` so the build/test loop can run there against the symlinked `node_modules`.

## Known follow-ups (not blockers, 0.4.0 candidates)

- **3 copies of `glob.ts`** — kept identical to avoid breaking the tsc project-reference `rootDir: "src"` constraint. Consolidation into a `packages/glob` workspace is queued for 0.4.0.
- **M-20 line-free waiver** — captured as `TODO(0.4.0)` in the C-1 commit. Fixing it now would require a new `CELLFENCE_WAIVER_INVALID` finding and a test change for the "required rule" branch, so it's queued for the 0.4.0 cleanup pass.
- **Required-rule waiver invalid** — captured as `TODO(0.4.0)` in `tests/engine-api-coverage.test.mjs`. When a comment-style waiver targets a required rule, the current code silently no-ops; 0.4.0 should make it surface as `CELLFENCE_WAIVER_INVALID`.
- **H-3 / H-6** — see above; queued for the next session.
