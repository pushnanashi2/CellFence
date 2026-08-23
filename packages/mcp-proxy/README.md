# @cellfence/mcp-proxy

`@cellfence/mcp-proxy` is a minimal runtime guard for MCP file-writing tools. It sits between an MCP client and a downstream MCP tool server, forwards read-only calls unchanged, and checks configured write tools against active CellFence claims before the downstream server sees the call.

## Investigation Notes

This package is implemented against the observed CellFence 0.3.0 interfaces rather than a guessed manifest shape.

- `npx cellfence@0.3.0 init` generates `cellfence.manifest.json` with `schemaVersion: "cellfence.manifest.v1"`, optional `governance`, and `cells[]` containing `id`, `ownedPaths`, `publicEntry`, `publicSymbols`, `consumes`, and `producesArtifacts`.
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
- `CELLFENCE_MCP_UNKNOWN_TOOL_POLICY`
- `CELLFENCE_MCP_READ_TOOLS` (comma-separated tool names)
- `CELLFENCE_MCP_AUDIT_LOG`
- `CELLFENCE_MCP_DOWNSTREAM_COMMAND`

## Modes

- `--mode enforce`: deny unclaimed writes before the downstream server receives them.
- `--mode dry-run`: log denied writes, but still forward them.
- `--mode off`: forward everything.

If policy cannot be evaluated, writes fail closed by default. Use `--fail-mode open` only for local experiments where availability is more important than containment.

Unconfigured tools remain allowed by default for backward compatibility. For a closed tool surface, use `--unknown-tool-policy deny` and explicitly allowlist read-only tools with repeatable `--read-tool NAME` flags. Configured write tools continue through CellFence write checks; tools in neither list are hidden from `tools/list` and denied in `enforce` mode. In `dry-run` mode, unknown tools are audited as `dry-run-deny` and forwarded.

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
cellfence-mcp-proxy \
  --agent codex-1 \
  --unknown-tool-policy deny \
  --read-tool read_file \
  --write-tool apply_edits=edits[].path \
  -- node server.js
```

Path keys use dot traversal for nested objects and `[]` for arrays. For example, `edits[].path` extracts every non-empty string path from `{ "edits": [{ "path": "src/a.ts" }, { "path": "src/b.ts" }] }`.

Or use a JSON config:

```json
{
  "unknownToolPolicy": "deny",
  "readTools": ["workspace.read", "workspace.search"],
  "writeTools": {
    "workspace.write": ["file_path"],
    "editor.applyEdits": ["edits[].path"]
  }
}
```

```bash
cellfence-mcp-proxy --agent codex-1 --tool-config cellfence-mcp-tools.json -- node server.js
```

With the default `allow` unknown-tool policy, unconfigured tools are treated as read-only and forwarded unchanged. Configured write tools that do not expose a path argument are denied in `enforce` mode when `--fail-mode closed` is active.

## MCP Feature Bridging

The proxy mirrors downstream resource, prompt, and completion capabilities when the installed MCP SDK and downstream server expose them. Resource listing, template listing, reads, subscriptions, prompt listing/retrieval, and completion requests are forwarded unchanged. Resource updates and resource, prompt, and tool list-change notifications are also relayed when the downstream server advertises those capabilities.

## Audit Log

Each tool decision appends one JSONL event:

```json
{"timestamp":"2026-07-15T00:00:00.000Z","agent":"codex-1","tool":"write_file","paths":["src/app/file.ts"],"decision":"deny","reason":"no active claim covers that path"}
```

The audit log is intentionally outside the MCP response path. It is for local or CI evidence collection, not a repository ledger.

## MVP Boundaries

This proxy does not perform prompt inspection, semantic sanitization, rate limiting, budget enforcement, or OS sandboxing. It also does not implement a live claim lease service. It assumes claims are already present in the configured CellFence claim store.

Runtime concurrency is limited to file-based claims. For multi-agent production use, pair this proxy with an external claim coordinator or serialize claim creation through CI.
