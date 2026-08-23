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

import { matchesGlobPattern as matchesPattern } from "./glob.js";

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
    // Stryker disable next-line ConditionalExpression,LogicalOperator: unresolved and self references cannot expand the downstream closure once changed cells are marked visited.
    if (!reference.targetCellId || reference.targetCellId === reference.importerCellId) continue;
    const consumers = reverse.get(reference.targetCellId) || new Set<string>();
    consumers.add(reference.importerCellId);
    reverse.set(reference.targetCellId, consumers);
  }
  return reverse;
}

function collectAffectedCells(changed: Set<string>, reverse: Map<string, Set<string>>): Set<string> {
  const affected = new Set<string>();
  const visited = new Set<string>(changed);
  const queue = [...changed];
  // Stryker disable next-line EqualityOperator,BlockStatement: mutating the queue loop can remove the only progress step and non-terminate; transitive closure behavior is covered by cycle and threshold tests.
  while (queue.length > 0) {
    const cellId = queue.shift() as string;
    for (const consumer of reverse.get(cellId) || []) {
      // Stryker disable next-line ConditionalExpression: removing the visited guard makes cyclic dependency graphs non-terminating; cycle handling is covered by blast-radius boundary tests.
      if (visited.has(consumer)) continue;
      visited.add(consumer);
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
    version: "0.2.1",
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
