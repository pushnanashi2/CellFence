# CellFence Review Triage And Issue Drafts

Review date: 2026-09-05
Target repository: pushnanashi2/CellFence
Target branch/commit: main, 99e6febb84232949b77ab6ba48ab3cb5412326b5
Working tree: /home/ubuntu/CellFence-review-a5ae96

## Status Summary

| ID | Priority | Title | Patch status | Regression coverage |
| --- | --- | --- | --- | --- |
| CF-01 | P1 | init overwrites existing example cell source | Fixed | tests/review-regressions.test.mjs |
| CF-02 | P1 | imports in parameters, types, and binding defaults are missed | Fixed | tests/review-regressions.test.mjs |
| CF-03 | P1 | @internal stripping removes the previous public API declaration | Fixed | tests/review-regressions.test.mjs |
| CF-04 | P1 | Python __all__ erases public signature material | Fixed | tests/review-regressions.test.mjs |
| CF-05 | P1 | tsconfig paths priority differs from TypeScript | Fixed | tests/review-regressions.test.mjs, tests/module-resolution.test.mjs |
| CF-06 | P1 | package imports condition resolution differs from Node | Fixed | tests/review-regressions.test.mjs, tests/module-resolution.test.mjs |
| CF-07 | P1 | repo-local file: URL imports are not governed as local imports | Fixed | tests/review-regressions.test.mjs |
| CF-08 | P1 | SQL DELETE is classified as read | Fixed | tests/review-regressions.test.mjs |
| CF-09 | P1 | quoted SQL table names are missed | Fixed | tests/review-regressions.test.mjs |
| CF-10 | P1 | numeric fs.open/openSync write flags are classified as read | Fixed | tests/review-regressions.test.mjs, tests/resource-access-coverage.test.mjs |
| CF-11 | P1 | task check misses staged changes and deletions | Fixed | tests/review-regressions.test.mjs |
| CF-12 | P1 | official Stryker report source field is misread | Fixed | tests/review-regressions.test.mjs |
| CF-13 | P1 | Baseline Action CODEOWNERS interpretation diverges from GitHub | Fixed for matching, file priority, and ownerless rules; team expansion remains explicit future design | tests/baseline-gate.test.mjs |
| CF-14 | P2 | single-segment glob matching can still backtrack | Fixed | tests/file-index.test.mjs |
| CF-15 | P2 | official OpenTelemetry evidence is always incomplete | Fixed | tests/review-regressions.test.mjs |
| CF-16 | P2 | OpenTelemetry DDL/MERGE-like operations classify as read | Fixed | tests/review-regressions.test.mjs |
| CF-17 | P2 | MCP write-tool override fails on tool-name casing | Fixed | tests/review-regressions.test.mjs |
| CF-18 | P2 | trace records percent-encoded file URL paths | Fixed | tests/trace.test.mjs |
| CF-19 | P2 | bare directory ownership has inconsistent semantics | Fixed | ownership conformance, engine coverage |
| CF-20 | P2 | ownedPathPatterns count changes are not surfaced in baseline diff | Fixed | tests/review-regressions.test.mjs |
| CF-21 | P2 | coverage hides explicit baseline read failures behind 100% success | Fixed | tests/review-regressions.test.mjs, tests/coverage.test.mjs |
| CF-22 | P2 | deleted tests make commit evidence throw internally | Fixed | tests/review-regressions.test.mjs |
| CF-23 | P2 | commit trailers cannot express an explicit empty test set | Fixed | tests/review-regressions.test.mjs |
| CF-24 | P2 | stale local claim write lock cannot recover | Fixed | tests/review-regressions.test.mjs |
| CF-25 | P2 | Python stdlib modules are treated as new external deps | Fixed for common stdlib roots listed in the hardcoded detector | tests/review-regressions.test.mjs |

Security dependency note: the report's specific Action `undici` path is already resolved at this target commit by `@actions/core@3.0.1`, `@actions/github@9.1.1`, and `undici@6.28.0`. Current production audit additionally exposed `fast-uri` and `qs`; this patch pins fixed versions through npm overrides.

