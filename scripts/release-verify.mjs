import fs from "node:fs";

const requiredFiles = [
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "LICENSE",
  "CHANGELOG.md",
  "docs/architecture.md",
  "docs/threat-model.md",
  "docs/root-of-trust.md",
  "docs/publishing.md",
  "docs/implementation-status.md",
];
const findings = [];

function changelogSection(text, heading) {
  const lines = text.split(/\r?\n/);
  const headingLine = `## ${heading}`;
  const startIndex = lines.findIndex((line) => line.trim() === headingLine);
  if (startIndex === -1) return null;
  const sectionLines = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (/^##\s/.test(line)) break;
    sectionLines.push(line);
  }
  return sectionLines.join("\n").trim();
}

function sectionBullets(section) {
  if (!section) return [];
  return section.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^- /.test(line));
}

function unreleasedHasOnlyPlaceholder(section) {
  if (!section) return true;
  const meaningfulLines = section.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return meaningfulLines.length === 0
    || (meaningfulLines.length === 1 && meaningfulLines[0] === "- No unreleased changes.");
}

for (const requiredFile of requiredFiles) {
  if (!fs.existsSync(requiredFile)) findings.push(`missing required file: ${requiredFile}`);
}

const statusDocument = fs.readFileSync("docs/implementation-status.md", "utf8");
const allowedStatuses = new Set(["enforced", "partially_enforced", "documented", "planned"]);

for (const line of statusDocument.split(/\r?\n/)) {
  if (!line.startsWith("|") || line.includes("---") || line.includes("mechanism")) continue;
  const columns = line.split("|").map((column) => column.trim()).filter(Boolean);
  if (columns.length >= 2 && !allowedStatuses.has(columns[1])) {
    findings.push(`implementation-status has invalid status '${columns[1]}' in line: ${line}`);
  }
}

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (packageJson.scripts && /publish/.test(Object.keys(packageJson.scripts).join("\n"))) {
  findings.push("root package.json must not define an npm publishing script in v0.x");
}

const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
const releaseHeadingPattern = new RegExp(`^## ${packageJson.version} - \\d{4}-\\d{2}-\\d{2}\\s*$`, "m");
const releaseHeading = releaseHeadingPattern.exec(changelog)?.[0].replace(/^##\s+/, "").trim();
const releaseSection = releaseHeading ? changelogSection(changelog, releaseHeading) : null;
if (!releaseHeading) {
  findings.push(`CHANGELOG.md must contain a release heading for ${packageJson.version}`);
} else if (sectionBullets(releaseSection).length === 0) {
  findings.push(`CHANGELOG.md release ${packageJson.version} must contain at least one bullet`);
}

const strictChangelog = process.env.CELLFENCE_RELEASE_STRICT_CHANGELOG === "1" || process.env.GITHUB_REF_TYPE === "tag";
const unreleasedSection = changelogSection(changelog, "Unreleased");
if (strictChangelog && !unreleasedHasOnlyPlaceholder(unreleasedSection)) {
  findings.push("CHANGELOG.md Unreleased must be empty or contain only '- No unreleased changes.' for release publishing");
}

const githubAction = fs.readFileSync("packages/github-action/action.yml", "utf8");
const hardcodedActionCliVersions = [...githubAction.matchAll(/\bcellfence@(\d+\.\d+\.\d+)\b/g)].map((match) => match[1]);
if (hardcodedActionCliVersions.length > 0) {
  findings.push(`packages/github-action/action.yml must not hard-code an exact CLI version; found ${[...new Set(hardcodedActionCliVersions)].join(", ")}`);
}
if (!/^\s{2}version:\r?\n\s{4}description:/m.test(githubAction)) {
  findings.push("packages/github-action/action.yml must expose a version input for the published CLI");
}
if (!/^\s{4}default:\s*latest\s*$/m.test(githubAction)) {
  findings.push("packages/github-action/action.yml version input must default to npm latest so main does not reference an unpublished CLI");
}
if (!/cli_package="cellfence@\$\{cli_version\}"/.test(githubAction)) {
  findings.push("packages/github-action/action.yml must invoke cellfence through the version input");
}

const cliSource = fs.readFileSync("packages/cli/src/index.ts", "utf8");
const mcpServerInfoMatch = /serverInfo:\s*\{\s*name:\s*"cellfence",\s*version:\s*"([^"]+)"/.exec(cliSource);
if (!mcpServerInfoMatch) {
  findings.push("packages/cli/src/index.ts must expose a CellFence MCP serverInfo version");
} else if (mcpServerInfoMatch[1] !== packageJson.version) {
  findings.push(`packages/cli/src/index.ts exposes MCP serverInfo ${mcpServerInfoMatch[1]}, expected ${packageJson.version}`);
}

const mcpProxySource = fs.readFileSync("packages/mcp-proxy/src/index.ts", "utf8");
const mcpProxyVersionMatch = /const VERSION = "([^"]+)"/.exec(mcpProxySource);
if (!mcpProxyVersionMatch) {
  findings.push("packages/mcp-proxy/src/index.ts must expose a package VERSION");
} else if (mcpProxyVersionMatch[1] !== packageJson.version) {
  findings.push(`packages/mcp-proxy/src/index.ts exposes VERSION ${mcpProxyVersionMatch[1]}, expected ${packageJson.version}`);
}

for (const workflowPath of fs.readdirSync(".github/workflows").filter((name) => /\.ya?ml$/.test(name)).map((name) => `.github/workflows/${name}`)) {
  const text = fs.readFileSync(workflowPath, "utf8");
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = line.match(/uses:\s*actions\/[^@\s]+@([^\s#]+)/);
    if (match && !/^[a-f0-9]{40}$/.test(match[1])) {
      findings.push(`${workflowPath}:${index + 1} action is not pinned to a commit SHA: ${line.trim()}`);
    }
  }
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log("release verification passed");
}
