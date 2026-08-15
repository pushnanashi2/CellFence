const officialPluginTest = "tests/official-plugins.test.mjs";

export const MUTATION_SCOPES = Object.freeze([
  {
    id: "schema",
    source: "packages/schema/src/index.ts",
    mutate: "packages/schema/dist/index.js",
    tests: ["tests/schema-validation.test.mjs", officialPluginTest],
  },
  {
    id: "plugin-api",
    source: "packages/plugin-api/src/index.ts",
    mutate: "packages/plugin-api/dist/index.js",
    tests: ["tests/plugin-api.test.mjs", officialPluginTest],
  },
  {
    id: "adapter-call-pattern",
    source: "packages/adapter-call-pattern/src/index.ts",
    mutate: "packages/adapter-call-pattern/dist/index.js",
    tests: [officialPluginTest],
  },
  {
    id: "adapter-opentelemetry",
    source: "packages/adapter-opentelemetry/src/index.ts",
    mutate: "packages/adapter-opentelemetry/dist/index.js",
    tests: [officialPluginTest],
  },
  {
    id: "plugin-agent-budget",
    source: "packages/plugin-agent-budget/src/index.ts",
    mutate: "packages/plugin-agent-budget/dist/index.js",
    tests: [officialPluginTest],
  },
  {
    id: "plugin-blast-radius",
    source: "packages/plugin-blast-radius/src/index.ts",
    mutate: "packages/plugin-blast-radius/dist/index.js",
    tests: [officialPluginTest],
  },
  {
    id: "plugin-dependency-sovereignty",
    source: "packages/plugin-dependency-sovereignty/src/index.ts",
    mutate: "packages/plugin-dependency-sovereignty/dist/index.js",
    tests: [officialPluginTest],
  },
  {
    id: "plugin-geo-purity",
    source: "packages/plugin-geo-purity/src/index.ts",
    mutate: "packages/plugin-geo-purity/dist/index.js",
    tests: [officialPluginTest],
  },
  {
    id: "plugin-legacy-strangler",
    source: "packages/plugin-legacy-strangler/src/index.ts",
    mutate: "packages/plugin-legacy-strangler/dist/index.js",
    tests: [officialPluginTest],
  },
  {
    id: "plugin-quants-trend",
    source: "packages/plugin-quants-trend/src/index.ts",
    mutate: "packages/plugin-quants-trend/dist/index.js",
    tests: [officialPluginTest],
  },
  {
    id: "reporter-economy-matrix",
    source: "packages/reporter-economy-matrix/src/index.ts",
    mutate: "packages/reporter-economy-matrix/dist/index.js",
    tests: [officialPluginTest],
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
    mutate: "packages/engine/dist/module-resolution.js",
    tests: ["tests/module-resolution.test.mjs"],
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
    mutate: "packages/engine/dist/file-index.js",
    tests: ["tests/file-index.test.mjs"],
  },
  {
    id: "engine-glob-overlap",
    source: "packages/engine/src/glob-overlap.ts",
    mutate: "packages/engine/dist/glob-overlap.js",
    tests: ["tests/file-index.test.mjs"],
  },
  {
    id: "engine-resource-access",
    source: "packages/engine/src/resource-access.ts",
    mutate: "packages/engine/dist/resource-access.js",
    tests: ["tests/resource-access-coverage.test.mjs"],
  },
  {
    id: "github-action",
    source: "packages/github-action/src/index.ts",
    mutate: "packages/github-action/dist/index.js",
    tests: ["tests/github-action.test.mjs"],
  },
].map((scope) => Object.freeze({ ...scope, tests: Object.freeze([...scope.tests]) })));

export function normalizeRepositoryPath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function mutationScopesForFiles(filePaths) {
  const normalizedFiles = new Set(filePaths.map(normalizeRepositoryPath));
  return MUTATION_SCOPES.filter(
    (scope) => normalizedFiles.has(scope.source)
      || normalizedFiles.has(scope.mutate)
      || scope.tests.some((testPath) => normalizedFiles.has(testPath)),
  );
}

export function mutationScopeById(scopeId) {
  return MUTATION_SCOPES.find((scope) => scope.id === scopeId);
}

export function mutationScopeMatrix() {
  return MUTATION_SCOPES.map((scope) => ({ id: scope.id, source: scope.source }));
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

export function createChangedMutationConfig(baseConfig, scope, options = {}) {
  const incremental = options.incremental !== false;
  return {
    ...baseConfig,
    commandRunner: {
      ...baseConfig.commandRunner,
      command: `node --test ${scope.tests.join(" ")}`,
    },
    mutate: [scope.mutate],
    reporters: ["clear-text", "json"],
    jsonReporter: {
      fileName: `reports/mutation/changed/${scope.id}.json`,
    },
    incremental,
    incrementalFile: `reports/mutation/incremental/${scope.id}.json`,
    tempDirName: `.stryker-tmp/changed-${scope.id}`,
  };
}
