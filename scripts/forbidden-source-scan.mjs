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
const allowedPhrases = [
  "github.com/pushnanashi2/cellfence",
  "git+https://github.com/pushnanashi2/cellfence.git",
  "https://github.com/pushnanashi2/cellfence",
  "https://github.com/pushnanashi2/cellfence/issues",
  "https://github.com/pushnanashi2/cellfence#readme"
];

const root = process.cwd();
const selfPath = path.relative(root, new URL(import.meta.url).pathname);
const ignoredDirectories = new Set([".git", ".stryker-tmp", "node_modules", "dist", "coverage", "reports", "tmp"]);
const ignoredFiles = new Set([selfPath.split(path.sep).join("/")]);
const scannedExtensions = new Set([".ts", ".js", ".mjs", ".json", ".md", ".yml", ".yaml"]);
const scannedFiles = new Set([".mailmap"]);
const findings = [];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsForbiddenTerm(text, term) {
  const normalizedTerm = term.toLowerCase();
  if (normalizedTerm === "advisor") {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedTerm)}([^a-z0-9]|$)`).test(text);
  }
  return text.includes(normalizedTerm);
}

function stripAllowedMailmapMappings(text) {
  const placeholderEmail = ["your-email", "example.com"].join("@");
  const replacementLogin = ["push", "nanashi2"].join("");
  const replacementName = ["Push", "NaNaShi"].join("");
  const replacementEmail = ["84632330", `${replacementLogin}@users.noreply.github.com`].join("+");
  const allowedMapping = `${replacementName} <${replacementEmail}> <${placeholderEmail}>`.toLowerCase();
  return text.split(/\r?\n/).map((line) => {
    if (line.trim().toLowerCase() === allowedMapping) return "";
    return line;
  }).join("\n");
}

function stripAllowedFileContent(relativePath, text) {
  if (relativePath === ".mailmap") return stripAllowedMailmapMappings(text);
  return text;
}

function visit(directoryPath) {
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      visit(entryPath);
      continue;
    }
    const relativePath = path.relative(root, entryPath).split(path.sep).join("/");
    if (!entry.isFile() || (!scannedExtensions.has(path.extname(entry.name)) && !scannedFiles.has(relativePath))) continue;
    if (ignoredFiles.has(relativePath)) continue;
    let text = stripAllowedFileContent(relativePath, fs.readFileSync(entryPath, "utf8")).toLowerCase();
    for (const allowedPhrase of allowedPhrases) {
      text = text.split(allowedPhrase).join("");
    }
    for (const term of forbiddenTerms) {
      if (containsForbiddenTerm(text, term)) {
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
