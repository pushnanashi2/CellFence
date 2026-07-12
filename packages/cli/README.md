# cellfence

CellFence CLI for manifest-driven repository architecture governance.

```bash
npx cellfence check
npx cellfence check --changed --base origin/main
npx cellfence context --cell example --json
npx cellfence context --auto-allocate --task "change the reporting cell" --json
npx cellfence graph --format mermaid
npx cellfence baseline create
npx cellfence baseline check
npx cellfence waivers list
npx cellfence waivers request --rule CELLFENCE_PRIVATE_IMPORT --file src/example.ts --line 7 --expires 2099-01-01 --reason "temporary migration"
```

See the main CellFence README: https://github.com/pushnanashi2/CellFence#readme
