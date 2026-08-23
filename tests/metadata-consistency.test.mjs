import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

const PENDING_IMPLEMENTATION_RULE_IDS = new Map([
  [
    "CELLFENCE_IMPORT_ANALYSIS_DISABLED",
    {
      todoIssue: "TODO",
      reason: "Reserved compatibility RuleId; no finding is emitted yet.",
    },
  ],
  [
    "CELLFENCE_RESOURCE_ANALYSIS_DISABLED",
    {
      todoIssue: "TODO",
      reason: "Reserved compatibility RuleId; no finding is emitted yet.",
    },
  ],
]);

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function walkFiles(directory, predicate) {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relativePath = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(relativePath, predicate));
    else if (entry.isFile() && predicate(relativePath)) files.push(relativePath);
  }
  return files;
}

function packageJsonPaths() {
  return fs.readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.posix.join("packages", entry.name, "package.json"))
    .filter((relativePath) => fs.existsSync(path.join(root, relativePath)))
    .sort();
}

function ruleIdsFromTypes() {
  const typesSource = readText("packages/engine/src/types.ts");
  const match = /export type RuleId =([\s\S]*?);/.exec(typesSource);
  assert.ok(match, "RuleId union must be present in packages/engine/src/types.ts");
  return [...match[1].matchAll(/"((?:CELLFENCE_)[A-Z0-9_]+)"/g)]
    .map((entry) => entry[1])
    .sort();
}

function ruleIdsFromDocs() {
  return [...readText("docs/rules.md").matchAll(/`((?:CELLFENCE_)[A-Z0-9_]+)`/g)]
    .map((entry) => entry[1])
    .sort();
}

test("every declared engine rule id is documented", () => {
  const documented = new Set(ruleIdsFromDocs());
  const missing = ruleIdsFromTypes().filter((ruleId) => !documented.has(ruleId));
  assert.deepEqual(missing, [], `docs/rules.md is missing ${missing.length} RuleId entries: ${missing.join(", ")}`);
});

test("every declared engine rule id has an implementation emit site", (testContext) => {
  for (const [ruleId, metadata] of PENDING_IMPLEMENTATION_RULE_IDS) {
    assert.equal(typeof metadata.reason, "string", `${ruleId} allowlist entry must explain why it is pending`);
    assert.ok(metadata.reason.length > 0, `${ruleId} allowlist entry must include a reason`);
    assert.equal(typeof metadata.todoIssue, "string", `${ruleId} allowlist entry must include a TODO issue field`);
    assert.ok(metadata.todoIssue.length > 0, `${ruleId} allowlist TODO issue field must not be empty`);
  }
  const sourceFiles = walkFiles("packages", (relativePath) =>
    relativePath.endsWith(".ts")
    && relativePath.includes("/src/")
    && relativePath !== "packages/engine/src/types.ts");
  const sourceText = sourceFiles.map(readText).join("\n");
  const missing = ruleIdsFromTypes()
    .filter((ruleId) => !sourceText.includes(`"${ruleId}"`))
    .filter((ruleId) => !PENDING_IMPLEMENTATION_RULE_IDS.has(ruleId));
  const pending = ruleIdsFromTypes()
    .filter((ruleId) => !sourceText.includes(`"${ruleId}"`))
    .filter((ruleId) => PENDING_IMPLEMENTATION_RULE_IDS.has(ruleId));
  if (pending.length > 0) {
    testContext.diagnostic(`RuleId entries intentionally pending implementation: ${pending.join(", ")}`);
  }
  assert.deepEqual(missing, [], `RuleId entries without emit sites: ${missing.join(", ")}`);
});

test("duplicated glob matchers stay byte-for-byte synchronized", () => {
  const files = [
    "packages/engine/src/glob.ts",
    "packages/plugin-agent-budget/src/glob.ts",
    "packages/plugin-blast-radius/src/glob.ts",
  ];
  const [first, ...rest] = files.map(readText);
  for (const [index, content] of rest.entries()) {
    assert.equal(content, first, `${files[index + 1]} drifted from ${files[0]}`);
  }
});

test("public package manifests publish LICENSE and README files", () => {
  const findings = [];
  for (const packageJsonPath of packageJsonPaths()) {
    const packageDirectory = path.posix.dirname(packageJsonPath);
    const packageJson = readJson(packageJsonPath);
    if (packageJson.private === true) continue;
    for (const requiredFile of ["LICENSE", "README.md"]) {
      if (!Array.isArray(packageJson.files) || !packageJson.files.includes(requiredFile)) {
        findings.push(`${packageJsonPath} files must include ${requiredFile}`);
      }
      if (!fs.existsSync(path.join(root, packageDirectory, requiredFile))) {
        findings.push(`${packageDirectory}/${requiredFile} must exist`);
      }
    }
  }
  assert.deepEqual(findings, []);
});

test("workspace package node engine declarations match the root", () => {
  const rootPackage = readJson("package.json");
  const rootNodeEngine = rootPackage.engines?.node;
  assert.equal(typeof rootNodeEngine, "string", "root package.json must define engines.node");
  const findings = [];
  for (const packageJsonPath of packageJsonPaths()) {
    const packageJson = readJson(packageJsonPath);
    if (packageJson.engines?.node !== rootNodeEngine) {
      findings.push(`${packageJsonPath} engines.node must be ${rootNodeEngine}`);
    }
  }
  assert.deepEqual(findings, []);
});
