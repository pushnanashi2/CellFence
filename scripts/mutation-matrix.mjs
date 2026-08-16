import baseMutationConfig from "../stryker.conf.mjs";
import {
  mutationScopeMatrix,
  validateMutationGovernanceConfig,
  validateMutationScopeCoverage,
} from "./mutation-scopes.mjs";

validateMutationScopeCoverage(baseMutationConfig.mutate);
validateMutationGovernanceConfig(baseMutationConfig, { requireNonIncremental: true });
process.stdout.write(`${JSON.stringify({ include: mutationScopeMatrix() })}\n`);
