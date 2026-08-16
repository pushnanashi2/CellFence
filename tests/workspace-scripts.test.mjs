import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function workspacePackageDirs() {
  const packagesDir = path.join(root, "packages");
  return fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
    .filter((packageDir) => fs.existsSync(path.join(root, packageDir, "package.json")))
    .sort();
}

function packageDirsInScript(script) {
  return [...script.matchAll(/\bpackages\/[a-z0-9-]+/g)]
    .map((match) => match[0])
    .filter((packageDir, index, values) => values.indexOf(packageDir) === index)
    .sort();
}

test("root typecheck script covers every workspace package", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(packageDirsInScript(packageJson.scripts.typecheck), workspacePackageDirs());
});
