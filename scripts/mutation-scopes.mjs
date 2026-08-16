import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const repositoryTempKey = Buffer.from(repositoryRoot).toString("hex").slice(0, 16);
const officialPluginTest = "tests/official-plugins.test.mjs";

const authoritativeThresholds = Object.freeze({ high: 100, low: 100, break: 100 });
const officialRuleMetadataPattern = "official plugin metadata is stable and machine-readable";
const officialRuleSmokePattern = "official rule plugins produce concrete findings";
const officialRuleBranchPattern = "official rule plugins cover pass, warning, and secondary budget branches";
const officialRuleDefaultsPattern = "official plugins cover direct rule default and empty-edge branches";
const opentelemetryAdapterMutationPattern = [
  "opentelemetry adapter handles",
  "opentelemetry adapter mutation smoke",
  "opentelemetry adapter ignores",
  "opentelemetry adapter covers",
  "opentelemetry adapter preserves",
  "opentelemetry adapter applies",
  "opentelemetry adapter recognizes",
  "opentelemetry adapter distinguishes",
].join("|");

export const MUTATION_INFRASTRUCTURE_PATHS = Object.freeze([
  ".github/workflows/ci.yml",
  ".github/workflows/mutation-audit.yml",
  ".github/workflows/npm-publish.yml",
  "package-lock.json",
  "package.json",
  "stryker.changed.conf.mjs",
  "stryker.conf.mjs",
]);

