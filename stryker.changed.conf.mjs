import baseConfig from "./stryker.conf.mjs";
import {
  createChangedMutationConfig,
  mutationScopeById,
  validateMutationGovernanceConfig,
  validateMutationScopeCoverage,
} from "./scripts/mutation-scopes.mjs";

validateMutationScopeCoverage(baseConfig.mutate);
validateMutationGovernanceConfig(baseConfig, { requireNonIncremental: true });

const scopeId = process.env.CELLFENCE_MUTATION_SCOPE;
const scope = mutationScopeById(scopeId);
if (!scope) {
  throw new Error(`Unknown or missing CELLFENCE_MUTATION_SCOPE: ${scopeId ?? "<missing>"}`);
}

const outerJobs = Number(process.env.CELLFENCE_MUTATION_CHANGED_JOBS || "1");
if (!Number.isInteger(outerJobs) || outerJobs < 1 || outerJobs > 4) {
  throw new Error(`CELLFENCE_MUTATION_CHANGED_JOBS must be an integer from 1 to 4; got ${process.env.CELLFENCE_MUTATION_CHANGED_JOBS}`);
}

export default createChangedMutationConfig(baseConfig, scope, {
  incremental: process.env.CELLFENCE_MUTATION_INCREMENTAL !== "0",
  outerJobs,
});
