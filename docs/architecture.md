# Architecture

CellFence is split into four cells:

```text
schema <- engine <- cli
          ^
          |
    github-action
```

## Schema

The schema package defines TypeScript types, manifest constants, baseline constants, and runtime validators for JSON manifests. It has no internal dependency on the engine, CLI, or action cell.

## Engine

The engine loads manifests, parses source files with the TypeScript compiler API, extracts import and export declarations, resolves repository-local dependencies, and emits structured findings.

The engine owns rule evaluation. It is the only cell that knows about:

- ownership overlap;
- public entry validation;
- private import rejection;
- artifact lane consumption;
- baseline ratchets.

## CLI

The CLI is the public command surface. It translates process arguments into engine calls and maps results to documented exit codes.

## GitHub Action

The action wrapper calls the engine from GitHub Actions. It does not implement separate policy logic.

## Dependency Direction

`schema` must not import other CellFence cells. `engine` may import `schema`. `cli` may import `engine`. `github-action` may import `engine`. Reverse private dependencies are rejected by CellFence self-check.
