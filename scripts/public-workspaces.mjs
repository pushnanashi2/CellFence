import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function workspacePatterns(rootDir) {
  const rootPackage = readJson(path.join(rootDir, "package.json"));
  if (Array.isArray(rootPackage.workspaces)) return rootPackage.workspaces;
  if (rootPackage.workspaces && Array.isArray(rootPackage.workspaces.packages)) {
    return rootPackage.workspaces.packages;
  }
  throw new Error("root package.json must define npm workspaces");
}

function expandWorkspacePattern(rootDir, pattern) {
  if (!pattern.includes("*")) {
    const packageJsonPath = path.join(rootDir, pattern, "package.json");
    return fs.existsSync(packageJsonPath) ? [pattern] : [];
  }
  const wildcardSuffix = "/*";
  if (!pattern.endsWith(wildcardSuffix) || pattern.slice(0, -wildcardSuffix.length).includes("*")) {
    throw new Error(`unsupported workspace pattern: ${pattern}`);
  }
  const parentDir = pattern.slice(0, -wildcardSuffix.length);
  const absoluteParent = path.join(rootDir, parentDir);
  if (!fs.existsSync(absoluteParent)) return [];
  return fs.readdirSync(absoluteParent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.posix.join(parentDir.replaceAll(path.sep, "/"), entry.name))
    .filter((workspaceDir) => fs.existsSync(path.join(rootDir, workspaceDir, "package.json")))
    .sort();
}

function workspaceRecords(rootDir) {
  const seen = new Set();
  const records = [];
  for (const pattern of workspacePatterns(rootDir)) {
    for (const workspaceDir of expandWorkspacePattern(rootDir, pattern)) {
      if (seen.has(workspaceDir)) continue;
      seen.add(workspaceDir);
      const packageJsonPath = path.join(rootDir, workspaceDir, "package.json");
      const packageJson = readJson(packageJsonPath);
      if (!packageJson.name) throw new Error(`${workspaceDir}/package.json must define name`);
      records.push({
        dir: workspaceDir,
        name: packageJson.name,
        private: packageJson.private === true,
        dependencies: {
          ...packageJson.dependencies,
          ...packageJson.peerDependencies,
          ...packageJson.optionalDependencies,
          ...packageJson.devDependencies
        }
      });
    }
  }
  return records;
}

export function publicWorkspaceDirs(rootDir = process.cwd()) {
  const publicRecords = workspaceRecords(rootDir).filter((record) => !record.private);
  const byName = new Map(publicRecords.map((record) => [record.name, record]));
  const state = new Map();
  const ordered = [];

  function visit(record, stack = []) {
    const currentState = state.get(record.name);
    if (currentState === "done") return;
    if (currentState === "visiting") {
      throw new Error(`cycle in public workspace dependencies: ${[...stack, record.name].join(" -> ")}`);
    }
    state.set(record.name, "visiting");
    for (const dependencyName of Object.keys(record.dependencies).sort()) {
      const dependency = byName.get(dependencyName);
      if (dependency) visit(dependency, [...stack, record.name]);
    }
    state.set(record.name, "done");
    ordered.push(record.dir);
  }

  for (const record of publicRecords) {
    visit(record);
  }
  return ordered;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dirs = publicWorkspaceDirs();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(dirs, null, 2)}\n`);
  } else {
    process.stdout.write(`${dirs.join("\n")}\n`);
  }
}