## GitHub Issue Drafts

### CF-01 [P1] init overwrites existing example cell source

Labels: `bug`, `p1`, `cli`, `data-loss`

Problem: Running `cellfence init` in a repository that already has `src/example/public.ts` can overwrite user source while creating the example fallback manifest.

Acceptance: `init` must never overwrite an existing source file. If an example fallback file already exists, the generated manifest should infer public symbols from that file or fail without writing source when scaffolding is disabled.

Patch status: Fixed in `packages/cli/src/index.ts`.

### CF-02 [P1] imports in parameters, types, and binding defaults are missed

Labels: `bug`, `p1`, `engine`, `boundary-analysis`

Problem: Import expressions and import types inside function parameters, return/type positions, and binding-pattern default initializers can bypass private-import detection.

Acceptance: The import extractor must visit parameter initializers, parameter types, return types, type parameters, and binding-pattern default expressions before binding local names.

Patch status: Fixed in `packages/engine/src/module-resolution.ts`.

### CF-03 [P1] @internal stripping removes the previous public API declaration

Labels: `bug`, `p1`, `engine`, `public-surface`

Problem: Removing `@internal` declarations by full-start line ranges can also remove the previous public declaration from the public surface hash.

Acceptance: Public surface hashes must change when public signatures change, even when an adjacent following declaration is marked `@internal`.

Patch status: Fixed in `packages/engine/src/module-resolution.ts`.

### CF-04 [P1] Python __all__ erases public signature material

Labels: `bug`, `p1`, `engine`, `python`, `public-surface`

Problem: When `__all__` is present, surface hashing collapses to the public name list and loses public function/class signature material.

Acceptance: `__all__` should filter public names, not replace signature material. Unresolved names listed in `__all__` should remain explicit in the surface data.

Patch status: Fixed in `packages/engine/src/python-analysis.ts`.

### CF-05 [P1] tsconfig paths priority differs from TypeScript

Labels: `bug`, `p1`, `engine`, `module-resolution`

Problem: Path alias resolution can choose a broad wildcard mapping before a more specific exact mapping.

Acceptance: Exact matches must beat wildcard matches, and wildcard candidates should be sorted by specificity before resolving targets.

Patch status: Fixed in `packages/engine/src/module-resolution.ts`.

### CF-06 [P1] package imports condition resolution differs from Node

Labels: `bug`, `p1`, `engine`, `module-resolution`

Problem: Package import maps can resolve inactive or unknown conditions, producing a path different from Node's active runtime condition walk.

Acceptance: Runtime modes should traverse package condition objects in declaration order and only accept active conditions for the mode. Type mode should prefer `types` explicitly.

Patch status: Fixed in `packages/engine/src/module-resolution.ts`.

### CF-07 [P1] repo-local file: URL imports are not governed as local imports

Labels: `bug`, `p1`, `engine`, `module-resolution`

Problem: A local `file:` URL import can be treated as external or unresolved instead of a repository-local source import.

Acceptance: Local file URL specifiers should decode through URL semantics and then pass through the normal root containment and ownership checks.

Patch status: Fixed in `packages/engine/src/module-resolution.ts`.

### CF-08 [P1] SQL DELETE is classified as read

Labels: `bug`, `p1`, `engine`, `resource-contracts`

Problem: Raw SQL `DELETE FROM` can be classified as a read, allowing it through read-only database contracts.

Acceptance: Mutating SQL verbs including delete, insert, update, merge, truncate, create, alter, drop, and replace must be classified as writes.

Patch status: Fixed in `packages/engine/src/resource-access.ts` and `packages/engine/src/python-analysis.ts`.

### CF-09 [P1] quoted SQL table names are missed

Labels: `bug`, `p1`, `engine`, `resource-contracts`

Problem: Quoted or schema-qualified SQL identifiers can produce zero resource observations.

Acceptance: SQL table extraction should normalize quoted identifiers and schema-qualified selectors for both read and write statements.

Patch status: Fixed in `packages/engine/src/resource-access.ts` and `packages/engine/src/python-analysis.ts`.

