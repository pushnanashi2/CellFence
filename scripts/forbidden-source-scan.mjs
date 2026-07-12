import fs from "node:fs";
import path from "node:path";

const forbiddenTerms = [
  "koenoki",
  "advisor",
  "ticker",
  "earnings",
  "briefing",
  "pushnanashi",
  "relomeru",
  "/home/",
  "C:\\\\Users\\\\",
  "your-email@example.com"
];

const root = process.cwd();
const selfPath = path.relative(root, new URL(import.meta.url).pathname);
const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage"]);
const ignoredFiles = new Set([selfPath.split(path.sep).join("/")]);
const scannedExtensions = new Set([".ts", ".js", ".mjs", ".json", ".md", ".yml", ".yaml"]);
const findings = [];

function visit(directoryPath) {
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      visit(entryPath);
      continue;
    }
    if (!entry.isFile() || !scannedExtensions.has(path.extname(entry.name))) continue;
    const relativePath = path.relative(root, entryPath).split(path.sep).join("/");
    if (ignoredFiles.has(relativePath)) continue;
    const text = fs.readFileSync(entryPath, "utf8").toLowerCase();
    for (const term of forbiddenTerms) {
      if (text.includes(term.toLowerCase())) {
        findings.push(`${relativePath}: forbidden term '${term}'`);
      }
    }
  }
}

visit(root);

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log("forbidden source scan passed");
}
