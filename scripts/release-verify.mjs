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

const githubAction = fs.readFileSync("packages/github-action/action.yml", "utf8");
const actionCliVersions = [...githubAction.matchAll(/\bcellfence@(\d+\.\d+\.\d+)\b/g)].map((match) => match[1]);
if (actionCliVersions.length === 0) {
  findings.push("packages/github-action/action.yml must pin the published cellfence CLI version");
}
for (const actionCliVersion of new Set(actionCliVersions)) {
  if (actionCliVersion !== packageJson.version) {
    findings.push(`packages/github-action/action.yml pins cellfence@${actionCliVersion}, expected ${packageJson.version}`);
  }
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
