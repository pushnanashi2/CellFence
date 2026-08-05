import baseConfig from "./stryker.conf.mjs";
import {
  createChangedMutationConfig,
  mutationScopeById,
  validateMutationScopeCoverage,
} from "./scripts/mutation-scopes.mjs";

validateMutationScopeCoverage(baseConfig.mutate);

const scopeId = process.env.CELLFENCE_MUTATION_SCOPE;
const scope = mutationScopeById(scopeId);
if (!scope) {
  throw new Error(`Unknown or missing CELLFENCE_MUTATION_SCOPE: ${scopeId ?? "<missing>"}`);
}

export default createChangedMutationConfig(baseConfig, scope, {
  incremental: process.env.CELLFENCE_MUTATION_INCREMENTAL !== "0",
});
