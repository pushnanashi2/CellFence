import fs from "node:fs";

const statusDocument = fs.readFileSync("docs/implementation-status.md", "utf8");
const allowedStatuses = new Set(["enforced", "partially_enforced", "documented", "planned"]);
const findings = [];

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

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log("release verification passed");
}
