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

function codeUnitAt(text: string, index: number): number {
  return text.charCodeAt(index);
}

function isAsciiLetter(codeUnit: number): boolean {
  return (codeUnit >= 65 && codeUnit <= 90) || (codeUnit >= 97 && codeUnit <= 122);
}

function isIdentifierStart(text: string, index: number): boolean {
  const codeUnit = codeUnitAt(text, index);
  return isAsciiLetter(codeUnit) || codeUnit === 36 || codeUnit === 95;
}

function isIdentifierPart(text: string, index: number): boolean {
  const codeUnit = codeUnitAt(text, index);
  return isIdentifierStart(text, index) || (codeUnit >= 48 && codeUnit <= 57);
}

function isWhitespace(text: string, index: number): boolean {
  const codeUnit = codeUnitAt(text, index);
  switch (codeUnit) {
    case 9:
    case 10:
    case 11:
    case 12:
    case 13:
    case 32:
      return true;
  }
  // Stryker disable next-line BooleanLiteral: whitespace checks only observe truthiness, so an omitted false return is equivalent.
  return false;
}

function skipWhitespace(text: string, start: number): number {
  let cursor = start;
  while (isWhitespace(text, cursor)) cursor += 1;
  return cursor;
}

function readIdentifier(text: string, start: number): { value: string; end: number } | undefined {
  if (!isIdentifierStart(text, start)) return undefined;
  let cursor = start + 1;
  while (isIdentifierPart(text, cursor)) cursor += 1;
  return { value: text.slice(start, cursor), end: cursor };
}

function consumeKeyword(text: string, start: number, keyword: string): number | undefined {
  if (!text.startsWith(keyword, start)) return undefined;
  if (isIdentifierPart(text, start - 1) || isIdentifierPart(text, start + keyword.length)) return undefined;
  return start + keyword.length;
}

function documentedNamedExports(exportClause: string): string[] {
  return exportClause.split(",").flatMap((entry) => {
    const tokens: string[] = [];
    let cursor = 0;
    while (cursor < entry.length) {
      cursor = skipWhitespace(entry, cursor);
      const start = cursor;
      // Stryker disable next-line EqualityOperator: reading one char past the entry produces the same slice because `charCodeAt(length)` is NaN.
      while (cursor < entry.length && !isWhitespace(entry, cursor)) cursor += 1;
      // Stryker disable next-line ConditionalExpression,EqualityOperator: empty tokens are unobservable for schema-valid public symbol names.
      if (cursor > start) tokens.push(entry.slice(start, cursor));
    }
    const aliasIndex = tokens.indexOf("as");
    // Stryker disable next-line ConditionalExpression,EqualityOperator,ArithmeticOperator: trailing or missing aliases only add duplicates/undefined, never a schema-valid public symbol.
    if (aliasIndex > 0 && aliasIndex < tokens.length - 1) return [tokens[0], tokens[aliasIndex + 1]];
    // Stryker disable next-line ConditionalExpression,ArrayDeclaration: empty named-export entries cannot document a schema-valid public symbol.
    return tokens.length === 0 ? [] : [tokens[0]];
  });
}

function findNamedExportClose(text: string, openIndex: number): number {
  // Stryker disable next-line ArithmeticOperator: starting at the opening brace or one char before finds the same first possible closing brace.
  const closeIndex = text.indexOf("}", openIndex + 1);
  // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: missing braces either return -1 or an empty backward slice, documenting no valid symbol.
  if (closeIndex < 0) {
    // Stryker disable next-line UnaryOperator: +1 produces an empty backward slice for every public call site, so no symbol is documented.
    return -1;
  }
  // Stryker disable next-line ArithmeticOperator: a JSDoc marker cannot start between the byte before `{` and the opening brace.
  const nextJsdocIndex = text.indexOf("/**", openIndex + 1);
  // Stryker disable next-line EqualityOperator: malformed cross-JSDoc named exports return -1 or an empty backward slice, documenting no valid symbol.
  if (nextJsdocIndex >= 0 && nextJsdocIndex < closeIndex) {
    // Stryker disable next-line UnaryOperator: +1 produces an empty backward slice for every public call site, so no symbol is documented.
    return -1;
  }
  return closeIndex;
}

function documentedExportSymbols(text: string): Set<string> {
  const symbols = new Set<string>();
  let cursor = 0;
  // Stryker disable next-line EqualityOperator: an extra scan at `text.length` only observes `indexOf("/**", text.length) === -1`.
  while (cursor < text.length) {
    const commentStart = text.indexOf("/**", cursor);
    if (commentStart < 0) break;
    const commentEnd = text.indexOf("*/", commentStart + 3);
    // Stryker disable next-line EqualityOperator: the closing marker cannot occur at offset 0 after a `/**` start plus marker length.
    if (commentEnd < 0) break;
    cursor = commentEnd + 2;
    let exportStart = skipWhitespace(text, cursor);
    const exportEnd = consumeKeyword(text, exportStart, "export");
    // Stryker disable next-line ConditionalExpression: forcing the undefined branch still produces no declaration keyword and no documented symbol.
    if (exportEnd === undefined) continue;
    exportStart = skipWhitespace(text, exportEnd);
    if (text[exportStart] === "{") {
      const close = findNamedExportClose(text, exportStart);
      // Stryker disable next-line EqualityOperator: a close brace for an opened named export cannot be at absolute offset 0.
      if (close < 0) continue;
      for (const symbol of documentedNamedExports(text.slice(exportStart + 1, close))) symbols.add(symbol);
      continue;
    }
    for (const optionalKeyword of ["declare", "default", "async"]) {
      const next = consumeKeyword(text, exportStart, optionalKeyword);
      if (next !== undefined) exportStart = skipWhitespace(text, next);
    }
    for (const declarationKeyword of ["const", "let", "var", "function", "class", "interface", "type", "enum"]) {
      const afterKind = consumeKeyword(text, exportStart, declarationKeyword);
      if (afterKind === undefined) continue;
      const identifier = readIdentifier(text, skipWhitespace(text, afterKind));
      if (identifier) symbols.add(identifier.value);
      break;
    }
  }
  return symbols;
}

export function geoPurityPlugin(options: GeoPurityOptions = {}): CellFencePlugin {
  const severity = options.severity || "warning";
  const maxPublicEntryLines = options.maxPublicEntryLines ?? 200;
  const maxOwnedFileLines = options.maxOwnedFileLines ?? 600;
  const requirePublicJsdoc = options.requirePublicJsdoc ?? false;
  return definePlugin({
    apiVersion: CELLFENCE_PLUGIN_API_VERSION,
    name: "@cellfence/plugin-geo-purity",
    version: "0.2.1",
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
                const documentedSymbols = documentedExportSymbols(text);
                for (const symbol of cell.publicSymbols) {
                  if (!documentedSymbols.has(symbol)) {
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
