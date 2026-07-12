# @cellfence/engine

Repository analysis engine for CellFence. It validates cell ownership, public surfaces, declared dependencies, artifact lanes, resource access, baselines, runtime resource evidence, and active agent claim leases. It also projects per-cell or auto-allocated agent context, coupling graphs, suggested resolutions, and waiver requests so tools can read the allowed fence before editing. Programmatic callers can pass Plugin API v1 rules and adapters through `checkRepository({ plugins })`.

Most users should install the `cellfence` CLI package instead.

See the main CellFence README: https://github.com/pushnanashi2/CellFence#readme
