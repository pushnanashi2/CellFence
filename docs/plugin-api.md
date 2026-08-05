# Plugin API v1

<!-- Moved from README.md to keep the repository root README concise. -->


CellFence v0.x includes `@cellfence/plugin-api`, a small stable API for programmatic rules, resource adapters, and reporters. The default CLI still works without plugin configuration:

```bash
npx cellfence check
```

Programmatic callers can pass plugins to `checkRepository`:

```ts
import { checkRepository } from "@cellfence/engine";
import { defineAdapter, definePlugin } from "@cellfence/plugin-api";

const companyDatabase = defineAdapter({
  name: "company-database",
  detect(context) {
    const accesses = [];
    // Inspect context.sourceFile with context.helpers and return CellFenceResourceAccess records.
    return accesses;
  }
});

const result = checkRepository({
  plugins: [
    definePlugin({
      apiVersion: 1,
      name: "@company/cellfence-plugin",
      version: "1.0.0",
      capabilities: { needsAst: true },
      adapters: [companyDatabase]
    })
  ]
});
```

Plugin adapters only translate framework-specific code into common resource access records. CellFence core still performs ownership, baseline, waiver, severity, and resource-contract enforcement. Plugin rules receive a read-only repository model containing file indexes, observed imports, detected resources, metrics, baseline, and changed files.

External npm/local plugin auto-loading from manifest or CLI input is intentionally not enabled in v0.x; loading arbitrary code from repository-controlled configuration conflicts with the fail-closed dynamic-import rule. To avoid false confidence, manifest `plugins` and `extends` are rejected instead of silently ignored. Trusted programmatic callers can pass already-imported plugins through `checkRepository({ plugins })`. When they use `checkChangedRepository`, they may provide a stable `pluginCacheKey`; without one, base-result caching is disabled so plugin code changes cannot reuse stale analysis.
