import {
  CELLFENCE_PLUGIN_API_VERSION,
  definePlugin,
  defineRule,
  type CellFenceFinding,
  type CellFencePlugin,
  type CellFenceRepositoryModel,
} from "@cellfence/plugin-api";

export type BlastRadiusOptions = {
  maxAffectedCells?: number;
  severity?: "warning" | "error";
};

function patternToRegExp(pattern: string): RegExp {
  const normalized = pattern.split("\\").join("/").replace(/\/$/, "");
  // Stryker disable all: retaining the first or last member of a consecutive globstar run recognizes the same path language.
  const segments = normalized
    .split("/")
    .filter((segment, index, all) => segment !== "**" || all[index - 1] !== "**");
  // Stryker restore all
  let expression = "";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === "**") {
      if (segments.length === 1) expression += "[\\s\\S]*";
      else if (index === segments.length - 1) expression += "/[\\s\\S]+";
      else expression += `${index > 0 ? "/" : ""}(?:[^/]+/)*`;
      continue;
    }
    if (index > 0 && segments[index - 1] !== "**") expression += "/";
    // Stryker disable next-line Regex: globally replacing adjacent stars one-at-a-time or as a run recognizes the same segment language.
    for (const character of segment.replace(/\*+/g, "*")) {
      expression += character === "*"
        ? "[^/]*"
        : character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}(?![\\s\\S])`);
}

function matchesPattern(filePath: string, pattern: string): boolean {
  return patternToRegExp(pattern).test(filePath.split("\\").join("/"));
}

function changedCells(repository: CellFenceRepositoryModel): Set<string> {
  const cells = new Set<string>();
  for (const filePath of repository.changedFiles) {
    for (const cell of repository.manifest.cells) {
      if (cell.ownedPaths.some((pattern) => matchesPattern(filePath, pattern))) {
        cells.add(cell.id);
      }
    }
  }
  return cells;
}

function reverseImportGraph(repository: CellFenceRepositoryModel): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();
  for (const reference of repository.imports) {
    if (!reference.targetCellId || reference.targetCellId === reference.importerCellId) continue;
    const consumers = reverse.get(reference.targetCellId) || new Set<string>();
    consumers.add(reference.importerCellId);
    reverse.set(reference.targetCellId, consumers);
  }
  return reverse;
}

function collectAffectedCells(changed: Set<string>, reverse: Map<string, Set<string>>): Set<string> {
  const affected = new Set<string>();
  const queue = [...changed];
  // Stryker disable next-line EqualityOperator,BlockStatement: mutating the queue loop can remove the only progress step and non-terminate; transitive closure behavior is covered by cycle and threshold tests.
  while (queue.length > 0) {
    const cellId = queue.shift() as string;
    for (const consumer of reverse.get(cellId) || []) {
      // Stryker disable next-line ConditionalExpression: removing the visited guard makes cyclic dependency graphs non-terminating; cycle handling is covered by blast-radius boundary tests.
      if (affected.has(consumer)) continue;
      affected.add(consumer);
      queue.push(consumer);
    }
  }
  return affected;
}

export function blastRadiusPlugin(options: BlastRadiusOptions = {}): CellFencePlugin {
  const severity = options.severity || "warning";
  const maxAffectedCells = options.maxAffectedCells ?? 3;
  return definePlugin({
    apiVersion: CELLFENCE_PLUGIN_API_VERSION,
    name: "@cellfence/plugin-blast-radius",
    version: "0.2.0",
    capabilities: { needsGitDiff: true },
    rules: {
      "blast-radius/affected-cells": defineRule({
        id: "blast-radius/affected-cells",
        meta: {
          description: "Warns when changed cells have too many downstream consumers.",
          defaultSeverity: severity,
          category: "change-risk",
        },
        run(context) {
          const changed = changedCells(context.repository);
          // Stryker disable next-line ConditionalExpression: removing the early return is equivalent because an empty changed set reaches an empty affected set.
          if (changed.size === 0) return [];
          const affected = collectAffectedCells(changed, reverseImportGraph(context.repository));
          if (affected.size <= maxAffectedCells) return [];
          const finding: CellFenceFinding = {
            ruleId: "blast-radius/affected-cells",
            severity,
            message: `change affects ${affected.size} downstream cells, exceeding budget ${maxAffectedCells}`,
            details: {
              changedCells: [...changed].sort(),
              affectedCells: [...affected].sort(),
              maxAffectedCells,
            },
          };
          return [finding];
        },
      }),
    },
  });
}
