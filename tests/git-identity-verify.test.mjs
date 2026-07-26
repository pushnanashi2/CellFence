import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const scriptPath = path.join(root, "scripts", "git-identity-verify.mjs");
const placeholderEmail = ["your-email", "example.com"].join("@");
const fixedLogin = ["push", "nanashi2"].join("");
const fixedName = ["Push", "NaNaShi"].join("");
const fixedEmail = ["84632330", `${fixedLogin}@users.noreply.github.com`].join("+");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function git(cwd, args) {
  return run("git", args, { cwd });
}

function runVerify(cwd, env = {}) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

function createRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repo, ["init"]);
  return repo;
}

test("git identity verify rejects placeholder local identity", () => {
  const repo = createRepo("cellfence-git-identity-placeholder-");
  try {
    git(repo, ["config", "user.name", "an"]);
    git(repo, ["config", "user.email", placeholderEmail]);

    const result = runVerify(repo, { CI: "" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /git user\.name is still a placeholder/);
    assert.match(result.stderr, /git user\.email is still a placeholder/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("git identity verify accepts placeholder history only when mailmap remaps it", () => {
  const repo = createRepo("cellfence-git-identity-mailmap-");
  try {
    fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");
    git(repo, ["config", "user.name", "an"]);
    git(repo, ["config", "user.email", placeholderEmail]);
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "--quiet", "-m", "placeholder identity"]);

    git(repo, ["config", "user.name", fixedName]);
    git(repo, ["config", "user.email", fixedEmail]);
    fs.writeFileSync(path.join(repo, ".mailmap"), `${fixedName} <${fixedEmail}> <${placeholderEmail}>\n`);

    const result = runVerify(repo, { CI: "true" });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /git identity verification passed/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
