# @cellfence/github-action

GitHub Action entrypoint package for CellFence checks.

The reusable Action runs the published npm CLI. `version` defaults to npm `latest` so the repository `main` branch never depends on an unpublished release-preparation version. For required checks, pin an exact published version:

```yaml
- uses: OWNER/REPOSITORY/packages/github-action@v0.1.13
  with:
    version: 0.1.13
    manifest: cellfence.manifest.json
    baseline: cellfence.baseline.json
```

See the main CellFence README: https://github.com/pushnanashi2/CellFence#readme
