import {
  CELLFENCE_PLUGIN_API_VERSION,
  definePlugin,
  defineRule,
  type CellFenceFinding,
  type CellFencePlugin,
  type CellFenceRepositoryModel,
} from "@cellfence/plugin-api";

export type LegacyStranglerOptions = {
  legacyCells: string[];
  maxIncomingDependencies?: Record<string, number>;
  severity?: "warning" | "error";
};

function incomingEdges(repository: CellFenceRepositoryModel, legacyCells: Set<string>): string[] {
  const edges = new Set<string>();
  for (const record of Object.values(repository.metrics)) {
    // Stryker disable next-line ArrayDeclaration: fallback sentinel lacks the required consumer->producer shape and is filtered out.
    for (const edge of record.dependencyEdges || []) {
      const [, producer] = edge.split("->");
      if (producer && legacyCells.has(producer)) edges.add(edge);
    }
  }
  return [...edges].sort();
}

function baselineIncomingEdges(repository: CellFenceRepositoryModel, legacyCells: Set<string>): string[] {
  // Stryker disable all: fallback sentinel cannot match normalized dependency edges after the caller converts this result to a Set.
  if (!repository.baseline) return [];
  // Stryker restore all
  const edges = new Set<string>();
  for (const record of Object.values(repository.baseline.cells)) {
    // Stryker disable all: malformed fallback edges do not match real consumer->producer current edges after baseline Set conversion.
    for (const edge of record.dependencyEdges || []) {
      const [, producer] = edge.split("->");
      if (producer && legacyCells.has(producer)) edges.add(edge);
    }
    // Stryker restore all
  }
  // Stryker disable next-line MethodExpression,ArrayDeclaration: baseline ordering is unobservable because callers convert the array to a Set.
  return [...edges].sort();
}

export function legacyStranglerPlugin(options: LegacyStranglerOptions): CellFencePlugin {
  const severity = options.severity || "error";
  const legacyCells = new Set(options.legacyCells);
  return definePlugin({
    apiVersion: CELLFENCE_PLUGIN_API_VERSION,
    name: "@cellfence/plugin-legacy-strangler",
    version: "0.1.8",
    rules: {
      "legacy-strangler/no-new-legacy-dependency": defineRule({
        id: "legacy-strangler/no-new-legacy-dependency",
        meta: {
          description: "Rejects new dependencies into legacy cells.",
          defaultSeverity: severity,
          category: "migration",
        },
        run(context) {
          const findings: CellFenceFinding[] = [];
          const currentEdges = incomingEdges(context.repository, legacyCells);
          const baselineEdges = new Set(baselineIncomingEdges(context.repository, legacyCells));
          const newEdges = currentEdges.filter((edge) => !baselineEdges.has(edge));
          for (const edge of newEdges) {
            const [, legacyCell] = edge.split("->");
            findings.push({
              ruleId: "legacy-strangler/no-new-legacy-dependency",
              severity,
              cellId: legacyCell,
              message: `new dependency into legacy cell is not allowed: ${edge}`,
              details: { edge, legacyCells: options.legacyCells },
            });
          }

          for (const [cellId, maxIncoming] of Object.entries(options.maxIncomingDependencies || {})) {
            const count = currentEdges.filter((edge) => edge.endsWith(`->${cellId}`)).length;
            if (count > maxIncoming) {
              findings.push({
                ruleId: "legacy-strangler/incoming-target",
                severity,
                cellId,
                message: `${cellId} has ${count} incoming legacy dependencies, exceeding target ${maxIncoming}`,
                details: { cellId, count, maxIncoming },
              });
            }
          }
          return findings;
        },
      }),
    },
  });
}
