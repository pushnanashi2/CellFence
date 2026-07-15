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

External npm/local plugin auto-loading from manifest `plugins` is intentionally not enabled in v0.x; loading arbitrary code from config needs a separate trust decision. To avoid false confidence, manifest `plugins` and `extends` are rejected in manifest v1 instead of being silently ignored. Programmatic callers can still pass plugins directly through `checkRepository({ plugins })`.
