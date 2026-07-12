import {
  CELLFENCE_PLUGIN_API_VERSION,
  definePlugin,
  defineRule,
  type CellFenceFinding,
  type CellFencePlugin,
  type CellFenceRepositoryModel,
} from "@cellfence/plugin-api";

export type AgentBudgetOptions = {
  maxFiles?: number;
  maxPublicSymbolsAdded?: number;
  maxDependencyEdgesAdded?: number;
  allowedCells?: string[];
  forbiddenPaths?: string[];
  severity?: "warning" | "error";
};

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split(/([*]{1,2})/g)
    .map((part) => {
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      return part.replace(/[\\^$.+?()[\]{}|]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${escaped}$`);
}

function matchesPattern(filePath: string, pattern: string): boolean {
  return patternToRegExp(pattern).test(filePath.split("\\").join("/"));
}

function cellForFile(repository: CellFenceRepositoryModel, filePath: string): string | undefined {
  for (const [cellId, files] of Object.entries(repository.files.byCell)) {
    if (files.includes(filePath)) return cellId;
  }
  for (const cell of repository.manifest.cells) {
    if (cell.ownedPaths.some((pattern) => matchesPattern(filePath, pattern))) return cell.id;
  }
  return undefined;
}

function baselineRecord(repository: CellFenceRepositoryModel, cellId: string) {
  return repository.baseline?.cells[cellId];
}

function addedCount(current: readonly string[] | undefined, previous: readonly string[] | undefined): number {
  const previousSet = new Set(previous || []);
  return (current || []).filter((entry) => !previousSet.has(entry)).length;
}

export function agentBudgetPlugin(options: AgentBudgetOptions = {}): CellFencePlugin {
  const severity = options.severity || "error";
  return definePlugin({
    apiVersion: CELLFENCE_PLUGIN_API_VERSION,
    name: "@cellfence/plugin-agent-budget",
    version: "0.1.8",
    capabilities: { needsGitDiff: true },
    rules: {
      "agent-budget/change-budget": defineRule({
        id: "agent-budget/change-budget",
        meta: {
          description: "Rejects changed files and architecture growth outside an agent budget.",
          defaultSeverity: severity,
          category: "agent-governance",
        },
        run(context) {
          const findings: CellFenceFinding[] = [];
          const changedFiles = [...context.repository.changedFiles].sort();
          if (options.maxFiles !== undefined && changedFiles.length > options.maxFiles) {
            findings.push({
              ruleId: "agent-budget/change-budget",
              severity,
              message: `changed file count ${changedFiles.length} exceeds budget ${options.maxFiles}`,
              details: { changedFiles, maxFiles: options.maxFiles },
            });
          }

          for (const filePath of changedFiles) {
            if ((options.forbiddenPaths || []).some((pattern) => matchesPattern(filePath, pattern))) {
              findings.push({
                ruleId: "agent-budget/forbidden-path",
                severity,
                filePath,
                message: `${filePath} is forbidden by the agent budget`,
                details: { forbiddenPaths: options.forbiddenPaths || [] },
              });
            }
            const cellId = cellForFile(context.repository, filePath);
            if (options.allowedCells && cellId && !options.allowedCells.includes(cellId)) {
              findings.push({
                ruleId: "agent-budget/disallowed-cell",
                severity,
                filePath,
                cellId,
                message: `${filePath} belongs to ${cellId}, which is outside allowedCells`,
                details: { allowedCells: options.allowedCells },
              });
            }
          }

          for (const [cellId, record] of Object.entries(context.repository.metrics)) {
            const previous = baselineRecord(context.repository, cellId);
            if (!previous) continue;
            const publicSymbolsAdded = addedCount(record.publicSymbolSet, previous.publicSymbolSet);
            if (options.maxPublicSymbolsAdded !== undefined && publicSymbolsAdded > options.maxPublicSymbolsAdded) {
              findings.push({
                ruleId: "agent-budget/public-symbol-budget",
                severity,
                cellId,
                message: `${cellId} added ${publicSymbolsAdded} public symbols, exceeding budget ${options.maxPublicSymbolsAdded}`,
                details: { publicSymbolsAdded, maxPublicSymbolsAdded: options.maxPublicSymbolsAdded },
              });
            }
            const dependencyEdgesAdded = addedCount(record.dependencyEdges, previous.dependencyEdges);
            if (options.maxDependencyEdgesAdded !== undefined && dependencyEdgesAdded > options.maxDependencyEdgesAdded) {
              findings.push({
                ruleId: "agent-budget/dependency-budget",
                severity,
                cellId,
                message: `${cellId} added ${dependencyEdgesAdded} dependency edges, exceeding budget ${options.maxDependencyEdgesAdded}`,
                details: { dependencyEdgesAdded, maxDependencyEdgesAdded: options.maxDependencyEdgesAdded },
              });
            }
          }
          return findings;
        },
      }),
    },
  });
}