### CF-10 [P1] numeric fs.open/openSync write flags are classified as read

Labels: `bug`, `p1`, `engine`, `resource-contracts`

Problem: Numeric Node fs flags such as `O_WRONLY | O_CREAT` can be treated as read-only.

Acceptance: Numeric flags should be decoded with `fs.constants`, missing flags should default to read, known string read flags should stay read, and unknown explicit flag expressions should fail closed as write.

Patch status: Fixed in `packages/engine/src/resource-access.ts`.

### CF-11 [P1] task check misses staged changes and deletions

Labels: `bug`, `p1`, `engine`, `task-governance`

Problem: Task envelope checks can omit staged files and deleted files from the changed-file set.

Acceptance: The changed-file collector should include unstaged, staged, untracked, copied, deleted, modified, renamed, and type-changed files.

Patch status: Fixed in `packages/engine/src/advanced-governance.ts`.

### CF-12 [P1] official Stryker report source field is misread

Labels: `bug`, `p1`, `engine`, `mutation`

Problem: Official Stryker reports use `source` for source code content, but the parser can treat it as a file path and lose surviving mutants.

Acceptance: Mutation report parsing should prefer explicit file/path metadata and only treat `source` as a path when it is path-like and not source text.

Patch status: Fixed in `packages/engine/src/advanced-governance.ts`.

### CF-13 [P1] Baseline Action CODEOWNERS interpretation diverges from GitHub

Labels: `bug`, `p1`, `github-action`, `baseline-gate`

Problem: Baseline approval can diverge from GitHub CODEOWNERS behavior through wildcard matching, latest-match handling, ownerless rules, or multiple CODEOWNERS locations.

Acceptance: The Action should use the first existing CODEOWNERS file in GitHub's search order, apply latest-match-wins inside that file, support wildcard path matching, and treat ownerless matching lines as no approver.

Patch status: Fixed in `packages/github-action-baseline-gate/src/index.ts`; bundled output regenerated in `packages/github-action-baseline-gate/dist/index.js`.

Follow-up: Full GitHub team membership expansion remains a product/design issue because the current Action input and metadata explicitly support usernames only and reject team entries.

### CF-14 [P2] single-segment glob matching can still backtrack

Labels: `bug`, `p2`, `engine`, `performance`, `security`

Problem: Globstar matching is dynamic-programming based, but single path segments with many `*` characters were still compiled to backtracking regular expressions.

Acceptance: Segment-level matching should avoid regular-expression backtracking and stay bounded for star-heavy success and failure cases.

Patch status: Fixed in `packages/engine/src/glob.ts`, `packages/plugin-agent-budget/src/glob.ts`, and `packages/plugin-blast-radius/src/glob.ts`.

### CF-15 [P2] official OpenTelemetry evidence is always incomplete

Labels: `bug`, `p2`, `opentelemetry`, `runtime-evidence`

Problem: OpenTelemetry-converted evidence did not mark transcripts active, so engine checks rejected otherwise valid evidence as incomplete.

Acceptance: Converter output should include an active transcript status when producing complete evidence.

Patch status: Fixed in `packages/adapter-opentelemetry/src/index.ts`.

### CF-16 [P2] OpenTelemetry DDL/MERGE-like operations classify as read

Labels: `bug`, `p2`, `opentelemetry`, `resource-contracts`

Problem: Database operations such as DDL or merge/upsert can be mapped to read access.

Acceptance: Mutating database semantic operations should map to write, while explicit select/read/get-style operations remain read.

Patch status: Fixed in `packages/adapter-opentelemetry/src/index.ts`.

### CF-17 [P2] MCP write-tool override fails on tool-name casing

Labels: `bug`, `p2`, `mcp-proxy`

Problem: A CLI override such as `Edit=...` can coexist with the default lowercase `edit`, leaving the default path extractor ahead of the requested override.

Acceptance: Write-tool overrides should delete any existing case-insensitive key before applying the new entry.

Patch status: Fixed in `packages/mcp-proxy/src/index.ts`.

