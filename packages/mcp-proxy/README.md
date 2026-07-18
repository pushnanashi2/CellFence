# @cellfence/mcp-proxy

`@cellfence/mcp-proxy` is a minimal runtime guard for MCP file-writing tools. It sits between an MCP client and a downstream MCP tool server, forwards read-only calls unchanged, and checks configured write tools against active CellFence claims before the downstream server sees the call.

## Investigation Notes

This package was implemented against the observed CellFence 0.1.12 interfaces rather than a guessed manifest shape.

- `npx cellfence@0.1.12 init` generates `cellfence.manifest.json` with `schemaVersion: "cellfence.manifest.v1"`, optional `governance`, and `cells[]` containing `id`, `ownedPaths`, `publicEntry`, `publicSymbols`, `consumes`, and `producesArtifacts`.
- `cellfence serve --mcp` currently exposes `get_cell_context`, `check_change`, `create_claim`, and `explain_finding`. Those tools are useful for agent context and repository checks, but they are not a direct "may this agent write this path now?" oracle.
- `@cellfence/engine` exposes stable repository and claim helpers such as `createCellContext`, `checkClaims`, `checkRepository`, and `checkChangedRepository`. This package adds and uses `checkWriteAccess`, which evaluates one or more candidate write paths against active claim coverage using the engine's existing CellFence manifest and glob matching behavior.
- The MVP therefore uses direct engine calls for policy decisions. That path is deterministic, avoids shelling out per tool call, and avoids proxying CellFence through a second MCP server.

## Usage

Wrap a downstream stdio MCP server:

```bash
cellfence-mcp-proxy \
  --agent codex-1 \
  --root /path/to/repo \
  --claims .cellfence/claims.json \
  --audit-log .cellfence/mcp-audit.jsonl \
  -- node downstream-mcp-server.js
```

Equivalent explicit downstream flags:

```bash
cellfence-mcp-proxy \
  --agent codex-1 \
  --downstream-command node \
  --downstream-arg downstream-mcp-server.js
```

Environment variables:

- `CELLFENCE_AGENT`
- `CELLFENCE_MCP_MODE`
- `CELLFENCE_MCP_FAIL_MODE`
- `CELLFENCE_MCP_AUDIT_LOG`
- `CELLFENCE_MCP_DOWNSTREAM_COMMAND`

## Modes

- `--mode enforce`: deny unclaimed writes before the downstream server receives them.
- `--mode dry-run`: log denied writes, but still forward them.
- `--mode off`: forward everything.

If policy cannot be evaluated, writes fail closed by default. Use `--fail-mode open` only for local experiments where availability is more important than containment.

## Write Tool Mapping

The default write tools are:

- `write_file`
- `create_file`
- `edit_file`
- `apply_patch`
- `str_replace`

Default path keys are `path`, `file_path`, and `filename`.

Override a tool on the command line:

```bash
cellfence-mcp-proxy --agent codex-1 --write-tool write_file=target.path -- node server.js
```

Or use a JSON config:

```json
{
  "writeTools": {
    "workspace.write": ["file_path"],
    "editor.replace": ["target.path"]
  }
}
```

```bash
cellfence-mcp-proxy --agent codex-1 --tool-config cellfence-mcp-tools.json -- node server.js
```

Unconfigured tools are treated as read-only and forwarded unchanged. Configured write tools that do not expose a path argument are denied in `enforce` mode when `--fail-mode closed` is active.

## Audit Log

Each tool decision appends one JSONL event:

```json
{"timestamp":"2026-07-15T00:00:00.000Z","agent":"codex-1","tool":"write_file","paths":["src/app/file.ts"],"decision":"deny","reason":"no active claim covers that path"}
```

The audit log is intentionally outside the MCP response path. It is for local or CI evidence collection, not a repository ledger.

## MVP Boundaries

This proxy does not perform prompt inspection, semantic sanitization, rate limiting, budget enforcement, or OS sandboxing. It also does not implement a live claim lease service. It assumes claims are already present in the configured CellFence claim store.

Runtime concurrency is limited to file-based claims. For multi-agent production use, pair this proxy with an external claim coordinator or serialize claim creation through CI.
