import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultCorpusPath = path.join(repoRoot, "docs", "research", "upstream-policy-oracle-v1", "corpus.json");
const defaultOutDir = path.join(repoRoot, "reports", "upstream-policy-oracle-v1");
const defaultWorkDir = path.join(repoRoot, "tmp", "upstream-policy-oracle-v1");
const engineDist = path.join(repoRoot, "packages", "engine", "dist", "index.js");
const corpusSchemaVersion = "cellfence.upstream-policy-oracle.corpus.v1";
const reportSchemaVersion = "cellfence.upstream-policy-oracle.report.v1";
const manifestSchemaVersion = "cellfence.manifest.v1";
const questionSchemaVersion = "cellfence.policy-question.v1";
const oracleAnswersSchemaVersion = "cellfence.oracle-answers.v1";
const mutationSchemaVersion = "cellfence.oracle-mutations.v1";
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const publicEntryBasenames = ["public", "index"];
const packageEntryFields = ["source", "types", "typings", "module", "main", "browser"];
const packageDependencyFields = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"];
const productionScopeExcludes = [
  "**/__fixtures__/**",
  "**/__mocks__/**",
  "**/__tests__/**",
  "**/*.bench.*",
  "**/*.benchmark.*",
  "**/*.css",
  "**/*.d.ts",
  "**/*.gen.*",
  "**/*.generated.*",
  "**/*.gif",
  "**/*.jpeg",
  "**/*.jpg",
  "**/*.less",
  "**/*.md",
  "**/*.module.css",
  "**/*.module.scss",
  "**/*.png",
  "**/*.sass",
  "**/*.scss",
  "**/*.spec.*",
  "**/*.stories.*",
  "**/*.story.*",
  "**/*.styl",
  "**/*.svg",
  "**/*.test.*",
  "**/*.vue",
  "**/*.webp",
  "**/bench/**",
  "**/benchmark/**",
  "**/benchmarks/**",
  "**/build/**",
  "**/demo/**",
  "**/demos/**",
  "**/dist/**",
  "**/example/**",
  "**/examples/**",
  "**/fixture/**",
  "**/fixtures/**",
  "**/generated/**",
  "**/test/**",
  "**/tests/**",
  "**/third_party/**",
  "**/vendor/**",
];
const defaultRequiredRules = [
  "CELLFENCE_OWNERSHIP_OVERLAP",
  "CELLFENCE_UNOWNED_SOURCE",
  "CELLFENCE_UNOWNED_IMPORT_TARGET",
  "CELLFENCE_PUBLIC_ENTRY_OUTSIDE_OWNERSHIP",
  "CELLFENCE_ARTIFACT_OUTSIDE_OWNERSHIP",
  "CELLFENCE_SYMLINK_TARGET_OUTSIDE_OWNERSHIP",
  "CELLFENCE_PRIVATE_IMPORT",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_IMPORT",
  "CELLFENCE_UNSUPPORTED_DYNAMIC_REQUIRE",
  "CELLFENCE_REQUIRED_RULE_DISABLED",
  "CELLFENCE_WAIVER_INVALID",
];
const commandTimeouts = {
  clone: 600_000,
  checkout: 120_000,
  revParse: 60_000,
};

class SubjectFailure extends Error {
  constructor(stage, failureKind, message, details = {}) {
    super(message);
    this.name = "SubjectFailure";
    this.stage = stage;
    this.failureKind = failureKind;
    Object.assign(this, details);
  }
}

function usage() {
  console.error(`Usage: node scripts/upstream-policy-oracle.mjs [--corpus docs/research/upstream-policy-oracle-v1/corpus.json] [--out-dir reports/upstream-policy-oracle-v1] [--workdir tmp/upstream-policy-oracle-v1] [--max-subjects n] [--dry-run] [--allow-floating-ref] [--clone-mode full|shallow] [--discard-checkouts] [--blind-scope all|production]

Builds upstream-declared reference manifests from existing package/workspace
policy, runs package-policy-hint ablation inference, compresses
differences into policy questions with manifest patches, answers them from the
reference policy, and writes a reproducible evidence bundle. It clones only the
explicit corpus subjects and never runs target package install scripts.`);
}

