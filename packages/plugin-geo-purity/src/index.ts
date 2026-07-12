import {
  CELLFENCE_PLUGIN_API_VERSION,
  definePlugin,
  defineRule,
  type CellFenceFinding,
  type CellFencePlugin,
} from "@cellfence/plugin-api";

export type GeoPurityOptions = {
  maxPublicEntryLines?: number;
  maxOwnedFileLines?: number;
  requirePublicJsdoc?: boolean;
  severity?: "warning" | "error";
};

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function hasJsdocForExport(text: string, symbol: string): boolean {
  const escaped = symbol.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const expression = new RegExp(`/\\*\\*[\\s\\S]*?\\*/\\s*export\\s+(?:declare\\s+)?(?:const|let|var|function|class|interface|type|enum)\\s+${escaped}\\b`);
  const namedExport = new RegExp(`/\\*\\*[\\s\\S]*?\\*/\\s*export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`);
  return expression.test(text) || namedExport.test(text);
}

export function geoPurityPlugin(options: GeoPurityOptions = {}): CellFencePlugin {
  const severity = options.severity || "warning";
  const maxPublicEntryLines = options.maxPublicEntryLines ?? 200;
  const maxOwnedFileLines = options.maxOwnedFileLines ?? 600;
  const requirePublicJsdoc = options.requirePublicJsdoc ?? false;
  return definePlugin({
    apiVersion: CELLFENCE_PLUGIN_API_VERSION,
    name: "@cellfence/plugin-geo-purity",
    version: "0.1.8",
    rules: {
      "geo-purity/context-shape": defineRule({
        id: "geo-purity/context-shape",
        meta: {
          description: "Checks public API docs and overly large context surfaces for AI agents.",
          defaultSeverity: severity,
          category: "agent-context",
        },
        run(context) {
          const findings: CellFenceFinding[] = [];
          for (const cell of context.cells) {
            const publicEntryText = context.repository.files.contents[cell.publicEntry];
            if (publicEntryText !== undefined) {
              const text = publicEntryText;
              const lines = lineCount(text);
              if (lines > maxPublicEntryLines) {
                findings.push({
                  ruleId: "geo-purity/public-entry-too-large",
                  severity,
                  cellId: cell.id,
                  filePath: cell.publicEntry,
                  message: `${cell.id} public entry has ${lines} lines, exceeding ${maxPublicEntryLines}`,
                  details: { lines, maxPublicEntryLines },
                });
              }
              if (requirePublicJsdoc) {
                for (const symbol of cell.publicSymbols) {
                  if (!hasJsdocForExport(text, symbol)) {
                    findings.push({
                      ruleId: "geo-purity/public-symbol-undocumented",
                      severity,
                      cellId: cell.id,
                      filePath: cell.publicEntry,
                      message: `${cell.id} public symbol ${symbol} is missing nearby JSDoc`,
                      details: { symbol },
                    });
                  }
                }
              }
            }
            for (const filePath of context.repository.files.byCell[cell.id] || []) {
              const text = context.repository.files.contents[filePath];
              if (text === undefined) continue;
              const lines = lineCount(text);
              if (lines > maxOwnedFileLines) {
                findings.push({
                  ruleId: "geo-purity/owned-file-too-large",
                  severity,
                  cellId: cell.id,
                  filePath,
                  message: `${filePath} has ${lines} lines, exceeding ${maxOwnedFileLines}`,
                  details: { lines, maxOwnedFileLines },
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
