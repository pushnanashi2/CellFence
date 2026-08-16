# @cellfence/github-action

GitHub Action entrypoint package for CellFence checks.

The reusable Action runs the published npm CLI. `version` defaults to the
package's current exact release (`0.2.1`) so required checks are
reproducible. Override it only when intentionally testing a different
published CLI version:

```yaml
- uses: OWNER/REPOSITORY/packages/github-action@v0.1.13
  with:
    version: 0.1.13
    manifest: cellfence.manifest.json
    baseline: cellfence.baseline.json
```

See the main CellFence README: https://github.com/pushnanashi2/CellFence#readme
