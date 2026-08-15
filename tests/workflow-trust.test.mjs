import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const publicTestHmac = "5a9f2b10da1af4fa5b8c02e7e3c478100ce2301cc12ee6ea2a2c7eae68882989";

function workflowText(name) {
  return fs.readFileSync(path.join(root, ".github", "workflows", name), "utf8");
}

test("release workflows do not publish the baseline HMAC verifier secret", () => {
  for (const workflowName of ["ci.yml", "release-verify.yml", "npm-publish.yml"]) {
    const text = workflowText(workflowName);
    assert.doesNotMatch(text, new RegExp(publicTestHmac), `${workflowName} must not contain the old public HMAC key`);
    assert.match(text, /CELLFENCE_BASELINE_HMAC_KEY:\s*\$\{\{\s*secrets\.CELLFENCE_BASELINE_HMAC_KEY\s*\}\}/);
  }
});

test("CI does not expose a repository-wide test waiver approver", () => {
  assert.doesNotMatch(workflowText("ci.yml"), /CELLFENCE_APPROVERS:\s*test-owner/);
});