export const MUTATION_SCOPES = Object.freeze([
  {
    id: "schema",
    source: "packages/schema/src/index.ts",
    sources: [
      "packages/schema/schemas/baseline.schema.json",
      "packages/schema/schemas/manifest.schema.json",
      "packages/schema/schemas/resource-evidence.schema.json",
    ],
    mutate: "packages/schema/dist/index.js",
    tests: ["tests/schema-validation.test.mjs", officialPluginTest],
    testNamePatterns: {
      [officialPluginTest]: opentelemetryAdapterMutationPattern,
    },
  },
  {
    id: "plugin-api",
    source: "packages/plugin-api/src/index.ts",
    mutate: "packages/plugin-api/dist/index.js",
    tests: ["tests/plugin-api.test.mjs", officialPluginTest],
    testNamePatterns: {
      [officialPluginTest]: officialRuleMetadataPattern,
    },
  },
  {
    id: "adapter-call-pattern",
    source: "packages/adapter-call-pattern/src/index.ts",
    mutate: "packages/adapter-call-pattern/dist/index.js",
    tests: [officialPluginTest],
    testNamePatterns: {
      [officialPluginTest]: "declarative call-pattern adapter",
    },
  },
  {
    id: "adapter-opentelemetry",
    source: "packages/adapter-opentelemetry/src/index.ts",
    mutate: "packages/adapter-opentelemetry/dist/index.js",
    tests: [officialPluginTest],
    testNamePatterns: {
      [officialPluginTest]: opentelemetryAdapterMutationPattern,
    },
  },
  {
    id: "plugin-agent-budget",
    source: "packages/plugin-agent-budget/src/index.ts",
    sources: ["packages/plugin-agent-budget/src/glob.ts"],
    mutate: "packages/plugin-agent-budget/dist/index.js",
    tests: [officialPluginTest],
    testNamePatterns: {
      [officialPluginTest]: [
        "agent budget",
        "path matchers agree",
        officialRuleMetadataPattern,
        officialRuleSmokePattern,
        officialRuleBranchPattern,
        officialRuleDefaultsPattern,
      ].join("|"),
    },
  },
  {
    id: "plugin-blast-radius",
    source: "packages/plugin-blast-radius/src/index.ts",
    sources: ["packages/plugin-blast-radius/src/glob.ts"],
    mutate: "packages/plugin-blast-radius/dist/index.js",
    tests: [officialPluginTest],
    testNamePatterns: {
      [officialPluginTest]: [
        "blast radius",
        "path matchers agree",
        officialRuleMetadataPattern,
        officialRuleSmokePattern,
        officialRuleDefaultsPattern,
      ].join("|"),
    },
  },
  {
    id: "plugin-dependency-sovereignty",
    source: "packages/plugin-dependency-sovereignty/src/index.ts",
    mutate: "packages/plugin-dependency-sovereignty/dist/index.js",
    tests: [officialPluginTest],
    testNamePatterns: {
      [officialPluginTest]: [
        "dependency sovereignty",
        officialRuleMetadataPattern,
        officialRuleSmokePattern,
        officialRuleDefaultsPattern,
      ].join("|"),
    },
  },
  {
    id: "plugin-geo-purity",
    source: "packages/plugin-geo-purity/src/index.ts",
    mutate: "packages/plugin-geo-purity/dist/index.js",
    tests: [officialPluginTest],
    testNamePatterns: {
      [officialPluginTest]: [
        "geo purity",
        officialRuleMetadataPattern,
        officialRuleSmokePattern,
        officialRuleBranchPattern,
        officialRuleDefaultsPattern,
      ].join("|"),
    },
  },
  {
    id: "plugin-legacy-strangler",
    source: "packages/plugin-legacy-strangler/src/index.ts",
    mutate: "packages/plugin-legacy-strangler/dist/index.js",
    tests: [officialPluginTest],
    testNamePatterns: {
      [officialPluginTest]: [
        "legacy strangler",
        officialRuleMetadataPattern,
        officialRuleSmokePattern,
        officialRuleDefaultsPattern,
      ].join("|"),
    },
  },
  {
    id: "plugin-quants-trend",
    source: "packages/plugin-quants-trend/src/index.ts",
    mutate: "packages/plugin-quants-trend/dist/index.js",
    tests: [officialPluginTest],
    testNamePatterns: {
      [officialPluginTest]: [
        "quants trend",
        officialRuleMetadataPattern,
        officialRuleSmokePattern,
        officialRuleDefaultsPattern,
      ].join("|"),
    },
  },
  {
    id: "reporter-economy-matrix",
    source: "packages/reporter-economy-matrix/src/index.ts",
    mutate: "packages/reporter-economy-matrix/dist/index.js",
    tests: [officialPluginTest],
    testNamePatterns: {
      [officialPluginTest]: [
        "economy matrix",
        officialRuleMetadataPattern,
      ].join("|"),
    },
  },
  {
    id: "trace",
    source: "packages/trace/src/index.ts",
    mutate: "packages/trace/dist/index.js",
    tests: ["tests/trace.test.mjs"],
  },
  {
    id: "engine-module-resolution",
    source: "packages/engine/src/module-resolution.ts",
    sources: [
      "packages/engine/src/file-index.ts",
      "packages/engine/src/python-analysis.ts",
      "packages/engine/src/python-inspector-runner.ts",
    ],
    mutate: "packages/engine/dist/module-resolution.js",
    tests: ["tests/module-resolution.test.mjs"],
    parallelConcurrency: 2,
  },
  {
    id: "engine-command-execution",
    source: "packages/engine/src/command-execution.ts",
    mutate: "packages/engine/dist/command-execution.js",
    tests: ["tests/command-execution.test.mjs"],
  },
  {
    id: "engine-file-index",
    source: "packages/engine/src/file-index.ts",
    sources: [
      "packages/engine/src/glob.ts",
      "packages/engine/src/glob-overlap.ts",
    ],
    mutate: "packages/engine/dist/file-index.js",
    tests: ["tests/file-index.test.mjs"],
  },
  {
    id: "engine-glob-overlap",
    source: "packages/engine/src/glob-overlap.ts",
    sources: ["packages/engine/src/file-index.ts"],
    mutate: "packages/engine/dist/glob-overlap.js",
    tests: ["tests/file-index.test.mjs"],
  },
  {
    id: "engine-resource-access",
    source: "packages/engine/src/resource-access.ts",
    sources: [
      "packages/engine/src/file-index.ts",
      "packages/engine/src/python-analysis.ts",
      "packages/engine/src/python-inspector-runner.ts",
    ],
    mutate: "packages/engine/dist/resource-access.js",
    tests: ["tests/resource-access-coverage.test.mjs"],
    parallelConcurrency: 2,
  },
  {
    id: "github-action",
    source: "packages/github-action/src/index.ts",
    mutate: "packages/github-action/dist/index.js",
    tests: ["tests/github-action.test.mjs"],
  },
  {
    id: "github-action-baseline-gate",
    source: "packages/github-action-baseline-gate/src/baseline-gate.ts",
    sources: ["packages/github-action-baseline-gate/src/index.ts"],
    mutate: "packages/github-action-baseline-gate/dist/baseline-gate.js",
    tests: ["tests/baseline-gate.test.mjs"],
  },
].map((scope) => Object.freeze({
  ...scope,
  sources: Object.freeze(scope.sources ? [...scope.sources] : []),
  tests: Object.freeze([...scope.tests]),
  testNamePatterns: Object.freeze({ ...(scope.testNamePatterns ?? {}) }),
  ...(scope.parallelConcurrency ? { parallelConcurrency: scope.parallelConcurrency } : {}),
})));

