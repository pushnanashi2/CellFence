import type {
  AcceptedIntermediateRepresentation,
  DeclaredIntermediateRepresentation,
  GovernanceControlState,
  NormalizedObservedIntermediateRepresentation,
} from "./model.js";
import { stableDigest } from "./canonicalization.js";

type ControlStateInput = {
  declared: DeclaredIntermediateRepresentation;
  observed: NormalizedObservedIntermediateRepresentation;
  accepted: AcceptedIntermediateRepresentation;
  observer: string;
};

function sortedRecord(record: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) sorted[key] = record[key] as string;
  return sorted;
}

function sortedValues<Value extends string>(values: Value[]): Value[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function createGovernanceControlState(input: ControlStateInput): GovernanceControlState {
  const stateWithoutDigest = {
    schemaVersion: "cellfence.governance-control-state.v1" as const,
    declared: {
      cellIds: sortedValues(input.declared.cellIds),
      requiredRules: sortedValues(input.declared.requiredRules),
      configuredSeverities: sortedRecord(input.declared.configuredSeverities),
    },
    observed: {
      findingRuleIds: sortedValues(input.observed.findingRuleIds),
      warningRuleIds: sortedValues(input.observed.warningRuleIds),
      observedFamilies: sortedValues(input.observed.observedFamilies),
    },
    accepted: {
      baselineCellIds: sortedValues(input.accepted.baselineCellIds),
      waiverRuleIds: sortedValues(input.accepted.waiverRuleIds),
    },
    observer: input.observer,
  };
  return {
    ...stateWithoutDigest,
    controlDigest: stableDigest(stateWithoutDigest),
  };
}