function parseArgs(argv) {
  const parsed = {
    corpusPath: defaultCorpusPath,
    outDir: defaultOutDir,
    workDir: defaultWorkDir,
    maxSubjects: undefined,
    dryRun: false,
    allowFloatingRef: false,
    cloneMode: "full",
    discardCheckouts: false,
    blindScope: "production",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") {
      parsed.corpusPath = path.resolve(argv[index + 1] || "");
      index += 1;
    } else if (argument.startsWith("--corpus=")) {
      parsed.corpusPath = path.resolve(argument.slice("--corpus=".length));
    } else if (argument === "--out-dir") {
      parsed.outDir = path.resolve(argv[index + 1] || "");
      index += 1;
    } else if (argument.startsWith("--out-dir=")) {
      parsed.outDir = path.resolve(argument.slice("--out-dir=".length));
    } else if (argument === "--workdir") {
      parsed.workDir = path.resolve(argv[index + 1] || "");
      index += 1;
    } else if (argument.startsWith("--workdir=")) {
      parsed.workDir = path.resolve(argument.slice("--workdir=".length));
    } else if (argument === "--max-subjects") {
      parsed.maxSubjects = Number(argv[index + 1] || 0);
      index += 1;
    } else if (argument.startsWith("--max-subjects=")) {
      parsed.maxSubjects = Number(argument.slice("--max-subjects=".length));
    } else if (argument === "--dry-run") {
      parsed.dryRun = true;
    } else if (argument === "--allow-floating-ref") {
      parsed.allowFloatingRef = true;
    } else if (argument === "--clone-mode") {
      parsed.cloneMode = argv[index + 1] || "";
      index += 1;
    } else if (argument.startsWith("--clone-mode=")) {
      parsed.cloneMode = argument.slice("--clone-mode=".length);
    } else if (argument === "--discard-checkouts") {
      parsed.discardCheckouts = true;
    } else if (argument === "--blind-scope") {
      parsed.blindScope = argv[index + 1] || "";
      index += 1;
    } else if (argument.startsWith("--blind-scope=")) {
      parsed.blindScope = argument.slice("--blind-scope=".length);
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.corpusPath) throw new Error("--corpus is required");
  if (parsed.maxSubjects !== undefined && (!Number.isInteger(parsed.maxSubjects) || parsed.maxSubjects < 1)) {
    throw new Error("--max-subjects must be a positive integer");
  }
  if (!["full", "shallow"].includes(parsed.cloneMode)) throw new Error("--clone-mode must be full or shallow");
  if (!["all", "production"].includes(parsed.blindScope)) throw new Error("--blind-scope must be all or production");
  return parsed;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function stableCanonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableCanonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort((left, right) => left.localeCompare(right)).map((key) => `${JSON.stringify(key)}:${stableCanonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value) {
  return hashText(stableCanonicalJson(value));
}

function artifactDigestSet(artifacts) {
  return Object.fromEntries(Object.entries(artifacts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, artifact]) => [key, artifact.sha256]));
}

function normalizePath(value) {
  return String(value).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/+$/, "") || ".";
}

function repoPath(rootDir, filePath) {
  return normalizePath(path.relative(rootDir, filePath));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slugSubjectId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "subject";
}

function isExactCommit(value) {
  return /^[a-f0-9]{40}$/i.test(String(value || ""));
}

function isPathWithin(baseDir, candidatePath, allowBase = false) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidatePath));
  if (relative === "") return allowBase;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveWithin(baseDir, relativePath, label, options = {}) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const resolved = path.resolve(baseDir, relativePath);
  if (!isPathWithin(baseDir, resolved, options.allowBase === true)) {
    throw new Error(`${label} escapes its root: ${relativePath}`);
  }
  return resolved;
}

function validateContainedRelativePath(relativePath, label) {
  resolveWithin(path.join(repoRoot, ".cellfence-path-root"), relativePath, label, { allowBase: true });
}

function subjectDirectory(workDir, id) {
  const slug = slugSubjectId(id);
  const digest = hashText(id).slice(0, 12);
  return resolveWithin(workDir, `${slug}-${digest}`, "subject id");
}

function run(command, args, options) {
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
      LC_ALL: "C",
      TZ: "UTC",
    },
    maxBuffer: 100 * 1024 * 1024,
    timeout: options.timeoutMs,
  });
  const errorCode = result.error && typeof result.error === "object" && "code" in result.error
    ? String(result.error.code)
    : undefined;
  const timedOut = errorCode === "ETIMEDOUT";
  return {
    command: [command, ...args].join(" "),
    status: result.status ?? (timedOut ? 124 : 1),
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? String(result.error.message || result.error) : undefined,
    errorCode,
    timedOut,
    timeoutMs: options.timeoutMs,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

function writeCommandLogs(subjectDir, name, result) {
  const logDir = path.join(subjectDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, `${name}.stdout.log`), result.stdout);
  fs.writeFileSync(path.join(logDir, `${name}.stderr.log`), result.stderr);
}

function summarizeFailure(result) {
  return result.error
    || result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join("\n")
    || result.stdout.trim().split(/\r?\n/).filter(Boolean).slice(-3).join("\n")
    || `exit ${result.status}`;
}

function commandFailure(stage, result) {
  if (result.timedOut) {
    throw new SubjectFailure(stage, "timeout", `${stage} timed out after ${result.timeoutMs}ms`, {
      timeoutMs: result.timeoutMs,
      exitCode: result.status,
      durationMs: result.durationMs,
    });
  }
  throw new SubjectFailure(stage, "command_failed", summarizeFailure(result), {
    exitCode: result.status,
    durationMs: result.durationMs,
  });
}

function validateCorpus(corpus, options) {
  if (corpus.schemaVersion !== corpusSchemaVersion) {
    throw new Error(`corpus schemaVersion must be ${corpusSchemaVersion}`);
  }
  if (!Array.isArray(corpus.subjects) || corpus.subjects.length === 0) {
    throw new Error("corpus must contain at least one subject");
  }
  const ids = new Set();
  const subjectDirs = new Set();
  for (const subject of corpus.subjects) {
    if (!subject || typeof subject !== "object") throw new Error("each subject must be an object");
    if (typeof subject.id !== "string" || subject.id.length === 0) throw new Error("each subject requires id");
    if (subject.id === "." || subject.id === "..") throw new Error(`subject id is not allowed: ${subject.id}`);
    if (ids.has(subject.id)) throw new Error(`duplicate subject id: ${subject.id}`);
    ids.add(subject.id);
    const subjectDir = subjectDirectory(options.workDir, subject.id);
    if (subjectDirs.has(subjectDir)) throw new Error(`duplicate subject directory for id: ${subject.id}`);
    subjectDirs.add(subjectDir);
    if (!subject.repository || typeof subject.repository !== "string") throw new Error(`${subject.id} requires repository`);
    if (!options.allowFloatingRef && !isExactCommit(subject.commit)) {
      throw new Error(`${subject.id} requires exact 40-hex commit; use --allow-floating-ref only for exploratory runs`);
    }
    const policy = subject.policy || {};
    if (policy.strategy !== undefined && policy.strategy !== "package-workspaces") {
      throw new Error(`${subject.id} policy.strategy must be package-workspaces`);
    }
    if (policy.scope !== undefined && !["all", "production"].includes(policy.scope)) {
      throw new Error(`${subject.id} policy.scope must be all or production`);
    }
    if (policy.packageRoot !== undefined) validateContainedRelativePath(policy.packageRoot, `${subject.id} policy.packageRoot`);
  }
}

function cloneSubject(subject, subjectDir, options) {
  const checkoutDir = path.join(subjectDir, "checkout");
  fs.rmSync(checkoutDir, { recursive: true, force: true });
  const cloneArgs = ["clone", "--quiet", "--no-tags"];
  if (options.cloneMode === "shallow") cloneArgs.push("--depth", "1", "--filter=blob:none");
  cloneArgs.push(subject.repository, checkoutDir);
  const clone = run("git", cloneArgs, { cwd: options.workDir, timeoutMs: commandTimeouts.clone });
  writeCommandLogs(subjectDir, "clone", clone);
  if (clone.status !== 0) commandFailure("clone", clone);

  const checkoutTarget = subject.commit || subject.ref || "HEAD";
  let checkout = run("git", ["checkout", "--quiet", "--detach", checkoutTarget], {
    cwd: checkoutDir,
    timeoutMs: commandTimeouts.checkout,
  });
  writeCommandLogs(subjectDir, "checkout", checkout);
  if (checkout.status !== 0 && options.cloneMode === "shallow" && subject.commit) {
    const fetch = run("git", ["fetch", "--quiet", "--depth", "1", "origin", subject.commit], {
      cwd: checkoutDir,
      timeoutMs: commandTimeouts.clone,
    });
    writeCommandLogs(subjectDir, "fetch-commit", fetch);
    if (fetch.status !== 0) commandFailure("fetch-commit", fetch);
    checkout = run("git", ["checkout", "--quiet", "--detach", subject.commit], {
      cwd: checkoutDir,
      timeoutMs: commandTimeouts.checkout,
    });
    writeCommandLogs(subjectDir, "checkout-after-fetch", checkout);
  }
  if (checkout.status !== 0) commandFailure("checkout", checkout);

  const revParse = run("git", ["rev-parse", "HEAD"], { cwd: checkoutDir, timeoutMs: commandTimeouts.revParse });
  writeCommandLogs(subjectDir, "rev-parse", revParse);
  if (revParse.status !== 0) commandFailure("rev-parse", revParse);
  const actualCommit = revParse.stdout.trim();
  if (subject.commit && actualCommit !== subject.commit) {
    throw new SubjectFailure("checkout", "commit_mismatch", `checked out ${actualCommit}, expected ${subject.commit}`);
  }
  const tree = run("git", ["rev-parse", "HEAD^{tree}"], { cwd: checkoutDir, timeoutMs: commandTimeouts.revParse });
  writeCommandLogs(subjectDir, "tree", tree);
  if (tree.status !== 0) commandFailure("rev-parse", tree);
  return { checkoutDir, actualCommit, gitTree: tree.stdout.trim() };
}

function gitWorktreeStatus(checkoutDir, subjectDir, name) {
  const result = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: checkoutDir,
    timeoutMs: commandTimeouts.revParse,
  });
  writeCommandLogs(subjectDir, name, result);
  if (result.status !== 0) commandFailure("checkout", result);
  const porcelain = result.stdout.trim();
  return {
    clean: porcelain.length === 0,
    porcelain,
  };
}

function listFiles(rootDir) {
  const files = [];
  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile()) files.push(fullPath);
    }
  }
  walk(rootDir);
  return files.sort((left, right) => left.localeCompare(right));
}

function sourceFiles(rootDir) {
  return listFiles(rootDir).filter((filePath) => sourceExtensions.has(path.extname(filePath)));
}

function globToRegExp(pattern) {
  const normalized = normalizePath(pattern);
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      const previous = normalized[index - 1];
      const following = normalized[index + 2];
      if (previous === "/" && following === "/") {
        source = source.slice(0, -1);
        source += "(?:/.*)?/";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

const globCache = new Map();

function matchesPattern(relativePath, pattern) {
  const normalizedPath = normalizePath(relativePath);
  const normalizedPattern = normalizePath(pattern);
  let regex = globCache.get(normalizedPattern);
  if (!regex) {
    regex = globToRegExp(normalizedPattern);
    globCache.set(normalizedPattern, regex);
  }
  return regex.test(normalizedPath);
}

function pathExcludedByScope(scope, relativePath) {
  return scope === "production" && productionScopeExcludes.some((pattern) => matchesPattern(relativePath, pattern));
}

function sourceFilesInRoot(rootDir, relativeRoot, scope) {
  const normalizedRoot = normalizePath(relativeRoot);
  return sourceFiles(rootDir)
    .map((filePath) => repoPath(rootDir, filePath))
    .filter((relativePath) => !pathExcludedByScope(scope, relativePath))
    .filter((relativePath) => relativePath === normalizedRoot || relativePath.startsWith(`${normalizedRoot}/`))
    .sort((left, right) => left.localeCompare(right));
}

function directSourceFilesInRoot(rootDir, relativeRoot, scope) {
  const normalizedRoot = normalizePath(relativeRoot);
  return sourceFiles(rootDir)
    .map((filePath) => repoPath(rootDir, filePath))
    .filter((relativePath) => !pathExcludedByScope(scope, relativePath))
    .filter((relativePath) => path.posix.dirname(relativePath) === normalizedRoot)
    .sort((left, right) => left.localeCompare(right));
}

function hasSourceFiles(rootDir, relativeRoot, scope) {
  return sourceFilesInRoot(rootDir, relativeRoot, scope).length > 0;
}

function readJsonIfExists(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return undefined;
  }
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function pnpmWorkspacePatterns(rootDir, packageRoot) {
  const text = readTextFile(path.join(rootDir, packageRoot, "pnpm-workspace.yaml"));
  if (!text) return [];
  const patterns = [];
  let inPackages = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (/^\s*packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    if (!inPackages) continue;
    const match = line.match(/^\s*-\s*['"]?([^'"\s][^'"]*?)['"]?\s*$/);
    if (!match) continue;
    const pattern = match[1].trim();
    if (pattern.length > 0 && !pattern.startsWith("!")) patterns.push(pattern);
  }
  return patterns;
}

function workspacePatterns(rootDir, packageRoot, packageJson) {
  const patterns = new Set();
  if (isRecord(packageJson)) {
    const workspaces = packageJson.workspaces;
    if (Array.isArray(workspaces)) {
      for (const entry of workspaces) {
        if (typeof entry === "string" && !entry.startsWith("!")) patterns.add(entry);
      }
    } else if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
      for (const entry of workspaces.packages) {
        if (typeof entry === "string" && !entry.startsWith("!")) patterns.add(entry);
      }
    }
  }
  for (const entry of pnpmWorkspacePatterns(rootDir, packageRoot)) patterns.add(entry);
  return [...patterns].sort((left, right) => left.localeCompare(right));
}

function expandWorkspacePattern(rootDir, packageRoot, pattern) {
  const normalized = normalizePath(pattern);
  const wildcardIndex = normalized.indexOf("*");
  if (wildcardIndex === -1) {
    const workspaceRoot = normalizePath(path.posix.join(packageRoot, normalized));
    return fs.existsSync(path.join(rootDir, workspaceRoot, "package.json")) ? [workspaceRoot] : [];
  }
  const slashBeforeWildcard = normalized.lastIndexOf("/", wildcardIndex);
  const parentPattern = slashBeforeWildcard === -1 ? "." : normalized.slice(0, slashBeforeWildcard);
  const suffix = normalized.slice(wildcardIndex + 1);
  const parent = normalizePath(path.posix.join(packageRoot, parentPattern));
  const absoluteParent = path.join(rootDir, parent);
  if (!fs.existsSync(absoluteParent) || !fs.statSync(absoluteParent).isDirectory()) return [];
  const roots = [];
  for (const entry of fs.readdirSync(absoluteParent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const firstLevel = normalizePath(path.posix.join(parent, `${entry.name}${suffix}`));
    if (fs.existsSync(path.join(rootDir, firstLevel, "package.json"))) {
      roots.push(firstLevel);
      continue;
    }
    if (entry.name.startsWith("@")) {
      const scopedParent = path.join(rootDir, firstLevel);
      if (!fs.existsSync(scopedParent) || !fs.statSync(scopedParent).isDirectory()) continue;
      for (const scopedEntry of fs.readdirSync(scopedParent, { withFileTypes: true })) {
        if (!scopedEntry.isDirectory()) continue;
        const scopedRoot = normalizePath(path.posix.join(firstLevel, scopedEntry.name));
        if (fs.existsSync(path.join(rootDir, scopedRoot, "package.json"))) roots.push(scopedRoot);
      }
    }
  }
  return roots.sort((left, right) => left.localeCompare(right));
}

function discoverPackageRoots(rootDir, packageRoot) {
  const rootPackageJson = readJsonIfExists(path.join(rootDir, packageRoot, "package.json"));
  if (!isRecord(rootPackageJson)) throw new Error(`package policy root has no readable package.json: ${packageRoot}`);
  const patterns = workspacePatterns(rootDir, packageRoot, rootPackageJson);
  if (patterns.length === 0) return [packageRoot];
  return [...new Set(patterns.flatMap((pattern) => expandWorkspacePattern(rootDir, packageRoot, pattern)))]
    .filter((workspaceRoot) => fs.existsSync(path.join(rootDir, workspaceRoot, "package.json")))
    .sort((left, right) => left.localeCompare(right));
}

function sourceRootForPackage(rootDir, packageRoot, scope) {
  const srcRoot = normalizePath(path.posix.join(packageRoot, "src"));
  if (hasSourceFiles(rootDir, srcRoot, scope)) return srcRoot;
  if (directSourceFilesInRoot(rootDir, packageRoot, scope).length > 0) return normalizePath(packageRoot);
  return undefined;
}

function exportValueStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => exportValueStrings(entry));
  if (!isRecord(value)) return [];
  const preferredKeys = ["source", "types", "typings", "import", "require", "default"];
  return preferredKeys.flatMap((key) => exportValueStrings(value[key]));
}

function packageExportEntryStrings(exportsField) {
  if (typeof exportsField === "string" || Array.isArray(exportsField)) return exportValueStrings(exportsField);
  if (!isRecord(exportsField)) return [];
  if (exportsField["."] !== undefined) return exportValueStrings(exportsField["."]);
  return exportValueStrings(exportsField);
}

function existingPackageEntry(rootDir, packageRoot, relativeRoot, entryPath, scope) {
  const withoutLeadingDot = entryPath.replace(/^\.\//, "");
  if (withoutLeadingDot.startsWith("../") || path.isAbsolute(withoutLeadingDot)) return undefined;
  const basePath = path.join(rootDir, packageRoot, withoutLeadingDot);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.mts`,
    `${basePath}.cts`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.js"),
    path.join(basePath, "index.jsx"),
  ];
  for (const candidatePath of candidates) {
    if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) continue;
    const relativePath = repoPath(rootDir, candidatePath);
    if (pathExcludedByScope(scope, relativePath)) continue;
    if (relativePath === relativeRoot || relativePath.startsWith(`${relativeRoot}/`)) return relativePath;
  }
  return undefined;
}

