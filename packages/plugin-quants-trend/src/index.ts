import {
  CELLFENCE_PLUGIN_API_VERSION,
  definePlugin,
  defineRule,
  type CellFenceFinding,
  type CellFencePlugin,
} from "@cellfence/plugin-api";
import type { CellFenceBaseline, CellBaselineRecord } from "@cellfence/schema";

export type TrendMetric = "publicSymbols" | "crossCellDependencies" | "publicSurfaceLines";

export type QuantsTrendOptions = {
  history: CellFenceBaseline[];
  metrics?: TrendMetric[];
  multiplier?: number;
  minimumGrowth?: number;
  severity?: "warning" | "error";
};

function metricValue(record: CellBaselineRecord | undefined, metric: TrendMetric): number {
  if (!record) return 0;
  return Number(record[metric] || 0);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function quantsTrendPlugin(options: QuantsTrendOptions): CellFencePlugin {
  const severity = options.severity || "warning";
  const metrics = options.metrics || ["publicSymbols", "crossCellDependencies"];
  const multiplier = options.multiplier ?? 2;
  const minimumGrowth = options.minimumGrowth ?? 2;
  return definePlugin({
    apiVersion: CELLFENCE_PLUGIN_API_VERSION,
    name: "@cellfence/plugin-quants-trend",
    version: "0.1.8",
    rules: {
      "quants-trend/architecture-momentum": defineRule({
        id: "quants-trend/architecture-momentum",
        meta: {
          description: "Warns when architecture surface grows faster than recent baseline momentum.",
          defaultSeverity: severity,
          category: "architecture-trend",
        },
        run(context) {
          const findings: CellFenceFinding[] = [];
          if (options.history.length < 2) return findings;
          for (const [cellId, current] of Object.entries(context.repository.metrics)) {
            for (const metric of metrics) {
              const historicalValues = options.history.map((baseline) => metricValue(baseline.cells[cellId], metric));
              const deltas = historicalValues.slice(1).map((value, index) => Math.max(0, value - historicalValues[index]));
              const averageDelta = mean(deltas);
              const previousValue = historicalValues[historicalValues.length - 1] || 0;
              const currentDelta = Math.max(0, metricValue(current, metric) - previousValue);
              const threshold = Math.max(minimumGrowth, averageDelta * multiplier);
              if (currentDelta > threshold) {
                findings.push({
                  ruleId: "quants-trend/architecture-momentum",
                  severity,
                  cellId,
                  message: `${cellId}.${metric} grew by ${currentDelta}, above momentum threshold ${threshold}`,
                  details: { cellId, metric, currentDelta, averageDelta, threshold, history: historicalValues },
                });
              }
            }
          }
          return findings;
        },
      }),
    },
  });
}
