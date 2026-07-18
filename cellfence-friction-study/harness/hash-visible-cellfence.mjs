#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const cellfenceCli = path.join(repoRoot, "packages", "cli", "dist", "index.js");

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cellfenceCli, ...args], {
    cwd: options.cwd || process.cwd(),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function printHashHints(args, cwd) {
  if (args[0] !== "baseline" || args[1] !== "check") return;
  const baselineArg = args.indexOf("--baseline");
  const baselinePath = baselineArg >= 0 && args[baselineArg + 1]
    ? path.resolve(cwd, args[baselineArg + 1])
    : path.join(cwd, "cellfence.baseline.json");
  const before = readJsonIfExists(baselinePath);
  if (!before) return;
  const tempPath = path.join(os.tmpdir(), `cellfence-hash-visible-${process.pid}-${Date.now()}.json`);
  const createResult = runCli(["baseline", "create", "--baseline", tempPath], { cwd });
  if (createResult.status !== 0) return;
  const after = readJsonIfExists(tempPath);
  fs.rmSync(tempPath, { force: true });
  if (!after) return;
  for (const cellId of Object.keys(after.cells || {}).sort()) {
    const previous = before.cells?.[cellId];
    const current = after.cells?.[cellId];
    if (previous?.publicSurfaceHash && current?.publicSurfaceHash && previous.publicSurfaceHash !== current.publicSurfaceHash) {
      console.error(`${cellId} public surface signature hash changed from ${previous.publicSurfaceHash} to ${current.publicSurfaceHash}`);
    }
  }
}

const args = process.argv.slice(2);
const result = runCli(args);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) {
  try {
    printHashHints(args, process.cwd());
  } catch {
    // Diagnostic wrapper only; the underlying CellFence result is authoritative.
  }
}
process.exit(result.status ?? 3);
