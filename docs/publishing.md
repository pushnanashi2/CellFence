# Publishing And Supply Chain

CellFence is not published from this repository automatically. The repository has a manual `npm-publish.yml` workflow, but it defaults to `dry_run=true`, requires a `v*` tag ref, and uses the protected `npm-publish` environment before any registry command. The root package intentionally has no `publish` npm script. Do not publish from an ordinary development shell.

## Current Status

| area | status | notes |
|---|---|---|
| npm package metadata | ready | Workspace packages have `publishConfig.access: public` where needed and package versions are kept in lockstep. |
| Fresh install smoke | enforced | `npm run pack:smoke --silent` packs every workspace package, installs the tarballs into a temporary consumer, and runs the CLI. |
| Forbidden source scan | enforced | `npm run provenance:scan --silent` checks the source tree for known private provenance terms before release. |
| npm trusted publishing | configured for publish set | `.github/workflows/npm-publish.yml` uses GitHub OIDC, Node 24, npm trusted publishing, and the protected `npm-publish` environment; package-level Trusted Publisher settings are external and must stay aligned with the publish set. |
| npm provenance attestations | configured through trusted publishing | Trusted publishing is the preferred publish path and should produce provenance automatically; token-based fallback must use provenance explicitly. |
| SBOM | implemented locally | `npm run sbom:generate --silent` writes `reports/sbom.cdx.json` without contacting the registry. |
| GitHub Release | documented | Release notes and artifacts are created manually after CI passes for the release commit. |

## Version Policy

During `0.x`, keep all workspace package versions identical. Use:

```bash
npm version <next-version> --workspaces --include-workspace-root --no-git-tag-version
npm install --ignore-scripts
```

After changing the version, verify that every internal `cellfence` or `@cellfence/*` dependency in package manifests and `package-lock.json` points at the same version. Do not let the lockfile pull a previously published `@cellfence/*` version into a workspace package.

Use patch bumps for compatible implementation, fixture, and documentation hardening. Use minor bumps for CLI flag/schema changes that consumers must consciously adopt while the project remains pre-1.0.

## Pre-Publish Gate

Run these commands before creating a release commit or tag:

```bash
npm run build --silent
npm run typecheck --silent
npm run lint --silent
npm test --silent
npm run release:verify --silent
npm run provenance:scan --silent
npm run cellfence:self-check --silent
npm run pack:smoke --silent
npm run sbom:generate --silent
git diff --check
```

`npm run pack:smoke --silent` is the fresh install smoke. It uses local tarballs and does not publish anything.

## Trusted Publishing Setup

Configure npm trusted publishing for every package in the publish set before running `dry_run=false`. The trusted publisher must point at the exact GitHub repository, workflow file, and protected environment that will be allowed to publish:

- GitHub owner: the repository owner configured in npm Trusted Publisher settings
- GitHub repository: this repository name
- Workflow filename: `npm-publish.yml`
- Environment: `npm-publish`
- Allowed action: `npm publish`

The publish job should use:

- GitHub-hosted `ubuntu-latest` runner.
- Node.js `22.14.0` or newer.
- npm `11.5.1` or newer.
- `permissions: { contents: read, id-token: write }`.
- The protected GitHub Environment `npm-publish` with required reviewers.
- Exact version install and the same pre-publish gate above before any registry command.

Trusted publishing is preferred because it avoids long-lived npm tokens. With trusted publishing, npm provenance is expected to be generated automatically by npm. If a maintainer temporarily falls back to token-based publishing, the publish command must explicitly include provenance and public access for first-time scoped packages:

```bash
npm publish --provenance --access public
```

Do not put this command in a root npm script during v0.x; `release:verify` intentionally fails if the root package defines a publish script.

## Publish Workflow

Create and push the release tag only after the release commit and CI are green:

```bash
git tag -s v0.1.13 -m "CellFence v0.1.13"
git push origin v0.1.13
```

Run the workflow in dry-run mode first. This performs all release gates, regenerates the ignored SBOM, and executes `npm publish --dry-run` for every package in the publish set:

```bash
gh workflow run npm-publish.yml --repo OWNER/REPOSITORY --ref v0.1.13 -f dry_run=true
```

For the real publish, use the same tag ref, set `dry_run=false`, enter the exact confirmation string, and approve the `npm-publish` environment deployment:

```bash
gh workflow run npm-publish.yml --repo OWNER/REPOSITORY --ref v0.1.13 -f dry_run=false -f confirm_publish="publish 0.1.13"
```

The workflow preflight checks that every package in the publish set is visible on npm before `dry_run=false`. `@cellfence/mcp-proxy` remains covered by `pack:smoke`, but it is held out of the registry publish set because npm Trusted Publisher configuration requires an existing package page. Resolve its first-publish path separately before adding it to `npm-publish.yml`; do not add a repository `NPM_TOKEN` as a shortcut.

## SBOM

Generate the CycloneDX SBOM after the lockfile is final:

```bash
npm run sbom:generate --silent
```

Attach `reports/sbom.cdx.json` to the GitHub Release. The `reports/` directory remains ignored so generated release artifacts do not churn the source tree.

## GitHub Release

After the release commit is pushed and CI is green:

1. Create a signed tag, for example `v0.1.13`.
2. Draft release notes from `CHANGELOG.md`.
3. Attach the SBOM and any generated package provenance or attestation artifacts.
4. Link the successful CI run and the exact commit SHA.

The GitHub Release is evidence for humans. The npm package provenance and signed baseline approval workflow are the machine-verifiable pieces.
