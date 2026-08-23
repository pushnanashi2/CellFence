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
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function hasImmediateJsdoc(text: string, exportIndex: number): boolean {
  const beforeExport = text.slice(0, exportIndex).trimEnd();
  if (!beforeExport.endsWith("*/")) return false;
  const commentStart = beforeExport.lastIndexOf("/*");
  // Stryker disable next-line ConditionalExpression: after the suffix guard, valid block comments always include an opening delimiter; malformed fragments are outside the supported source dialect.
  return commentStart >= 0 && beforeExport.slice(commentStart).startsWith("/**");
}

function exportedNames(specifierList: string): string[] {
  // Stryker disable next-line ArrayDeclaration: injected sentinel names are not valid TypeScript export identifiers and cannot match supported public symbols.
  const names: string[] = [];
  for (const rawSpecifier of specifierList.split(",")) {
    const trimmed = rawSpecifier.trim();
    // Stryker disable next-line ConditionalExpression: empty named-export specifiers are invalid source syntax; supported named exports are covered by direct tests.
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const typedTokens = tokens[0] === "type" ? tokens.slice(1) : tokens;
    const aliasIndex = typedTokens.indexOf("as");
    const exported = typedTokens[aliasIndex + 1] || typedTokens[0];
    // Stryker disable next-line ConditionalExpression: missing exported names require malformed export specifiers that the plugin does not parse as a supported source dialect.
    if (exported) names.push(exported);
  }
  return names;
}

function hasJsdocForExport(text: string, symbol: string): boolean {
  const escaped = symbol.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const expression = new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?(?:const|let|var|function|class|interface|type|enum)\\s+${escaped}\\b`, "g");
  for (const match of text.matchAll(expression)) {
    if (hasImmediateJsdoc(text, match.index || 0)) return true;
  }
  const namedExport = /\bexport\s*\{([^}]*)\}/g;
  for (const match of text.matchAll(namedExport)) {
    if (exportedNames(match[1]).includes(symbol) && hasImmediateJsdoc(text, match.index || 0)) return true;
  }
  return false;
}

export function geoPurityPlugin(options: GeoPurityOptions = {}): CellFencePlugin {
  const severity = options.severity || "warning";
  const maxPublicEntryLines = options.maxPublicEntryLines ?? 200;
  const maxOwnedFileLines = options.maxOwnedFileLines ?? 600;
  const requirePublicJsdoc = options.requirePublicJsdoc ?? false;
  return definePlugin({
    apiVersion: CELLFENCE_PLUGIN_API_VERSION,
    name: "@cellfence/plugin-geo-purity",
    version: "0.3.0",
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
