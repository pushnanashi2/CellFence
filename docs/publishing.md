# Publishing And Supply Chain

CellFence is not published from this repository automatically. The repository intentionally has no publish workflow and no `publish` npm script. Maintainers must run the release verification gates, configure external trust settings, and then perform the registry publish from an approved workflow. Do not use these instructions to publish from an ordinary development shell.

## Current Status

| area | status | notes |
|---|---|---|
| npm package metadata | ready | Workspace packages have `publishConfig.access: public` where needed and package versions are kept in lockstep. |
| Fresh install smoke | enforced | `npm run pack:smoke --silent` packs every workspace package, installs the tarballs into a temporary consumer, and runs the CLI. |
| Forbidden source scan | enforced | `npm run provenance:scan --silent` checks the source tree for known private provenance terms before release. |
| npm trusted publishing | documented | External npm package trust settings and a dedicated GitHub workflow are still required. |
| npm provenance attestations | documented | Trusted publishing should produce provenance automatically; token-based fallback must use provenance explicitly. |
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

Before adding a publish workflow, configure npm trusted publishing for every public package name in the workspace. The trusted publisher must point at the exact GitHub repository, workflow file, and protected environment that will be allowed to publish.

The publish job should use:

- GitHub-hosted `ubuntu-latest` runner.
- Node.js `22.14.0` or newer.
- npm `11.5.1` or newer.
- `permissions: { contents: read, id-token: write }`.
- A protected GitHub Environment such as `npm-publish` with required reviewers.
- Exact version install and the same pre-publish gate above before any registry command.

Trusted publishing is preferred because it avoids long-lived npm tokens. With trusted publishing, npm provenance is expected to be generated automatically by npm. If a maintainer temporarily falls back to token-based publishing, the publish command must explicitly include provenance and public access for first-time scoped packages:

```bash
npm publish --provenance --access public
```

Do not put this command in a root npm script during v0.x; `release:verify` intentionally fails if the root package defines a publish script.

## SBOM

Generate the CycloneDX SBOM after the lockfile is final:

```bash
npm run sbom:generate --silent
```

Attach `reports/sbom.cdx.json` to the GitHub Release. The `reports/` directory remains ignored so generated release artifacts do not churn the source tree.

## GitHub Release

After the release commit is pushed and CI is green:

1. Create a signed tag, for example `v0.1.12`.
2. Draft release notes from `CHANGELOG.md`.
3. Attach the SBOM and any generated package provenance or attestation artifacts.
4. Link the successful CI run and the exact commit SHA.

The GitHub Release is evidence for humans. The npm package provenance and signed baseline approval workflow are the machine-verifiable pieces.
