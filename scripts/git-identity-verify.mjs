#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const placeholderEmail = ["your-email", "example.com"].join("@");
const placeholderNames = new Set(["an", "cn", "your name"]);
const findings = [];

function git(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function currentConfig(key) {
  return git(["config", "--get", key]) || "";
}

function isCi() {
  return process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
}

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

const currentName = currentConfig("user.name");
const currentEmail = currentConfig("user.email");

if (!isCi()) {
  if (!currentName) findings.push("git user.name is not configured");
  if (!currentEmail) findings.push("git user.email is not configured");
}

if (placeholderNames.has(normalized(currentName))) {
  findings.push(`git user.name is still a placeholder: ${currentName}`);
}
if (normalized(currentEmail) === placeholderEmail) {
  findings.push(`git user.email is still a placeholder: ${currentEmail}`);
}

const recentIdentityOutput = git(["log", "-n", "200", "--format=%ae%n%ce"]) || "";
const recentEmails = new Set(recentIdentityOutput.split(/\r?\n/).map(normalized).filter(Boolean));
if (recentEmails.has(placeholderEmail)) {
  if (!fs.existsSync(".mailmap")) {
    findings.push("recent commit history contains a placeholder email but .mailmap is missing");
  } else {
    const mapped = git(["check-mailmap", `placeholder <${placeholderEmail}>`]) || "";
    if (normalized(mapped).includes(placeholderEmail)) {
      findings.push("recent commit history contains a placeholder email but .mailmap does not remap it");
    }
  }
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log("git identity verification passed");
}
