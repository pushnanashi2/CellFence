import type { RuleJudgment } from "./model.js";

export type ImportPolicyRuleId = "CELLFENCE_PRIVATE_IMPORT" | "CELLFENCE_UNDECLARED_CONSUMER";

export type NormalizedObservedImportFact = {
  importerPath: string;
  importerCellId: string;
  specifier: string;
  kind: "import" | "export-from" | "require" | "dynamic-import";
  typeOnly: boolean;
  targetPath?: string;
  producerCellId?: string;
  isExternal: boolean;
  isPublicPackage: boolean;
  declaredConsumer: boolean;
  privateImplementation: boolean;
};

export type ImportPolicyJudgment = {
  ruleId: ImportPolicyRuleId;
  status: RuleJudgment;
  fact: NormalizedObservedImportFact;
  message: string;
};

const IMPORT_RULES: ImportPolicyRuleId[] = [
  "CELLFENCE_UNDECLARED_CONSUMER",
  "CELLFENCE_PRIVATE_IMPORT",
];

function importFactApplies(fact: NormalizedObservedImportFact): boolean {
  return Boolean(fact.producerCellId)
    && !fact.isExternal
    && fact.producerCellId !== fact.importerCellId;
}

function judgment(
  ruleId: ImportPolicyRuleId,
  status: RuleJudgment,
  fact: NormalizedObservedImportFact,
  message: string,
): ImportPolicyJudgment {
  return { ruleId, status, fact, message };
}

export function evaluateImportPolicyFact(fact: NormalizedObservedImportFact): ImportPolicyJudgment[] {
  if (!importFactApplies(fact)) {
    return IMPORT_RULES.map((ruleId) =>
      judgment(ruleId, "NOT_APPLICABLE", fact, `${ruleId} does not apply to same-cell, external, or unresolved imports`));
  }
  return [
    judgment(
      "CELLFENCE_UNDECLARED_CONSUMER",
      fact.declaredConsumer ? "SATISFIED" : "VIOLATED",
      fact,
      fact.declaredConsumer
        ? `${fact.importerCellId} declares consumption of ${fact.producerCellId}`
        : `${fact.importerCellId} imports ${fact.producerCellId} without declaring a consumer relationship`,
    ),
    judgment(
      "CELLFENCE_PRIVATE_IMPORT",
      fact.privateImplementation ? "VIOLATED" : "SATISFIED",
      fact,
      fact.privateImplementation
        ? `${fact.importerCellId} imports private implementation from ${fact.producerCellId}`
        : `${fact.importerCellId} imports an accepted public surface from ${fact.producerCellId}`,
    ),
  ];
}

export function importPolicyViolations(facts: readonly NormalizedObservedImportFact[]): ImportPolicyJudgment[] {
  return facts
    .flatMap((fact) => evaluateImportPolicyFact(fact))
    .filter((judgmentResult) => judgmentResult.status === "VIOLATED");
}
