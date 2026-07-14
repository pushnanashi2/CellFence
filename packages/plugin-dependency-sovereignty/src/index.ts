import {
  CELLFENCE_PLUGIN_API_VERSION,
  definePlugin,
  defineRule,
  type CellFenceFinding,
  type CellFencePlugin,
} from "@cellfence/plugin-api";

export type DependencySovereigntyOptions = {
  actor?: string;
  cellOwners: Record<string, string[]>;
  approvedCells?: string[];
  protectedCells?: string[];
  changedOnly?: boolean;
  severity?: "warning" | "error";
};

function dependencyEdgesFromImports(imports: readonly { importerCellId: string; targetCellId?: string }[]): string[] {
  const edges = new Set<string>();
  for (const reference of imports) {
    if (!reference.targetCellId || reference.targetCellId === reference.importerCellId) continue;
    edges.add(`${reference.importerCellId}->${reference.targetCellId}`);
  }
  return [...edges].sort();
}

export function dependencySovereigntyPlugin(options: DependencySovereigntyOptions): CellFencePlugin {
  const severity = options.severity || "error";
  return definePlugin({
    apiVersion: CELLFENCE_PLUGIN_API_VERSION,
    name: "@cellfence/plugin-dependency-sovereignty",
    version: "0.1.8",
    capabilities: { needsGitDiff: Boolean(options.changedOnly) },
    rules: {
      "dependency-sovereignty/approval-required": defineRule({
        id: "dependency-sovereignty/approval-required",
        meta: {
          description: "Requires owner approval before depending on protected cells.",
          defaultSeverity: severity,
          category: "team-governance",
        },
        run(context) {
          const actor = options.actor || "unknown";
          const approvedCells = new Set(options.approvedCells || []);
          const protectedCells = new Set(options.protectedCells || Object.keys(options.cellOwners));
          const baselineEdges = new Set<string>();
          for (const record of Object.values(context.repository.baseline?.cells || {})) {
            // Stryker disable next-line ArrayDeclaration: fallback sentinel cannot match normalized dependency edges shaped as consumer->producer.
            for (const edge of record.dependencyEdges || []) baselineEdges.add(edge);
          }
          const changedImporters = new Set<string>();
          // Stryker disable next-line ConditionalExpression: forcing this collection on is equivalent unless the later changedOnly gate is also enabled.
          if (options.changedOnly) {
            for (const changedFile of context.repository.changedFiles) {
              for (const [cellId, files] of Object.entries(context.repository.files.byCell)) {
                if (files.includes(changedFile)) changedImporters.add(cellId);
              }
            }
          }

          const findings: CellFenceFinding[] = [];
          for (const edge of dependencyEdgesFromImports(context.repository.imports)) {
            if (baselineEdges.has(edge)) continue;
            const [consumer, producer] = edge.split("->");
            if (!producer || !protectedCells.has(producer)) continue;
            if (options.changedOnly && !changedImporters.has(consumer)) continue;
            const owners = options.cellOwners[producer] || [];
            if (owners.includes(actor) || approvedCells.has(producer)) continue;
            findings.push({
              ruleId: "dependency-sovereignty/approval-required",
              severity,
              cellId: consumer,
              producerCellId: producer,
              message: `${actor} added dependency ${edge}, but ${producer} requires owner approval`,
              details: { edge, actor, owners, approvedCells: [...approvedCells] },
              suggestedResolutions: [
                {
                  kind: "ask-human",
                  title: `Request approval from ${producer} owners`,
                  approvalRequired: true,
                  details: { owners, producer, consumer },
                },
              ],
            });
          }
          return findings;
        },
      }),
    },
  });
}
