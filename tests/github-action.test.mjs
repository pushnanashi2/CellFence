import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const actionYaml = fs.readFileSync(path.join(root, "packages/github-action/action.yml"), "utf8");

test("GitHub Action wrapper does not assume CellFence source checkout in consumer repositories", () => {
  assert.doesNotMatch(actionYaml, /npm run build/);
  assert.doesNotMatch(actionYaml, /packages\/cli\/dist\/index\.js/);
  assert.match(actionYaml, /npx --yes cellfence@0\.1\.3 baseline check/);
  assert.match(actionYaml, /npx --yes cellfence@0\.1\.3 check/);
});