function scopeSourcePaths(scope) {
  return [scope.source, ...scope.sources];
}

function isWindowsAbsolutePath(filePath) {
  return /^[a-zA-Z]:\//.test(filePath);
}

function stripRootPrefix(filePath, rootDir) {
  const normalizedRoot = rootDir.replaceAll("\\", "/").replace(/\/$/, "");
  const lowerFilePath = filePath.toLowerCase();
  const lowerRoot = normalizedRoot.toLowerCase();
  if (lowerFilePath === lowerRoot) return "";
  if (lowerFilePath.startsWith(`${lowerRoot}/`)) return filePath.slice(normalizedRoot.length + 1);
  return undefined;
}

export function normalizeRepositoryPath(filePath, rootDir = repositoryRoot) {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.posix.isAbsolute(normalized) || isWindowsAbsolutePath(normalized)) {
    const prefixedPath = stripRootPrefix(normalized, rootDir);
    if (prefixedPath !== undefined) return prefixedPath.replace(/^\.\//, "");
    if (!isWindowsAbsolutePath(normalized) && path.isAbsolute(filePath)) {
      const relativePath = path.relative(rootDir, filePath);
      if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
        return relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
      }
    }
    throw new Error(`Path is outside the repository: ${filePath}`);
  }
  return normalized;
}

export function isMutationInfrastructurePath(filePath) {
  const normalized = normalizeRepositoryPath(filePath);
  return MUTATION_INFRASTRUCTURE_PATHS.includes(normalized)
    || /^scripts\/mutation-[^/]+\.mjs$/.test(normalized);
}

function scopeBelongsToWorkspace(scope, workspaceDir) {
  const prefix = `${workspaceDir}/`;
  return scopeSourcePaths(scope).some((sourcePath) => sourcePath.startsWith(prefix))
    || scope.mutate.startsWith(prefix);
}

function mutationScopesForNonInfrastructureFiles(normalizedFiles, scopes) {
  return scopes.filter(
    (scope) => scopeSourcePaths(scope).some((sourcePath) => normalizedFiles.has(sourcePath))
      || normalizedFiles.has(scope.mutate)
      || scope.tests.some((testPath) => normalizedFiles.has(testPath)),
  );
}

function mergeScopesInMatrixOrder(scopes, ...scopeGroups) {
  const selected = new Set(scopeGroups.flat().map((scope) => scope.id));
  return scopes.filter((scope) => selected.has(scope.id));
}

export function mutationScopesForFiles(filePaths, scopes = MUTATION_SCOPES, options = {}) {
  const normalizedFiles = new Set(filePaths.map((filePath) => normalizeRepositoryPath(filePath)));
  const infrastructureFiles = [...normalizedFiles].filter(isMutationInfrastructurePath);
  if (infrastructureFiles.some((filePath) => filePath !== "package-lock.json")) return scopes;

  const nonInfrastructureFiles = new Set(
    [...normalizedFiles].filter((filePath) => !isMutationInfrastructurePath(filePath)),
  );
  const directlySelectedScopes = mutationScopesForNonInfrastructureFiles(nonInfrastructureFiles, scopes);
  if (!normalizedFiles.has("package-lock.json")) return directlySelectedScopes;

  const packageLockWorkspaceDirs = options.packageLockWorkspaceDirs;
  if (!Array.isArray(packageLockWorkspaceDirs)) return scopes;

  const normalizedWorkspaceDirs = [...new Set(packageLockWorkspaceDirs.map((workspaceDir) => (
    normalizeRepositoryPath(workspaceDir).replace(/\/$/, "")
  )))];
  const lockfileScopes = scopes.filter((scope) => (
    normalizedWorkspaceDirs.some((workspaceDir) => scopeBelongsToWorkspace(scope, workspaceDir))
  ));
  return mergeScopesInMatrixOrder(scopes, directlySelectedScopes, lockfileScopes);
}

