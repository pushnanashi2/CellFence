import baseMutationConfig from "../stryker.conf.mjs";
import { mutationScopeMatrix, validateMutationScopeCoverage } from "./mutation-scopes.mjs";

validateMutationScopeCoverage(baseMutationConfig.mutate);
process.stdout.write(`${JSON.stringify({ include: mutationScopeMatrix() })}\n`);
