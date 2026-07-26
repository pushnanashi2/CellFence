import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(".");
const scriptPath = path.join(repoRoot, "scripts", "forbidden-source-scan.mjs");

function runScan(cwd) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

test("forbidden source scan rejects a blocked reviewer term but permits the related advisory word", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-forbidden-scan-"));
  try {
    const blockedTerm = ["ad", "visor"].join("");
    const allowedWord = `${blockedTerm}y`;
    fs.writeFileSync(path.join(rootDir, "safe.json"), `{"symbol":"reindex${allowedWord[0].toUpperCase()}${allowedWord.slice(1)}"}\n`);
    let result = runScan(rootDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    fs.writeFileSync(path.join(rootDir, "unsafe.md"), `contact the ${blockedTerm} before release\n`);
    result = runScan(rootDir);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, new RegExp(`unsafe\\.md: forbidden term '${blockedTerm}'`));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("forbidden source scan checks mailmap but allows legacy placeholder remaps", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-forbidden-mailmap-"));
  try {
    const login = ["push", "nanashi2"].join("");
    const name = ["Push", "NaNaShi"].join("");
    const replacementEmail = ["84632330", `${login}@users.noreply.github.com`].join("+");
    const placeholderEmail = ["your-email", "example.com"].join("@");

    fs.writeFileSync(path.join(rootDir, ".mailmap"), `${name} <${replacementEmail}> <${placeholderEmail}>\n`);
    let result = runScan(rootDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const blockedName = ["koe", "noki"].join("");
    fs.writeFileSync(path.join(rootDir, ".mailmap"), `${blockedName} <${replacementEmail}> <${placeholderEmail}>\n`);
    result = runScan(rootDir);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, new RegExp(`\\.mailmap: forbidden term '${blockedName}'`));

    fs.writeFileSync(path.join(rootDir, ".mailmap"), `Broken Identity <${placeholderEmail}>\n`);
    result = runScan(rootDir);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /\.mailmap: forbidden term 'your-email@example\.com'/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
