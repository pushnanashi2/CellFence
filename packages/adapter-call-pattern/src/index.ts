import ts from "typescript";

import {
  defineAdapter,
  type CellFenceAdapter,
  type CellFenceResourceAccess,
} from "@cellfence/plugin-api";
import type { ResourceAccessMode, ResourceContractKind } from "@cellfence/schema";

export type CallPattern = {
  call: string;
  resourceArgument: number;
  resourceKind: ResourceContractKind;
  operation: ResourceAccessMode;
};

export type CallPatternAdapterOptions = {
  name: string;
  patterns: CallPattern[];
};

export function callPatternAdapter(options: CallPatternAdapterOptions): CellFenceAdapter {
  return defineAdapter({
    name: options.name,
    detect(context) {
      const accesses: CellFenceResourceAccess[] = [];
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node)) {
          const call = context.helpers.getQualifiedCallName(node);
          const pattern = options.patterns.find((candidate) => candidate.call === call);
          if (pattern) {
            const selector = context.helpers.getStaticStringArgument(node, pattern.resourceArgument);
            accesses.push({
              kind: pattern.resourceKind,
              access: pattern.operation,
              selector: selector || `unresolved:${options.name}:${pattern.call}`,
              filePath: context.filePath,
              line: context.helpers.lineOf(node),
              source: pattern.call,
              detectedBy: options.name,
              confidence: selector ? "high" : "low",
              unresolved: !selector,
              reason: selector ? undefined : `argument ${pattern.resourceArgument} for ${pattern.call} is dynamic`,
            });
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(context.sourceFile);
      return accesses;
    },
  });
}
