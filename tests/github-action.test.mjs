import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const actionYaml = fs.readFileSync(path.join(root, "packages/github-action/action.yml"), "utf8");
const actionEntrypoint = path.join(root, "packages/github-action/dist/index.js");

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeValidProject(tempDir, { writeDefaultManifest = false } = {}) {
  fs.mkdirSync(path.join(tempDir, "src/core"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "src/core/public.ts"), "export const ok = true;\n");
  const manifest = {
    schemaVersion: "cellfence.manifest.v1",
    cells: [
      {
        id: "core",
        ownedPaths: ["src/core/**"],
        publicEntry: "src/core/public.ts",
        publicSymbols: ["ok"],
        consumes: [],
        producesArtifacts: [],
      },
    ],
  };
  writeJson(path.join(tempDir, "custom-manifest.json"), manifest);
  if (writeDefaultManifest) {
    writeJson(path.join(tempDir, "cellfence.manifest.json"), manifest);
  }
}

test("GitHub Action wrapper does not assume CellFence source checkout in consumer repositories", () => {
  assert.doesNotMatch(actionYaml, /npm run build/);
  assert.doesNotMatch(actionYaml, /packages\/cli\/dist\/index\.js/);
  assert.match(actionYaml, /npx --yes cellfence@0\.1\.9 baseline check/);
  assert.match(actionYaml, /npx --yes cellfence@0\.1\.9 check/);
  assert.match(actionYaml, /check --manifest "\$\{\{ inputs\.manifest \}\}" "\$\{evidence_args\[@\]\}"/);
});

test("GitHub Action entrypoint reads action inputs and runs the repository check", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-action-main-"));
  writeValidProject(tempDir);

  const result = spawnSync(process.execPath, [actionEntrypoint], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      INPUT_MANIFEST: "custom-manifest.json",
      INPUT_BASELINE: "   ",
      INPUT_: "missing-baseline.json",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CellFence check passed\./);
});

test("GitHub Action entrypoint uses the documented default manifest path", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-action-default-"));
  writeValidProject(tempDir, { writeDefaultManifest: true });

  const result = spawnSync(process.execPath, [actionEntrypoint], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "INPUT_MANIFEST")),
      INPUT_BASELINE: "   ",
      INPUT_: "missing-manifest.json",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CellFence check passed\./);
});

test("GitHub Action entrypoint has no side effect when imported", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-action-import-"));
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(pathToFileURL(actionEntrypoint).href)}); console.log("imported-only");`,
  ], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      INPUT_MANIFEST: "missing-manifest.json",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "imported-only");
});

test("GitHub Action entrypoint import treats unresolved argv paths as not direct execution", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-action-import-missing-argv-"));
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `process.argv[1] = "missing-action-entrypoint.js"; await import(${JSON.stringify(pathToFileURL(actionEntrypoint).href)}); console.log("imported-only");`,
  ], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      INPUT_MANIFEST: "missing-manifest.json",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "imported-only");
});
