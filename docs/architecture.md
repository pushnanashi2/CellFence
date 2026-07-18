# Architecture

CellFence dogfoods its own manifest. The current repository is a package-level cell graph rather than the original four-cell prototype.

The enforced source of truth is `cellfence.manifest.json`; this document is a human-readable map of that manifest.

## Core Cells

- `schema`: versioned manifest, baseline, evidence, and validation types. It has no CellFence-internal dependencies.
- `plugin-api`: stable Plugin API v1 types and `define*` helpers. It depends only on `schema`.
- `engine`: repository indexing, source analysis, resource adapters, rule evaluation, baselines, claims, changed checks, docs checks, and manifest inference. It depends on `schema`.
- `cli`: process argument parsing, human/JSON output, audit/summary artifacts, and command dispatch. It depends on `engine`.
- `github-action`: thin GitHub Action wrapper around the engine/CLI policy. It depends on `engine`.

## Agent And Runtime Cells

- `mcp-proxy`: stdio MCP write guard and proxy helpers. It depends on `engine`.
- `trace`: runtime evidence producer for selected Node.js file/fetch/manual resource observations. It depends on `schema`.

## Official Extension Cells

Adapters:

- `adapter-call-pattern`: declarative static call-pattern resource adapter. It depends on `plugin-api` and `schema`.
- `adapter-opentelemetry`: OpenTelemetry span to resource-evidence converter. It depends on `schema`.

Rule plugins:

- `plugin-agent-budget`
- `plugin-blast-radius`
- `plugin-dependency-sovereignty`
- `plugin-geo-purity`
- `plugin-legacy-strangler`
- `plugin-quants-trend`

These rule plugins depend on `plugin-api`; `plugin-quants-trend` also depends on `schema` for baseline-shaped metrics.

Reporter:

- `reporter-economy-matrix`: architecture flow reporter. It depends on `plugin-api`.

## Dependency Direction

The intended direction is:

```text
schema
  <- plugin-api
  <- official adapters / official plugins / reporter

schema <- engine <- cli
                 <- github-action
                 <- mcp-proxy

schema <- trace
```

Reverse private dependencies are rejected by CellFence self-check. Public imports must go through each cell's declared `publicEntry`.

## Generated Views

For an up-to-date graph, run:

```bash
npx cellfence graph --format mermaid
```

The README self-governance diagram is generated from this command and should be refreshed whenever `cellfence.manifest.json` changes.