export function mutationScopeById(scopeId) {
  return MUTATION_SCOPES.find((scope) => scope.id === scopeId);
}

export function mutationScopeMatrix() {
  return MUTATION_SCOPES.map((scope) => ({ id: scope.id, source: scope.source }));
}

function shellQuote(argument) {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(argument)) return argument;
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

function nodeTestCommand(testFiles, testNamePattern) {
  const args = ["node", "--test"];
  if (testNamePattern) args.push("--test-name-pattern", testNamePattern);
  args.push(...testFiles);
  return args.map(shellQuote).join(" ");
}

export function mutationScopeTestCommand(scope) {
  const testNamePatterns = scope.testNamePatterns ?? {};
  const plainTests = scope.tests.filter((testPath) => !testNamePatterns[testPath]);
  const patternTests = scope.tests.filter((testPath) => testNamePatterns[testPath]);
  const commands = [];
  if (plainTests.length > 0) commands.push(nodeTestCommand(plainTests));
  for (const testPath of patternTests) {
    commands.push(nodeTestCommand([testPath], testNamePatterns[testPath]));
  }
  return commands.join(" && ");
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

export function validateMutationScopeCoverage(mutateTargets, scopes = MUTATION_SCOPES) {
  const duplicateScopeIds = duplicateValues(scopes.map((scope) => scope.id));
  const duplicateSources = duplicateValues(scopes.map((scope) => scope.source));
  const duplicateScopedTargets = duplicateValues(scopes.map((scope) => scope.mutate));
  const scopesWithoutTests = scopes.filter((scope) => scope.tests.length === 0).map((scope) => scope.id);
  const invalidScopes = [];
  if (duplicateScopeIds.length > 0) invalidScopes.push(`duplicate scope ids: ${duplicateScopeIds.join(", ")}`);
  if (duplicateSources.length > 0) invalidScopes.push(`duplicate sources: ${duplicateSources.join(", ")}`);
  if (duplicateScopedTargets.length > 0) {
    invalidScopes.push(`duplicate scoped targets: ${duplicateScopedTargets.join(", ")}`);
  }
  if (scopesWithoutTests.length > 0) invalidScopes.push(`scopes without tests: ${scopesWithoutTests.join(", ")}`);
  if (invalidScopes.length > 0) {
    throw new Error(`Invalid mutation scope map (${invalidScopes.join("; ")})`);
  }

  const configured = [...new Set(mutateTargets.map(normalizeRepositoryPath))].sort();
  const scoped = scopes.map((scope) => scope.mutate).sort();
  const missing = configured.filter((target) => !scoped.includes(target));
  const extra = scoped.filter((target) => !configured.includes(target));
  if (missing.length > 0 || extra.length > 0) {
    const messages = [];
    if (missing.length > 0) messages.push(`missing scopes: ${missing.join(", ")}`);
    if (extra.length > 0) messages.push(`unknown scopes: ${extra.join(", ")}`);
    throw new Error(`Mutation scope map does not match stryker.conf.mjs (${messages.join("; ")})`);
  }
}

export function validateMutationGovernanceConfig(config, options = {}) {
  const messages = [];
  for (const [key, expected] of Object.entries(authoritativeThresholds)) {
    if (config.thresholds?.[key] !== expected) messages.push(`thresholds.${key} must be ${expected}`);
  }
  if (options.requireNonIncremental && config.incremental !== false) {
    messages.push("full mutation config incremental must be false");
  }
  if (messages.length > 0) {
    throw new Error(`Invalid mutation governance config (${messages.join("; ")})`);
  }
}

export function createChangedMutationConfig(baseConfig, scope, options = {}) {
  const incremental = options.incremental !== false;
  const outerJobs = options.outerJobs ?? 1;
  return {
    ...baseConfig,
    commandRunner: {
      ...baseConfig.commandRunner,
      command: mutationScopeTestCommand(scope),
    },
    mutate: [scope.mutate],
    reporters: ["clear-text", "json"],
    jsonReporter: {
      fileName: `reports/mutation/changed/${scope.id}.json`,
    },
    incremental,
    concurrency: outerJobs > 1 ? (scope.parallelConcurrency ?? 1) : baseConfig.concurrency,
    incrementalFile: `reports/mutation/incremental/${scope.id}.json`,
    tempDirName: path.join(os.tmpdir(), `cellfence-stryker-${repositoryTempKey}-${scope.id}`),
  };
}
