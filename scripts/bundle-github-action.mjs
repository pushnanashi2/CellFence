// 0.4.x: bundle the github-action-baseline-gate action with
// `esbuild` so the published action is a single self-contained
// CommonJS file. esbuild follows the symlinked workspace packages and
// produces a single output without the chunked-asset pattern that
// `@vercel/ncc` output used; the resulting file can be
// invoked directly by the GitHub Actions runner as `node
// dist/index.js`.
//
// The action's source no longer imports `@cellfence/cli` at runtime.
// The baseline-gate comparison glue delegates to `@cellfence/engine`
// and esbuild inlines that dependency into `dist/index.js` alongside
// `@actions/core` and `@actions/github`.

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { build, formatMessages } from "esbuild";

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

try {
  const result = await build({
    entryPoints: [sourceEntry],
    bundle: true,
    platform: "node",
    target: "node20",
    // CommonJS is the format `@actions/core` ships in; ESM output
    // wraps its `require("os")` calls in a dynamic-require shim
    // that fails at runtime in pure ESM mode. CJS lets the bundle
    // resolve Node.js built-ins via standard `require` and is
    // supported by the GitHub Actions node20 runner.
    format: "cjs",
    outfile: path.join(outDir, "index.js"),
    sourcemap: "external",
    minify: true,
    logLevel: "silent",
  });
  if (result.warnings.length > 0) {
    const messages = await formatMessages(result.warnings, { kind: "warning", color: false });
    console.error(messages.join("\n"));
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

for (const generatedPath of [path.join(outDir, "index.js"), path.join(outDir, "index.js.map")]) {
  const generated = fs.readFileSync(generatedPath, "utf8");
  fs.writeFileSync(generatedPath, generated.replace(/[ \t]+$/gm, ""));
}

const baselineGateEntrypoint = path.join(outDir, "baseline-gate.js");
if (fs.existsSync(baselineGateEntrypoint)) {
  const generated = fs.readFileSync(baselineGateEntrypoint, "utf8")
    .replace(/^\/\/ Stryker (?:disable|restore) all:.*\n/gm, "");
  const prologueStart = generated.indexOf("Object.defineProperty(exports, \"__esModule\"");
  const prologueEnd = generated.indexOf("function readBaselineFromGit");
  if (prologueStart === -1 || prologueEnd === -1 || prologueStart >= prologueEnd) {
    console.error("could not locate baseline-gate CommonJS prologue for mutation annotations");
    process.exit(1);
  }
  const beforePrologue = generated.slice(0, prologueStart);
  const prologue = generated.slice(prologueStart, prologueEnd);
  const afterPrologue = generated.slice(prologueEnd);
  fs.writeFileSync(
    baselineGateEntrypoint,
    `${beforePrologue}`
      + "// Stryker disable all: generated CommonJS export/import prologue; gate policy logic starts below.\n"
      + prologue
      + "// Stryker restore all: resume mutation testing for baseline gate policy logic.\n"
      + afterPrologue,
  );
}

// The action package intentionally omits `"type": "module"` so the
// GitHub Actions runner loads the bundled `dist/index.js` as CommonJS.
// Keep that source contract explicit instead of mutating package.json
// during the build.
const pkgPath = path.join(actionRoot, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
if (Object.hasOwn(pkg, "type")) {
  console.error(`${path.relative(repoRoot, pkgPath)} must not declare "type"; the bundled action is CommonJS`);
  process.exit(1);
}
