import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const publicTestHmac = "5a9f2b10da1af4fa5b8c02e7e3c478100ce2301cc12ee6ea2a2c7eae68882989";

function workflowText(name) {
  return fs.readFileSync(path.join(root, ".github", "workflows", name), "utf8");
}

test("release workflows use public-key baseline verification without publishing HMAC verifier material", () => {
  for (const workflowName of ["ci.yml", "release-verify.yml", "npm-publish.yml"]) {
    const text = workflowText(workflowName);
    assert.doesNotMatch(text, new RegExp(publicTestHmac), `${workflowName} must not contain the old public HMAC key`);
    assert.doesNotMatch(text, /CELLFENCE_BASELINE_HMAC_KEY/);
    assert.match(text, /CELLFENCE_BASELINE_ED25519_PUBLIC_KEY/);
  }
});

test("CI does not expose a repository-wide test waiver approver", () => {
  assert.doesNotMatch(workflowText("ci.yml"), /CELLFENCE_APPROVERS:\s*test-owner/);
});

test("CI scopes the public baseline verifier to the self-check command", () => {
  const text = workflowText("ci.yml");
  assert.doesNotMatch(text, /^env:\r?\n(?:[ ]{2}[A-Z0-9_]+:[\s\S]*?)*[ ]{2}CELLFENCE_BASELINE_ED25519_PUBLIC_KEY:/m);
});
