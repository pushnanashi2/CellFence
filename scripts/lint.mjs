import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const requiredFiles = [
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "LICENSE",
  "docs/architecture.md",
  "docs/threat-model.md",
  "docs/root-of-trust.md",
  "docs/implementation-status.md"
];

const findings = [];
for (const requiredFile of requiredFiles) {
  if (!fs.existsSync(path.join(root, requiredFile))) findings.push(`missing required file: ${requiredFile}`);
}

const textExtensions = new Set([".ts", ".js", ".mjs", ".md"]);
function visit(directoryPath) {
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    if (entry.isDirectory() && [".git", "node_modules", "dist"].includes(entry.name)) continue;
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      visit(entryPath);
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(path.extname(entry.name))) continue;
    const relativePath = path.relative(root, entryPath).split(path.sep).join("/");
    const content = fs.readFileSync(entryPath, "utf8");
    if (/\b(?:describe|it|test)\.only\s*\(/.test(content)) findings.push(`${relativePath}: focused test is not allowed`);
    if (/\b(?:describe|it|test)\.skip\s*\(/.test(content)) findings.push(`${relativePath}: skipped test is not allowed`);
  }
}

visit(root);

const scan = spawnSync(process.execPath, ["scripts/forbidden-source-scan.mjs"], { cwd: root, stdio: "inherit" });
if ((scan.status ?? 1) !== 0) findings.push("forbidden source scan failed");

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log("lint passed");
}