function publicEntryFromPackageJson(rootDir, packageRoot, relativeRoot, packageJson, scope) {
  const entryStrings = [
    ...packageExportEntryStrings(packageJson.exports),
    ...packageEntryFields.flatMap((field) => typeof packageJson[field] === "string" ? [packageJson[field]] : []),
  ];
  for (const entryString of entryStrings) {
    const publicEntry = existingPackageEntry(rootDir, packageRoot, relativeRoot, entryString, scope);
    if (publicEntry) return publicEntry;
  }
  return undefined;
}

function fallbackPublicEntry(rootDir, relativeRoot, scope) {
  for (const basename of publicEntryBasenames) {
    for (const extension of sourceExtensions) {
      const candidate = normalizePath(path.posix.join(relativeRoot, `${basename}${extension}`));
      if (pathExcludedByScope(scope, candidate)) continue;
      if (fs.existsSync(path.join(rootDir, candidate))) return candidate;
    }
  }
  return sourceFilesInRoot(rootDir, relativeRoot, scope)[0];
}

function publicEntryForPackage(rootDir, packageRoot, relativeRoot, packageJson, scope) {
  return publicEntryFromPackageJson(rootDir, packageRoot, relativeRoot, packageJson, scope)
    || fallbackPublicEntry(rootDir, relativeRoot, scope);
}

