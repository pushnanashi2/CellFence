# cellfence

> **AI coding agents do not need more prompts. They need enforceable architectural boundaries.**

CellFence turns architectural intent into deterministic CLI and CI checks for repositories edited by parallel coding agents and humans: cell ownership, declared dependencies, public entry points, resource contracts, and one-way growth ratchets. The governance core is language-agnostic; v0.x has first-class TypeScript/JavaScript analysis and AST-based Python import/public-surface support.

## Sixty seconds

```bash
npm install --save-dev cellfence
npx cellfence init                              # writes cellfence.manifest.json
mkdir -p src/example
echo 'export const example = 1;' > src/example/public.ts
npx cellfence check
```

```text
CellFence check passed.
```

When a cell imports another cell's internals instead of its declared public entry:

```text
CellFence check failed.
[error] CELLFENCE_PRIVATE_IMPORT src/reporting/bad.ts: reporting imports private implementation from parser
```

## Commands

<!-- Keep in sync with `cellfence --help`; a drift here already shipped once -->

```bash
npx cellfence init
npx cellfence check [--changed --base origin/main] [--json]
npx cellfence context --cell <id> [--json|--format agents-md]
npx cellfence context --auto-allocate --task "task text" [--json]
npx cellfence install --target agents-md --file AGENTS.md [--check|--uninstall]
npx cellfence serve --mcp
npx cellfence graph [--format mermaid|--json]
npx cellfence claim create --agent <id> --cell <id> --ttl 2h
npx cellfence claim check --agent <id>
npx cellfence baseline create|check|update
npx cellfence evidence check --evidence resource-evidence.json
npx cellfence waivers list|request
```

Exit codes: `0` no violations · `1` governance violations · `2` configuration or manifest error · `3` internal tool error.

## For coding agents

`context --format agents-md` emits a per-cell contract (owned paths, allowed imports, allowed resources, guidance) ready to pass into an agent's context. `install` writes a checksumed managed block into `AGENTS.md` or `CLAUDE.md`, and `install --check` fails when that block drifts or unmanaged CellFence instructions appear outside it.

MCP-capable agents can run `cellfence serve --mcp` and call `get_cell_context`, `check_change`, `create_claim`, and `explain_finding` over stdio. `check` and `baseline check` remain the deterministic completion signal.

## Learn more

Full documentation, comparison with adjacent tools, ratchet design, and threat model: **https://github.com/pushnanashi2/CellFence#readme**

Requires Node.js ≥ 20. License: Apache-2.0.