### CF-18 [P2] trace records percent-encoded file URL paths

Labels: `bug`, `p2`, `trace`, `runtime-evidence`

Problem: File URL selectors with spaces can be recorded with `%20`, producing selectors that do not match the real file path.

Acceptance: File URL selectors should decode through `fileURLToPath`.

Patch status: Fixed in `packages/trace/src/index.ts`.

### CF-19 [P2] bare directory ownership has inconsistent semantics

Labels: `bug`, `p2`, `engine`, `ownership`

Problem: Bare directory patterns can be interpreted differently by ownership lookup and glob matching.

Acceptance: Owning-cell resolution should use the same ownership helper used by the rest of the engine.

Patch status: Fixed in `packages/engine/src/analysis-context.ts`.

### CF-20 [P2] ownedPathPatterns count changes are not surfaced in baseline diff

Labels: `bug`, `p2`, `baseline-gate`

Problem: Changes to owned path pattern counts are absent from baseline approval deltas.

Acceptance: Baseline diff output should include owned path metadata changes so approval gates can see expansions or contractions.

Patch status: Fixed in `packages/engine/src/baseline-change-detector.ts`.

### CF-21 [P2] coverage hides explicit baseline read failures behind 100% success

Labels: `bug`, `p2`, `cli`, `coverage`

Problem: Explicit configuration input failures can be summarized as perfect coverage instead of a configuration failure.

Acceptance: Explicit manifest, baseline, or evidence path read/schema failures should produce configuration findings and exit before `fail-under` threshold handling.

Patch status: Fixed in `packages/cli/src/coverage-command.ts`, `packages/cli/src/coverage-walker.ts`, `packages/cli/src/coverage-sarif.ts`, and `packages/engine/src/analysis/coverage-collector.ts`.

### CF-22 [P2] deleted tests make commit evidence throw internally

Labels: `bug`, `p2`, `engine`, `commit-evidence`

Problem: Test deletion commits can make commit evidence inspect a file that no longer exists at the commit path.

Acceptance: Deleted test files should still count in declared test evidence but should not be loaded for skip/todo marker scanning.

Patch status: Fixed in `packages/engine/src/advanced-governance.ts`.

### CF-23 [P2] commit trailers cannot express an explicit empty test set

Labels: `bug`, `p2`, `engine`, `commit-evidence`

Problem: Values such as `none` can be treated as missing placeholders even when they intentionally declare an empty changed/test set.

Acceptance: Set-valued trailers should accept explicit empty-set tokens while still rejecting genuinely empty or comma-only values.

Patch status: Fixed in `packages/engine/src/advanced-governance.ts`.

### CF-24 [P2] stale local claim write lock cannot recover

Labels: `bug`, `p2`, `engine`, `claim-store`

Problem: A stale direct-write lock can block future writes even after the owning process is gone.

Acceptance: The local file backend should recover stale lock files only when they are older than the stale threshold and the recorded process is not alive.

Patch status: Fixed in `packages/engine/src/claims/backends/local-file.ts`.

### CF-25 [P2] Python stdlib modules are treated as new external deps

Labels: `bug`, `p2`, `engine`, `python`, `external-dependencies`

Problem: Common Python standard-library imports such as `random`, `socket`, and `email` can be treated as new external dependencies.

Acceptance: Python stdlib roots should not emit external dependency ratchet additions.

Patch status: Fixed in `packages/engine/src/external-dependencies.ts` for the hardcoded stdlib detector set.

## Remaining Follow-Up Issue

### CODEOWNERS team membership parity for baseline approvals

Labels: `enhancement`, `security`, `github-action`, `needs-design`

Problem: The Baseline Action currently documents and enforces username-only baseline approvers. GitHub CODEOWNERS also supports team entries, but resolving them requires additional GitHub API permissions, organization visibility handling, pagination, caching, and fail-closed behavior on partial API failures.

Acceptance: Decide whether the Action should support team owners. If yes, add explicit permissions documentation, resolve team membership at the protected base revision, fail closed on ambiguous or unavailable membership checks, and add API-stub integration tests for organization teams.
