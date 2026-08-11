import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAndValidateDownstreamCwd } from "../packages/mcp-proxy/dist/index.js";

const root = process.cwd();

function mkRoot() {
  return fs.mkdtempSync(path.join(root, ".cellfence-h6-"));
}

test("downstreamCwd defaults to rootDir when not provided", () => {
  const rootDir = mkRoot();
  try {
    const cwd = resolveAndValidateDownstreamCwd(rootDir, undefined, false);
    assert.equal(cwd, path.resolve(rootDir));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("downstreamCwd inside rootDir resolves to its absolute path", () => {
  const rootDir = mkRoot();
  try {
    const sub = path.join(rootDir, "sub");
    fs.mkdirSync(sub, { recursive: true });
    const cwd = resolveAndValidateDownstreamCwd(rootDir, sub, false);
    assert.equal(cwd, path.resolve(sub));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("downstreamCwd outside rootDir throws by default (H-6)", () => {
  const rootDir = mkRoot();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-h6-outside-"));
  try {
    assert.throws(
      () => resolveAndValidateDownstreamCwd(rootDir, outsideDir, false),
      /must be inside --root/,
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("downstreamCwd outside rootDir is accepted when allowCwdMismatch is true", () => {
  const rootDir = mkRoot();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-h6-outside-"));
  try {
    const cwd = resolveAndValidateDownstreamCwd(rootDir, outsideDir, true);
    assert.equal(cwd, path.resolve(outsideDir));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("downstreamCwd parent escape throws by default (H-6)", () => {
  const rootDir = mkRoot();
  try {
    assert.throws(
      () => resolveAndValidateDownstreamCwd(rootDir, path.join(rootDir, "..", "escape"), false),
      /must be inside --root/,
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
