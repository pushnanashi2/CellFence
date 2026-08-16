// Copy non-TypeScript build artifacts into each `dist/` directory so the
// GitHub Action distributables are self-contained. `tsc -b` only emits
// `.js` / `.d.ts` files, so we have to ship the action metadata files
// (`action.yml`, `package.json`, `README.md`, `LICENSE`) alongside the
// compiled JavaScript that `action.yml` points at via `runs.main`.
//
// Without this step the published action directory is missing the
// `action.yml` manifest that the GitHub Actions runner looks up when
// `using: node20` and `main: dist/index.js` is referenced.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const actionPackages = [
  "packages/github-action",
  "packages/github-action-baseline-gate",
];

// Files at the package root that must be mirrored into `dist/` for
// the action to be a self-contained distributable.
const artifacts = ["action.yml", "package.json", "README.md", "LICENSE"];

for (const relPackage of actionPackages) {
  const packageRoot = path.join(repoRoot, relPackage);
  if (!fs.existsSync(packageRoot)) {
    continue;
  }
  const distDir = path.join(packageRoot, "dist");
  if (!fs.existsSync(distDir)) {
    // tsc has not produced a dist/ for this package yet; nothing to copy.
    continue;
  }
  for (const artifact of artifacts) {
    const source = path.join(packageRoot, artifact);
    if (!fs.existsSync(source)) {
      continue;
    }
    const destination = path.join(distDir, artifact);
    fs.copyFileSync(source, destination);
  }
}