function sanitizeCellId(input) {
  const unscoped = String(input).includes("/") ? String(input).split("/").at(-1) || input : input;
  const sanitized = String(unscoped)
    .replace(/^@/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "cell";
}

function uniqueId(baseId, usedIds) {
  let candidateId = baseId;
  let suffix = 2;
  while (usedIds.has(candidateId)) {
    candidateId = `${baseId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidateId);
  return candidateId;
}

function extractPublicSymbols(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const symbols = new Set();
  for (const match of text.matchAll(/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) {
    symbols.add(match[1]);
  }
  for (const match of text.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const rawPart of match[1].split(",")) {
      const part = rawPart.replace(/\btype\s+/g, "").trim();
      if (!part || part.startsWith("default as ")) continue;
      const aliasMatch = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(part);
      const directMatch = /^([A-Za-z_$][\w$]*)$/.exec(part);
      if (aliasMatch) symbols.add(aliasMatch[1]);
      else if (directMatch) symbols.add(directMatch[1]);
    }
  }
  if (/\bexport\s+default\b/.test(text)) symbols.add("default");
  return [...symbols].sort((left, right) => left.localeCompare(right));
}

function packageDependencyNames(packageJson) {
  const names = new Set();
  for (const field of packageDependencyFields) {
    const dependencies = packageJson[field];
    if (!isRecord(dependencies)) continue;
    for (const dependencyName of Object.keys(dependencies)) names.add(dependencyName);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function sourceHashRecord(rootDir, relativePath, kind, fields) {
  const fullPath = path.join(rootDir, relativePath);
  return {
    path: relativePath,
    kind,
    sha256: hashFile(fullPath),
    fields,
  };
}

function createReferenceManifest(rootDir, subject) {
  const policy = subject.policy || {};
  const scope = policy.scope || "production";
  const packageRoot = normalizePath(policy.packageRoot || ".");
  const packageRoots = discoverPackageRoots(rootDir, packageRoot);
  const usedIds = new Set();
  const cells = [];
  const rootPackageJsonPath = normalizePath(path.posix.join(packageRoot, "package.json"));
  const rootPackageJson = readJsonIfExists(path.join(rootDir, rootPackageJsonPath));
  const rootWorkspacePatterns = workspacePatterns(rootDir, packageRoot, rootPackageJson);
  const provenanceSources = [];
  if (isRecord(rootPackageJson) && isRecord(rootPackageJson.workspaces) || Array.isArray(rootPackageJson?.workspaces)) {
    provenanceSources.push(sourceHashRecord(rootDir, rootPackageJsonPath, "package-json", ["workspaces"]));
  }
  const pnpmWorkspacePath = normalizePath(path.posix.join(packageRoot, "pnpm-workspace.yaml"));
  if (rootWorkspacePatterns.length > 0 && fs.existsSync(path.join(rootDir, pnpmWorkspacePath))) {
    provenanceSources.push(sourceHashRecord(rootDir, pnpmWorkspacePath, "pnpm-workspace", ["packages"]));
  }
  for (const packageCandidateRoot of packageRoots) {
    const packageJsonPath = normalizePath(path.posix.join(packageCandidateRoot, "package.json"));
    const packageJson = readJsonIfExists(path.join(rootDir, packageJsonPath));
    if (!isRecord(packageJson)) continue;
    const sourceRoot = sourceRootForPackage(rootDir, packageCandidateRoot, scope);
    if (!sourceRoot) continue;
    const publicEntry = publicEntryForPackage(rootDir, packageCandidateRoot, sourceRoot, packageJson, scope);
    if (!publicEntry) continue;
    const packageName = typeof packageJson.name === "string" && packageJson.name.trim().length > 0
      ? packageJson.name
      : undefined;
    const id = uniqueId(sanitizeCellId(packageName || path.posix.basename(packageCandidateRoot)), usedIds);
    const dependencyNames = packageDependencyNames(packageJson);
    const fields = ["name"];
    if (workspacePatterns(rootDir, packageCandidateRoot, packageJson).length > 0) fields.push("workspaces");
    if (packageJson.exports !== undefined) fields.push("exports");
    for (const field of packageEntryFields) {
      if (packageJson[field] !== undefined) fields.push(field);
    }
    for (const field of packageDependencyFields) {
      if (packageJson[field] !== undefined) fields.push(field);
    }
    provenanceSources.push(sourceHashRecord(rootDir, packageJsonPath, "package-json", fields));
    cells.push({
      id,
      packageRoot: packageCandidateRoot,
      sourceRoot,
      packageName,
      dependencyNames,
      ownedPaths: [`${sourceRoot}/**`],
      publicEntry,
      publicSymbols: extractPublicSymbols(path.join(rootDir, publicEntry)),
      consumes: [],
      producesArtifacts: [],
    });
  }
  const packageNameToCellId = new Map(cells.filter((cell) => cell.packageName).map((cell) => [cell.packageName, cell.id]));
  for (const cell of cells) {
    const consumes = [];
    for (const dependencyName of cell.dependencyNames) {
      const targetCell = packageNameToCellId.get(dependencyName);
      if (targetCell && targetCell !== cell.id) consumes.push({ cell: targetCell });
    }
    cell.consumes = consumes.sort((left, right) => left.cell.localeCompare(right.cell));
  }
  const manifestCells = cells
    .map((cell) => ({
      id: cell.id,
      ...(cell.packageName ? { packageName: cell.packageName } : {}),
      ownedPaths: cell.ownedPaths,
      publicEntry: cell.publicEntry,
      publicSymbols: cell.publicSymbols,
      consumes: cell.consumes,
      producesArtifacts: [],
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (manifestCells.length === 0) throw new Error("reference policy produced no cells with source files");
  const include = [...new Set(manifestCells.flatMap((cell) => cell.ownedPaths))].sort((left, right) => left.localeCompare(right));
  return {
    manifest: {
      schemaVersion: manifestSchemaVersion,
      governance: {
        requireOwnership: true,
        include,
        exclude: scope === "production" ? productionScopeExcludes : [],
        requiredRules: defaultRequiredRules,
      },
      cells: manifestCells,
    },
    provenance: {
      schemaVersion: "cellfence.upstream-policy-oracle.provenance.v1",
      subjectId: subject.id,
      policy: {
        strategy: "package-workspaces",
        packageRoot,
        scope,
      },
      packageRoots,
      policySources: provenanceSources.sort((left, right) => left.path.localeCompare(right.path)),
    },
  };
}

function manifestCellMap(manifest) {
  return new Map((manifest.cells || []).map((cell) => [cell.id, cell]));
}

function edgeSet(manifest) {
  const edges = new Set();
  for (const cell of manifest.cells || []) {
    for (const consume of cell.consumes || []) {
      if (consume && typeof consume.cell === "string") edges.add(`${cell.id}->${consume.cell}`);
    }
  }
  return edges;
}

function setIntersectionSize(left, right) {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

function ownerForPath(manifest, relativePath) {
  for (const cell of manifest.cells || []) {
    if ((cell.ownedPaths || []).some((pattern) => matchesPattern(relativePath, pattern))) return cell.id;
  }
  return null;
}

function safeRatio(numerator, denominator) {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(6));
}

function countRatio(numerator, denominator) {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(6));
}

function compareManifests(rootDir, referenceManifest, inferredManifest, scope) {
  const referenceCells = manifestCellMap(referenceManifest);
  const inferredCells = manifestCellMap(inferredManifest);
  const referenceIds = new Set(referenceCells.keys());
  const inferredIds = new Set(inferredCells.keys());
  const commonIds = new Set([...referenceIds].filter((id) => inferredIds.has(id)));
  const sourcePaths = sourceFiles(rootDir)
    .map((filePath) => repoPath(rootDir, filePath))
    .filter((relativePath) => !pathExcludedByScope(scope, relativePath));
  const referenceOwnedPaths = sourcePaths.filter((relativePath) => ownerForPath(referenceManifest, relativePath));
  let ownershipMatches = 0;
  let inferredUnownedReferenceFiles = 0;
  for (const relativePath of referenceOwnedPaths) {
    const referenceOwner = ownerForPath(referenceManifest, relativePath);
    const inferredOwner = ownerForPath(inferredManifest, relativePath);
    if (referenceOwner === inferredOwner) ownershipMatches += 1;
    if (!inferredOwner) inferredUnownedReferenceFiles += 1;
  }
  const publicEntryComparisons = [...commonIds].map((id) => ({
    cell: id,
    reference: referenceCells.get(id)?.publicEntry || null,
    inferred: inferredCells.get(id)?.publicEntry || null,
    match: referenceCells.get(id)?.publicEntry === inferredCells.get(id)?.publicEntry,
  }));
  const publicEntryMatches = publicEntryComparisons.filter((entry) => entry.match).length;
  const referenceEdges = edgeSet(referenceManifest);
  const inferredEdges = edgeSet(inferredManifest);
  const edgeIntersection = setIntersectionSize(referenceEdges, inferredEdges);
  return {
    cellIds: {
      reference: referenceIds.size,
      inferred: inferredIds.size,
      common: commonIds.size,
      missingInferred: [...referenceIds].filter((id) => !inferredIds.has(id)).sort((left, right) => left.localeCompare(right)),
      extraInferred: [...inferredIds].filter((id) => !referenceIds.has(id)).sort((left, right) => left.localeCompare(right)),
      precision: safeRatio(commonIds.size, inferredIds.size),
      recall: safeRatio(commonIds.size, referenceIds.size),
    },
    ownership: {
      referenceOwnedFiles: referenceOwnedPaths.length,
      matches: ownershipMatches,
      inferredUnownedReferenceFiles,
      agreement: safeRatio(ownershipMatches, referenceOwnedPaths.length),
    },
    publicEntries: {
      compared: publicEntryComparisons.length,
      matches: publicEntryMatches,
      exactMatchRate: safeRatio(publicEntryMatches, publicEntryComparisons.length),
      mismatches: publicEntryComparisons.filter((entry) => !entry.match),
    },
    consumerEdges: {
      reference: referenceEdges.size,
      inferred: inferredEdges.size,
      common: edgeIntersection,
      missingInferred: [...referenceEdges].filter((edge) => !inferredEdges.has(edge)).sort((left, right) => left.localeCompare(right)),
      extraInferred: [...inferredEdges].filter((edge) => !referenceEdges.has(edge)).sort((left, right) => left.localeCompare(right)),
      precision: safeRatio(edgeIntersection, inferredEdges.size),
      recall: safeRatio(edgeIntersection, referenceEdges.size),
    },
  };
}

function questionId(subjectId, decisionKey) {
  return `PQ-${hashText(`${subjectId}:${JSON.stringify(decisionKey)}`).slice(0, 12)}`;
}

function cellIndex(manifest, cellId) {
  return (manifest.cells || []).findIndex((cell) => cell.id === cellId);
}

function findingCountsByRule(findings) {
  const counts = {};
  for (const finding of findings || []) {
    counts[finding.ruleId] = (counts[finding.ruleId] || 0) + 1;
  }
  return counts;
}

function findingFingerprint(finding) {
  return hashText(stableCanonicalJson({
    ruleId: finding.ruleId,
    severity: finding.severity,
    filePath: finding.filePath || null,
    line: finding.line || null,
    cellId: finding.cellId || null,
    producerCellId: finding.producerCellId || null,
    message: finding.message || null,
    details: finding.details || null,
  })).slice(0, 24);
}

const policyQuestionFindingRules = new Set([
  "CELLFENCE_PRIVATE_IMPORT",
  "CELLFENCE_UNDECLARED_CONSUMER",
  "CELLFENCE_PUBLIC_ENTRY_MISSING",
  "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
]);

function findingsForDecisionKey(findings, decisionKey) {
  if (!Array.isArray(findings) || findings.length === 0) return [];
  if (decisionKey.kind === "consumer-visibility") {
    return findings.filter((finding) => (
      finding.cellId === decisionKey.sourceCell
      && finding.producerCellId === decisionKey.targetCell
      && ["CELLFENCE_PRIVATE_IMPORT", "CELLFENCE_UNDECLARED_CONSUMER"].includes(finding.ruleId)
    ));
  }
  if (decisionKey.kind === "consumer-deny") {
    return findings.filter((finding) => (
      finding.cellId === decisionKey.sourceCell
      && finding.producerCellId === decisionKey.targetCell
    ));
  }
  if (decisionKey.kind === "public-entry") {
    return findings.filter((finding) => (
      finding.cellId === decisionKey.cell
      && ["CELLFENCE_PUBLIC_ENTRY_MISSING", "CELLFENCE_PUBLIC_SYMBOL_MISMATCH"].includes(finding.ruleId)
    ));
  }
  if (decisionKey.kind === "cell-boundary") {
    return findings.filter((finding) => finding.cellId === decisionKey.cell || finding.producerCellId === decisionKey.cell);
  }
  return [];
}

function affectedFindingFingerprints(findings, decisionKey) {
  return findingsForDecisionKey(findings, decisionKey).map((finding) => findingFingerprint(finding)).sort((left, right) => left.localeCompare(right));
}

function affectedFindingCount(findings, decisionKey) {
  return findingsForDecisionKey(findings, decisionKey).length;
}

function mappedFindingCoverage(questions, beforeFindings, afterFindings) {
  const allBefore = new Set((beforeFindings || []).map((finding) => findingFingerprint(finding)));
  const policyRelevant = new Set((beforeFindings || [])
    .filter((finding) => policyQuestionFindingRules.has(finding.ruleId))
    .map((finding) => findingFingerprint(finding)));
  const after = new Set((afterFindings || []).map((finding) => findingFingerprint(finding)));
  const mapping = new Map();
  for (const question of questions) {
    for (const fingerprint of question.affectedFindingFingerprints || []) {
      const questionIds = mapping.get(fingerprint) || [];
      questionIds.push(question.questionId);
      mapping.set(fingerprint, questionIds);
    }
  }
  const mapped = new Set(mapping.keys());
  const overlappingMappings = [...mapping.values()].filter((questionIds) => questionIds.length > 1).length;
  const zeroImpactQuestions = questions.filter((question) => (question.affectedFindingFingerprints || []).length === 0).length;
  const mappedPolicyRelevant = [...mapped].filter((fingerprint) => policyRelevant.has(fingerprint)).length;
  const unmappedPolicyRelevant = [...policyRelevant].filter((fingerprint) => !mapped.has(fingerprint)).length;
  const mappedResolved = [...mapped].filter((fingerprint) => !after.has(fingerprint)).length;
  const actionablePolicyQuestions = questions.length - zeroImpactQuestions;
  return {
    rawFindings: allBefore.size,
    policyRelevantFindings: policyRelevant.size,
    uniquelyMappedFindings: mapped.size,
    mappedPolicyRelevantFindings: mappedPolicyRelevant,
    unmappedFindings: [...allBefore].filter((fingerprint) => !mapped.has(fingerprint)).length,
    unmappedPolicyRelevantFindings: unmappedPolicyRelevant,
    zeroImpactQuestions,
    overlappingMappings,
    projectedResolvedFindings: mapped.size,
    observedResolvedMappedFindings: mappedResolved,
    observedTotalFindingReduction: (beforeFindings || []).length - (afterFindings || []).length,
    actionablePolicyQuestions,
    observedResolvedFindingToActionableQuestionRatio: countRatio(mappedResolved, actionablePolicyQuestions),
  };
}

function createChoice(id, label, manifestPatch, semanticPatch, oracleMatchesReference = true) {
  return {
    id,
    label,
    oracleMatchesReference,
    manifestPatch,
    semanticPatch,
  };
}

function generateQuestions(subjectId, referenceManifest, inferredManifest, comparison, checkFindings) {
  const referenceCells = manifestCellMap(referenceManifest);
  const inferredCells = manifestCellMap(inferredManifest);
  const questions = [];
  for (const cellId of comparison.cellIds.missingInferred) {
    const referenceCell = referenceCells.get(cellId);
    const decisionKey = { kind: "cell-boundary", action: "add-reference-cell", cell: cellId };
    questions.push({
      schemaVersion: questionSchemaVersion,
      questionId: questionId(subjectId, decisionKey),
      subjectId,
      decisionKey,
      prompt: `Should ${cellId} be imported as a CellFence cell from the upstream-declared reference policy?`,
      affectedFindings: affectedFindingCount(checkFindings, decisionKey),
      evidence: {
        referenceOwnedPaths: referenceCell?.ownedPaths || [],
        referencePublicEntry: referenceCell?.publicEntry || null,
      },
      choices: [
        createChoice(
          "import-reference-cell",
          "Import the upstream-declared cell boundary.",
          [{ op: "add", path: "/cells/-", value: referenceCell }],
          [{ op: "add-cell", value: referenceCell }],
        ),
      ],
      oracleAnswer: "import-reference-cell",
    });
  }
  for (const cellId of comparison.cellIds.extraInferred) {
    const index = cellIndex(inferredManifest, cellId);
    const decisionKey = { kind: "cell-boundary", action: "remove-extra-cell", cell: cellId };
    questions.push({
      schemaVersion: questionSchemaVersion,
      questionId: questionId(subjectId, decisionKey),
      subjectId,
      decisionKey,
      prompt: `Should ${cellId} be removed because it is not present in the upstream-declared reference policy?`,
      affectedFindings: affectedFindingCount(checkFindings, decisionKey),
      evidence: {
        inferredOwnedPaths: inferredCells.get(cellId)?.ownedPaths || [],
        inferredPublicEntry: inferredCells.get(cellId)?.publicEntry || null,
      },
      choices: [
        createChoice(
          "remove-extra-cell",
          "Remove the extra inferred cell.",
          index >= 0 ? [{ op: "remove", path: `/cells/${index}` }] : [],
          [{ op: "remove-cell", cell: cellId }],
        ),
      ],
      oracleAnswer: "remove-extra-cell",
    });
  }
  for (const edge of comparison.consumerEdges.missingInferred) {
    const [sourceCell, targetCell] = edge.split("->");
    const sourceIndex = cellIndex(inferredManifest, sourceCell);
    const decisionKey = { kind: "consumer-visibility", sourceCell, targetCell };
    questions.push({
      schemaVersion: questionSchemaVersion,
      questionId: questionId(subjectId, decisionKey),
      subjectId,
      decisionKey,
      prompt: `Can ${sourceCell} consume ${targetCell} through ${targetCell}'s public entry?`,
      affectedFindings: affectedFindingCount(checkFindings, decisionKey),
      evidence: {
        upstreamWorkspaceDependency: true,
        referenceEdge: edge,
        inferredEdgePresent: false,
        targetPublicEntry: referenceCells.get(targetCell)?.publicEntry || null,
      },
      choices: [
        createChoice(
          "public-only",
          "Allow consumption through the target cell public entry.",
          sourceIndex >= 0 ? [{ op: "add", path: `/cells/${sourceIndex}/consumes/-`, value: { cell: targetCell } }] : [],
          [{ op: "add-consume", cell: sourceCell, value: { cell: targetCell } }],
        ),
        createChoice(
          "deny",
          "Deny this consumer edge.",
          [],
          [],
          false,
        ),
      ],
      oracleAnswer: "public-only",
    });
  }
  for (const edge of comparison.consumerEdges.extraInferred) {
    const [sourceCell, targetCell] = edge.split("->");
    const sourceIndex = cellIndex(inferredManifest, sourceCell);
    const source = inferredCells.get(sourceCell);
    const consumeIndex = (source?.consumes || []).findIndex((consume) => consume.cell === targetCell);
    const decisionKey = { kind: "consumer-deny", sourceCell, targetCell };
    questions.push({
      schemaVersion: questionSchemaVersion,
      questionId: questionId(subjectId, decisionKey),
      subjectId,
      decisionKey,
      prompt: `Should the inferred ${sourceCell}->${targetCell} consumer edge be denied because upstream policy does not declare it?`,
      affectedFindings: affectedFindingCount(checkFindings, decisionKey),
      evidence: {
        upstreamWorkspaceDependency: false,
        inferredEdge: edge,
      },
      choices: [
        createChoice(
          "deny",
          "Remove the undeclared inferred consumer edge.",
          sourceIndex >= 0 && consumeIndex >= 0 ? [{ op: "remove", path: `/cells/${sourceIndex}/consumes/${consumeIndex}` }] : [],
          [{ op: "remove-consume", cell: sourceCell, targetCell }],
        ),
        createChoice(
          "allow",
          "Keep the inferred consumer edge.",
          [],
          [],
          false,
        ),
      ],
      oracleAnswer: "deny",
    });
  }
  for (const mismatch of comparison.publicEntries.mismatches) {
    const referenceCell = referenceCells.get(mismatch.cell);
    const sourceIndex = cellIndex(inferredManifest, mismatch.cell);
    const decisionKey = { kind: "public-entry", cell: mismatch.cell };
    questions.push({
      schemaVersion: questionSchemaVersion,
      questionId: questionId(subjectId, decisionKey),
      subjectId,
      decisionKey,
      prompt: `Should ${mismatch.cell}'s public entry match the upstream package entry?`,
      affectedFindings: affectedFindingCount(checkFindings, decisionKey),
      evidence: {
        referencePublicEntry: mismatch.reference,
        inferredPublicEntry: mismatch.inferred,
      },
      choices: [
        createChoice(
          "replace-public-entry",
          "Use the upstream-declared package entry.",
          sourceIndex >= 0
            ? [
              { op: "replace", path: `/cells/${sourceIndex}/publicEntry`, value: referenceCell?.publicEntry || mismatch.reference },
              { op: "replace", path: `/cells/${sourceIndex}/publicSymbols`, value: referenceCell?.publicSymbols || [] },
            ]
            : [],
          [{
            op: "replace-public-entry",
            cell: mismatch.cell,
            publicEntry: referenceCell?.publicEntry || mismatch.reference,
            publicSymbols: referenceCell?.publicSymbols || [],
          }],
        ),
      ],
      oracleAnswer: "replace-public-entry",
    });
  }
  return questions
    .map((question) => ({
      ...question,
      affectedFindings: affectedFindingCount(checkFindings, question.decisionKey),
      affectedFindingFingerprints: affectedFindingFingerprints(checkFindings, question.decisionKey),
    }))
    .sort((left, right) => left.questionId.localeCompare(right.questionId));
}

function applySemanticPatch(manifest, semanticPatch) {
  const next = JSON.parse(JSON.stringify(manifest));
  for (const operation of semanticPatch || []) {
    if (operation.op === "add-cell") {
      if (!next.cells.some((cell) => cell.id === operation.value.id)) next.cells.push(operation.value);
    } else if (operation.op === "remove-cell") {
      next.cells = next.cells.filter((cell) => cell.id !== operation.cell);
      for (const cell of next.cells) {
        cell.consumes = (cell.consumes || []).filter((consume) => consume.cell !== operation.cell);
      }
    } else if (operation.op === "add-consume") {
      const cell = next.cells.find((candidate) => candidate.id === operation.cell);
      if (!cell) continue;
      cell.consumes = Array.isArray(cell.consumes) ? cell.consumes : [];
      if (!cell.consumes.some((consume) => consume.cell === operation.value.cell)) cell.consumes.push(operation.value);
      cell.consumes.sort((left, right) => left.cell.localeCompare(right.cell));
    } else if (operation.op === "remove-consume") {
      const cell = next.cells.find((candidate) => candidate.id === operation.cell);
      if (!cell) continue;
      cell.consumes = (cell.consumes || []).filter((consume) => consume.cell !== operation.targetCell);
    } else if (operation.op === "replace-public-entry") {
      const cell = next.cells.find((candidate) => candidate.id === operation.cell);
      if (!cell) continue;
      cell.publicEntry = operation.publicEntry;
      cell.publicSymbols = operation.publicSymbols;
    }
  }
  next.cells.sort((left, right) => left.id.localeCompare(right.id));
  next.governance = next.governance || {};
  next.governance.include = [...new Set(next.cells.flatMap((cell) => cell.ownedPaths || []))].sort((left, right) => left.localeCompare(right));
  return next;
}

function applyOracleAnswers(inferredManifest, questions) {
  let resolvedManifest = JSON.parse(JSON.stringify(inferredManifest));
  const answers = [];
  for (const question of questions) {
    const choice = question.choices.find((candidate) => candidate.id === question.oracleAnswer);
    if (!choice) continue;
    resolvedManifest = applySemanticPatch(resolvedManifest, choice.semanticPatch);
    answers.push({
      questionId: question.questionId,
      decisionKey: question.decisionKey,
      answer: choice.id,
      oracleSource: "upstream-declared-reference-policy",
      manifestPatch: choice.manifestPatch,
      semanticPatch: choice.semanticPatch,
    });
  }
  return { resolvedManifest, answers };
}

function questionKindCounts(questions) {
  const counts = {};
  for (const question of questions) {
    const kind = question.decisionKey?.kind || "unknown";
    counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

function firstSourceOwnedByCell(rootDir, manifest, cellId, options = {}) {
  const cell = manifestCellMap(manifest).get(cellId);
  if (!cell) return undefined;
  const files = sourceFiles(rootDir)
    .map((filePath) => repoPath(rootDir, filePath))
    .filter((relativePath) => !pathExcludedByScope(options.scope, relativePath))
    .filter((relativePath) => (cell.ownedPaths || []).some((pattern) => matchesPattern(relativePath, pattern)))
    .filter((relativePath) => !options.exclude?.includes(relativePath))
    .sort((left, right) => left.localeCompare(right));
  return files[0];
}

function generateMutationPlans(rootDir, subjectId, referenceManifest, scope) {
  const referenceCells = manifestCellMap(referenceManifest);
  const plans = [];
  for (const edge of edgeSet(referenceManifest)) {
    const [sourceCell, targetCell] = edge.split("->");
    const sourceFile = firstSourceOwnedByCell(rootDir, referenceManifest, sourceCell, { scope });
    const target = referenceCells.get(targetCell);
    if (sourceFile && target?.publicEntry) {
      plans.push({
        id: `MUT-${hashText(`${subjectId}:allowed:${edge}`).slice(0, 12)}`,
        kind: "allowed-public-import",
        sourceCell,
        targetCell,
        sourceFile,
        targetFile: target.publicEntry,
        expectedOutcome: "accepted",
        executionStatus: "planned-only-v1",
      });
    }
    const privateTargetFile = firstSourceOwnedByCell(rootDir, referenceManifest, targetCell, {
      scope,
      exclude: target?.publicEntry ? [target.publicEntry] : [],
    });
    if (sourceFile && privateTargetFile) {
      plans.push({
        id: `MUT-${hashText(`${subjectId}:private:${edge}`).slice(0, 12)}`,
        kind: "private-import",
        sourceCell,
        targetCell,
        sourceFile,
        targetFile: privateTargetFile,
        expectedOutcome: "rejected",
        expectedRuleId: "CELLFENCE_PRIVATE_IMPORT",
        executionStatus: "planned-only-v1",
      });
    }
  }
  return {
    schemaVersion: mutationSchemaVersion,
    subjectId,
    status: "planned-only-v1",
    plans: plans.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function discardCheckoutIfRequested(subjectResult, subjectDir, options) {
  if (!options.discardCheckouts || options.dryRun) return subjectResult;
  fs.rmSync(path.join(subjectDir, "checkout"), { recursive: true, force: true });
  return {
    ...subjectResult,
    checkoutDiscarded: true,
  };
}

async function runSubject(subject, options, engine) {
  const subjectDir = subjectDirectory(options.workDir, subject.id);
  fs.rmSync(subjectDir, { recursive: true, force: true });
  fs.mkdirSync(subjectDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  const base = {
    id: subject.id,
    repository: subject.repository,
    requestedCommit: subject.commit || null,
    requestedRef: subject.ref || null,
    startedAt,
    subjectDir,
  };
  if (options.dryRun) {
    return {
      ...base,
      status: "planned",
      policy: {
        strategy: subject.policy?.strategy || "package-workspaces",
        packageRoot: subject.policy?.packageRoot || ".",
        scope: subject.policy?.scope || "production",
      },
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAtMs),
    };
  }
  try {
    const clone = cloneSubject(subject, subjectDir, options);
    const worktreeBefore = gitWorktreeStatus(clone.checkoutDir, subjectDir, "status-before-oracle");
    const scope = subject.policy?.scope || options.blindScope;
    const reference = createReferenceManifest(clone.checkoutDir, subject);
    const inferredManifest = engine.inferManifest({
      rootDir: clone.checkoutDir,
      scope: options.blindScope,
      packagePolicyHints: "ignore",
    });
    const artifactPaths = {
      referenceManifest: path.join(options.outDir, "references", `${slugSubjectId(subject.id)}.reference-manifest.json`),
      provenance: path.join(options.outDir, "provenance", `${slugSubjectId(subject.id)}.provenance.json`),
      inferredManifest: path.join(options.outDir, "inferred", `${slugSubjectId(subject.id)}.manifest.json`),
      questions: path.join(options.outDir, "questions", `${slugSubjectId(subject.id)}.questions.json`),
      oracleAnswers: path.join(options.outDir, "oracle-answers", `${slugSubjectId(subject.id)}.answers.json`),
      resolvedManifest: path.join(options.outDir, "resolved-manifests", `${slugSubjectId(subject.id)}.manifest.json`),
      mutations: path.join(options.outDir, "mutations", `${slugSubjectId(subject.id)}.mutations.json`),
    };
    writeJson(artifactPaths.referenceManifest, reference.manifest);
    writeJson(artifactPaths.provenance, reference.provenance);
    writeJson(artifactPaths.inferredManifest, inferredManifest);
    const checkResult = engine.checkRepository({
      rootDir: clone.checkoutDir,
      manifestPath: artifactPaths.inferredManifest,
    });
    const comparisonBefore = compareManifests(clone.checkoutDir, reference.manifest, inferredManifest, scope);
    const questions = generateQuestions(subject.id, reference.manifest, inferredManifest, comparisonBefore, checkResult.findings);
    writeJson(artifactPaths.questions, {
      schemaVersion: "cellfence.policy-questions.v1",
      subjectId: subject.id,
      questions,
      summary: {
        total: questions.length,
        byKind: questionKindCounts(questions),
        affectedFindings: questions.reduce((sum, question) => sum + Number(question.affectedFindings || 0), 0),
      },
    });
    const resolved = applyOracleAnswers(inferredManifest, questions);
    const answersArtifact = {
      schemaVersion: oracleAnswersSchemaVersion,
      subjectId: subject.id,
      oracle: "upstream-declared-reference-policy",
      answers: resolved.answers,
    };
    writeJson(artifactPaths.oracleAnswers, answersArtifact);
    writeJson(artifactPaths.resolvedManifest, resolved.resolvedManifest);
    const resolvedCheckResult = engine.checkRepository({
      rootDir: clone.checkoutDir,
      manifestPath: artifactPaths.resolvedManifest,
    });
    const comparisonAfter = compareManifests(clone.checkoutDir, reference.manifest, resolved.resolvedManifest, scope);
    const findingMapping = mappedFindingCoverage(questions, checkResult.findings, resolvedCheckResult.findings);
    const mutationPlans = generateMutationPlans(clone.checkoutDir, subject.id, reference.manifest, scope);
    writeJson(artifactPaths.mutations, mutationPlans);
    const worktreeAfter = gitWorktreeStatus(clone.checkoutDir, subjectDir, "status-after-oracle");
    if (!worktreeAfter.clean) {
      throw new SubjectFailure("oracle", "dirty_worktree", "oracle run modified the subject checkout", {
        worktreeStatus: worktreeAfter.porcelain,
      });
    }
    const artifacts = Object.fromEntries(Object.entries(artifactPaths).map(([key, filePath]) => [
      key,
      {
        path: path.relative(repoRoot, filePath),
        sha256: hashFile(filePath),
      },
    ]));
    const result = {
      ...base,
      status: "completed",
      commit: clone.actualCommit,
      gitTree: clone.gitTree,
      cloneMode: options.cloneMode,
      subjectWorktreeCleanBefore: worktreeBefore.clean,
      subjectWorktreeCleanAfter: worktreeAfter.clean,
      policy: reference.provenance.policy,
      artifacts,
      artifactSetSha256: canonicalSha256(artifactDigestSet(artifacts)),
      reference: {
        cells: reference.manifest.cells.length,
        consumerEdges: edgeSet(reference.manifest).size,
        policySources: reference.provenance.policySources.length,
      },
      blindInference: {
        scope: options.blindScope,
        packagePolicyHints: "ignore",
        ablation: "entry-and-dependency-hints",
        cells: inferredManifest.cells.length,
        consumerEdges: edgeSet(inferredManifest).size,
      },
      check: {
        ok: checkResult.ok,
        exitCode: checkResult.exitCode,
        findings: checkResult.findings.length,
        warnings: checkResult.warnings.length,
        findingsByRule: findingCountsByRule(checkResult.findings),
      },
      resolvedCheck: {
        ok: resolvedCheckResult.ok,
        exitCode: resolvedCheckResult.exitCode,
        findings: resolvedCheckResult.findings.length,
        warnings: resolvedCheckResult.warnings.length,
        findingsByRule: findingCountsByRule(resolvedCheckResult.findings),
      },
      comparisonBefore,
      policyQuestions: {
        total: questions.length,
        byKind: questionKindCounts(questions),
        affectedFindings: questions.reduce((sum, question) => sum + Number(question.affectedFindings || 0), 0),
        rawFindingToPolicyQuestionCountRatio: countRatio(checkResult.findings.length, questions.length),
        oracleResolvable: questions.filter((question) => question.oracleAnswer).length,
        findingMapping,
      },
      comparisonAfter,
      mutations: {
        status: mutationPlans.status,
        planned: mutationPlans.plans.length,
      },
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAtMs),
    };
    return discardCheckoutIfRequested(result, subjectDir, options);
  } catch (error) {
    const result = {
      ...base,
      status: error instanceof SubjectFailure ? `${error.stage}_failed` : "failed",
      stage: error instanceof SubjectFailure ? error.stage : undefined,
      failureKind: error instanceof SubjectFailure ? error.failureKind : "error",
      timeoutMs: error instanceof SubjectFailure ? error.timeoutMs : undefined,
      exitCode: error instanceof SubjectFailure ? error.exitCode : undefined,
      worktreeStatus: error instanceof SubjectFailure ? error.worktreeStatus : undefined,
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAtMs),
    };
    return discardCheckoutIfRequested(result, subjectDir, options);
  }
}

function readTextIfOk(command, args) {
  const result = run(command, args, { cwd: repoRoot, timeoutMs: 30_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function environmentMetadata(corpusPath) {
  const packageJson = readJson(path.join(repoRoot, "package.json"));
  const harnessCommit = readTextIfOk("git", ["rev-parse", "HEAD"]);
  const gitStatus = readTextIfOk("git", ["status", "--short"]);
  return {
    harnessCommit,
    harnessDirty: gitStatus === null ? null : gitStatus.length > 0,
    cellfenceVersion: packageJson.version,
    cellfenceSourceCommit: harnessCommit,
    engineDistSha256: fs.existsSync(engineDist) ? hashFile(engineDist) : null,
    corpusSha256: hashFile(corpusPath),
    nodeVersion: process.version,
    gitVersion: readTextIfOk("git", ["--version"]),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

function sumSubjectMetric(subjects, getter) {
  return subjects.reduce((sum, subject) => sum + Number(getter(subject) || 0), 0);
}

function averageRatio(subjects, getter) {
  const values = subjects.map(getter).filter((value) => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6));
}

function summarizeConsumerEdges(subjects, comparisonKey) {
  const comparisons = subjects.map((subject) => subject[comparisonKey]?.consumerEdges).filter(Boolean);
  const reference = comparisons.reduce((sum, comparison) => sum + Number(comparison.reference || 0), 0);
  const inferred = comparisons.reduce((sum, comparison) => sum + Number(comparison.inferred || 0), 0);
  const common = comparisons.reduce((sum, comparison) => sum + Number(comparison.common || 0), 0);
  return {
    reference,
    inferred,
    common,
    microPrecision: safeRatio(common, inferred),
    microRecall: safeRatio(common, reference),
    subjectMacroPrecision: averageRatio(subjects, (subject) => subject[comparisonKey]?.consumerEdges?.precision),
    subjectMacroRecall: averageRatio(subjects, (subject) => subject[comparisonKey]?.consumerEdges?.recall),
    subjectsWithExactEdgeSetAgreement: comparisons.filter((comparison) => (
      (comparison.missingInferred || []).length === 0
      && (comparison.extraInferred || []).length === 0
    )).length,
    subjectsWithNoReferenceConsumerEdges: comparisons.filter((comparison) => Number(comparison.reference || 0) === 0).length,
    subjectsWithNoInferredConsumerEdges: comparisons.filter((comparison) => Number(comparison.inferred || 0) === 0).length,
  };
}

function summarizeFindingMappings(subjects, policyQuestions) {
  const totals = {
    rawFindings: 0,
    policyRelevantFindings: 0,
    uniquelyMappedFindings: 0,
    mappedPolicyRelevantFindings: 0,
    unmappedFindings: 0,
    unmappedPolicyRelevantFindings: 0,
    zeroImpactQuestions: 0,
    overlappingMappings: 0,
    projectedResolvedFindings: 0,
    observedResolvedMappedFindings: 0,
    observedTotalFindingReduction: 0,
  };
  for (const subject of subjects) {
    const mapping = subject.policyQuestions?.findingMapping || {};
    for (const key of Object.keys(totals)) totals[key] += Number(mapping[key] || 0);
  }
  return {
    ...totals,
    actionablePolicyQuestions: policyQuestions - totals.zeroImpactQuestions,
    observedResolvedFindingToActionableQuestionRatio: countRatio(totals.observedResolvedMappedFindings, policyQuestions - totals.zeroImpactQuestions),
  };
}

function aggregateQuestionKinds(subjects) {
  const counts = {};
  for (const subject of subjects) {
    for (const [kind, count] of Object.entries(subject.policyQuestions?.byKind || {})) {
      counts[kind] = (counts[kind] || 0) + count;
    }
  }
  return counts;
}

function summarize(subjects) {
  const completedSubjects = subjects.filter((subject) => subject.status === "completed");
  const failedSubjects = subjects.filter((subject) => !["completed", "planned"].includes(subject.status));
  const plannedSubjects = subjects.filter((subject) => subject.status === "planned");
  const policyQuestions = sumSubjectMetric(completedSubjects, (subject) => subject.policyQuestions?.total);
  const rawFindings = sumSubjectMetric(completedSubjects, (subject) => subject.check?.findings);
  return {
    total: subjects.length,
    completed: completedSubjects.length,
    planned: plannedSubjects.length,
    failed: failedSubjects.length,
    rawFindings,
    policyQuestions,
    rawFindingToPolicyQuestionCountRatio: countRatio(rawFindings, policyQuestions),
    oracleResolvableQuestions: sumSubjectMetric(completedSubjects, (subject) => subject.policyQuestions?.oracleResolvable),
    questionKinds: aggregateQuestionKinds(completedSubjects),
    findingMapping: summarizeFindingMappings(completedSubjects, policyQuestions),
    mutationPlans: sumSubjectMetric(completedSubjects, (subject) => subject.mutations?.planned),
    artifactSetSha256: canonicalSha256(completedSubjects.map((subject) => ({
      id: subject.id,
      artifactSetSha256: subject.artifactSetSha256,
    })).sort((left, right) => left.id.localeCompare(right.id))),
    before: {
      ownershipAgreementSubjectMacro: averageRatio(completedSubjects, (subject) => subject.comparisonBefore?.ownership?.agreement),
      publicEntryExactMatchRateSubjectMacro: averageRatio(completedSubjects, (subject) => subject.comparisonBefore?.publicEntries?.exactMatchRate),
      consumerEdges: summarizeConsumerEdges(completedSubjects, "comparisonBefore"),
    },
    after: {
      ownershipAgreementSubjectMacro: averageRatio(completedSubjects, (subject) => subject.comparisonAfter?.ownership?.agreement),
      publicEntryExactMatchRateSubjectMacro: averageRatio(completedSubjects, (subject) => subject.comparisonAfter?.publicEntries?.exactMatchRate),
      consumerEdges: summarizeConsumerEdges(completedSubjects, "comparisonAfter"),
    },
    failureKinds: failedSubjects.reduce((counts, subject) => {
      const key = subject.failureKind || subject.status;
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {}),
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (!options.dryRun && !fs.existsSync(engineDist)) {
    console.error("CellFence engine dist is missing; run npm run build before the upstream policy oracle");
    return 2;
  }

  let corpus;
  try {
    corpus = readJson(options.corpusPath);
    validateCorpus(corpus, options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  fs.rmSync(options.outDir, { recursive: true, force: true });
  fs.mkdirSync(options.outDir, { recursive: true });
  fs.mkdirSync(options.workDir, { recursive: true });
  fs.copyFileSync(options.corpusPath, path.join(options.outDir, "corpus.json"));

  const engine = options.dryRun
    ? undefined
    : await import(pathToFileURL(engineDist).href);
  const selectedSubjects = corpus.subjects.slice(0, options.maxSubjects || corpus.subjects.length);
  const subjects = [];
  for (const subject of selectedSubjects) {
    subjects.push(await runSubject(subject, options, engine));
  }

  const report = {
    schemaVersion: reportSchemaVersion,
    generatedAt: new Date().toISOString(),
    corpusPath: options.corpusPath,
    outDir: options.outDir,
    workDir: options.workDir,
    dryRun: options.dryRun,
    cloneMode: options.cloneMode,
    discardCheckouts: options.discardCheckouts,
    blindScope: options.blindScope,
    environment: environmentMetadata(options.corpusPath),
    subjects,
    summary: summarize(subjects),
  };
  writeJson(path.join(options.outDir, "report.json"), report);
  console.log(JSON.stringify(report.summary, null, 2));
  return report.summary.failed > 0 ? 1 : 0;
}

process.exitCode = await main();
