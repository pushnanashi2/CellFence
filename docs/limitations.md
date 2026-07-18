# Current Limitations

<!-- Moved from README.md to keep the repository root README concise. -->


Version 0.x is deliberately narrow:

- Node.js 20 or later;
- strongest static source analysis for TypeScript and JavaScript; Python support covers `.py` source ownership, AST-based import extraction, public symbols, public-surface hashes, selected Django/FastAPI/SQLAlchemy/Celery resource patterns, and common `pyproject.toml`, `setup.cfg`, and static `setup.py` package roots;
- one public entry per cell;
- repository-local cells only;
- file-path artifact lanes only;
- selected static resource access and imported runtime evidence only; dynamic dataflow, arbitrary runtime broker behavior, and live database schema drift are not inferred;
- ORM, query builder, and broker-client support is adapter-scoped; unsupported libraries require a dedicated adapter or runtime evidence;
- ownership overlap detection is segment-aware for literal path prefixes, but does not solve arbitrary glob intersection;
- public symbol analysis supports common TypeScript forms and Python AST top-level declarations / literal `__all__`, not every possible dynamic export pattern;
- computed dynamic imports cannot be resolved statically;
- `check --changed` still performs full head/base repository analysis in v0.x, then compares stable finding fingerprints to report only newly introduced findings;
- Markdown and SARIF output are report formats over the same deterministic findings, not separate analyzers;
- the reusable GitHub Action is pre-release and invokes the published CLI pinned to the package version verified by `npm run release:verify`;
- CellFence does not identify which particular agent wrote a changed file;
- CellFence does not prevent an agent from editing a path at runtime.

To enforce per-agent write permissions, combine CellFence with worktree isolation, filesystem or sandbox permissions, path-scoped task policy, and protected-branch CI.
