# Current Limitations

<!-- Moved from README.md to keep the repository root README concise. -->


Version 0.x is deliberately narrow:

- Node.js 20 or later;
- TypeScript and JavaScript repositories only;
- one public entry per cell;
- repository-local cells only;
- file-path artifact lanes only;
- selected static resource access and imported runtime evidence only; dynamic dataflow, arbitrary runtime broker behavior, and live database schema drift are not inferred;
- ORM, query builder, and broker-client support is adapter-scoped; unsupported libraries require a dedicated adapter or runtime evidence;
- ownership overlap detection is conservative and does not solve arbitrary glob intersection;
- public symbol analysis supports common TypeScript forms, not every possible re-export pattern;
- computed dynamic imports cannot be resolved statically;
- SARIF output is not implemented;
- a reusable externally pinned GitHub Action is not yet released;
- CellFence does not identify which particular agent wrote a changed file;
- CellFence does not prevent an agent from editing a path at runtime.

To enforce per-agent write permissions, combine CellFence with worktree isolation, filesystem or sandbox permissions, path-scoped task policy, and protected-branch CI.
