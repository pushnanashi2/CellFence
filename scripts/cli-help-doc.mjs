import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.resolve(fileURLToPath(import.meta.url));
const readmePath = path.join(repoRoot, "README.md");
const cliPath = path.join(repoRoot, "packages", "cli", "dist", "index.js");
const startMarker = "<!-- BEGIN GENERATED CLI HELP -->";
const endMarker = "<!-- END GENERATED CLI HELP -->";

export function generatedHelpBlock(helpText, newline = "\n") {
  const normalized = helpText.trim().replaceAll("\r\n", "\n");
  return `${startMarker}\n\n\`\`\`text\n${normalized}\n\`\`\`\n\n${endMarker}`.replaceAll("\n", newline);
}

export function updateGeneratedHelp(readme, helpText) {
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("README.md is missing the generated CLI help markers");
  }
  const newline = readme.includes("\r\n") ? "\r\n" : "\n";
  return `${readme.slice(0, start)}${generatedHelpBlock(helpText, newline)}${readme.slice(end + endMarker.length)}`;
}

function cliHelp() {
  return execFileSync(process.execPath, [cliPath, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

export function main(argv = process.argv.slice(2)) {
  const write = argv.includes("--write");
  if (argv.some((argument) => !["--check", "--write"].includes(argument))) {
    throw new Error("Usage: node scripts/cli-help-doc.mjs [--check|--write]");
  }
  const current = fs.readFileSync(readmePath, "utf8");
  const expected = updateGeneratedHelp(current, cliHelp());
  if (write) {
    fs.writeFileSync(readmePath, expected);
    console.log("updated README CLI help");
    return 0;
  }
  if (current !== expected) {
    console.error("README CLI help is stale; run npm run docs:cli-help");
    return 1;
  }
  console.log("README CLI help is current");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
