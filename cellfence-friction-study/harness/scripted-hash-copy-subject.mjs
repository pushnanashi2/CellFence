#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function splitCommand(command) {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^['"]|['"]$/g, "")) || [];
}

function appendLog(record) {
  const logPath = process.env.CELLFENCE_STUDY_COMMAND_LOG;
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify(record) + "\n");
}

function run(argv, cwd) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  appendLog({
    startedAt,
    cwd,
    argv,
    command: argv.join(" "),
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    innerSubject: true,
  });
  return result;
}

const repo = process.env.CELLFENCE_STUDY_REPO;
const cellfence = splitCommand(process.env.CELLFENCE_STUDY_CELLFENCE || "");
if (!repo || cellfence.length === 0) {
  console.error("CELLFENCE_STUDY_REPO and CELLFENCE_STUDY_CELLFENCE are required");
  process.exit(2);
}

const check = run([...cellfence, "baseline", "check"], repo);
const combined = (check.stdout || "") + "\n" + (check.stderr || "");
const exposesNextHash = /\bto [a-f0-9]{64}\b/.test(combined);
if (check.status === 0) process.exit(0);

if (exposesNextHash) {
  const candidate = path.join(repo, ".candidate-baseline.json");
  const created = run([...cellfence, "baseline", "create", "--baseline", candidate], repo);
  if (created.status !== 0) {
    process.stderr.write(created.stderr || created.stdout || "baseline create failed");
    process.exit(created.status ?? 1);
  }
  fs.copyFileSync(candidate, path.join(repo, "cellfence.baseline.json"));
  fs.rmSync(candidate, { force: true });
} else {
  const updated = run([...cellfence, "baseline", "update"], repo);
  if (updated.status !== 0) {
    process.stderr.write(updated.stderr || updated.stdout || "baseline update failed");
    process.exit(updated.status ?? 1);
  }
}

const final = run([...cellfence, "baseline", "check"], repo);
process.exit(final.status ?? 3);
