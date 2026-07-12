import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const cliPath = path.join(root, "packages/cli/dist/index.js");

function runCli(args, cwd = root) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("CLI check returns zero for a valid fixture", () => {
  const fixturePath = path.join(root, "fixtures/valid/single-cell");
  const result = runCli(["check", "--json"], fixturePath);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"ok": true/);
});

test("CLI check returns one for governance violations", () => {
  const fixturePath = path.join(root, "fixtures/invalid/private-cross-cell-import");
  const result = runCli(["check", "--json"], fixturePath);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CELLFENCE_PRIVATE_IMPORT/);
});

test("CLI check returns two for manifest configuration errors", () => {
  const fixturePath = path.join(root, "fixtures/invalid/malformed-manifest");
  const result = runCli(["check", "--json"], fixturePath);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /CELLFENCE_MANIFEST_INVALID/);
});
