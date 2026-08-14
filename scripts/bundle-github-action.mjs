// 0.4.x: bundle the github-action-baseline-gate action with
// `esbuild` so the published action is a single self-contained
// ESM file. esbuild follows the symlinked workspace packages and
// produces a single output without the chunked-asset pattern that
// `@vercel/ncc` ESM output uses; the resulting file can be
// invoked directly by the GitHub Actions runner as `node
// dist/index.js`.
//
// The action's source no longer imports `@cellfence/cli` or
// `@cellfence/engine` at runtime; the baseline-gate comparison
// logic is inlined in `packages/github-action-baseline-gate/src/baseline-gate.ts`
// so the bundle only inlines `@actions/core` and
// `@actions/github`. The output is a single ESM file at
// `dist/index.js` plus a small `package.json` that pins the
// ESM module type.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const actionRoot = path.join(repoRoot, "packages/github-action-baseline-gate");
const sourceEntry = path.join(actionRoot, "src/index.ts");
const outDir = path.join(actionRoot, "dist");

// Confirm the TypeScript source exists. The `tsc -b` step in the
// build script produces `dist/index.js` (used by Node.js
// workflows) and we overwrite it with the esbuild bundle so
// `action.yml` (which points to `dist/index.js`) picks up the
// distributable file.
if (!fs.existsSync(sourceEntry)) {
  console.error(`missing source entry: ${sourceEntry}`);
  process.exit(1);
}

const result = spawnSync("npx", [
  "esbuild", sourceEntry,
  "--bundle",
  "--platform=node",
  "--target=node20",
  // CommonJS is the format `@actions/core` ships in; ESM output
  // wraps its `require("os")` calls in a dynamic-require shim
  // that fails at runtime in pure ESM mode. CJS lets the bundle
  // resolve Node.js built-ins via standard `require` and is
  // supported by the GitHub Actions node20 runner.
  "--format=cjs",
  `--outfile=${outDir}/index.js`,
  "--sourcemap=external",
], { stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// The action is a single CommonJS file; remove the ESM type so
// the GitHub Actions runner loads it as CJS.
const pkgPath = path.join(actionRoot, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
delete pkg.type;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
