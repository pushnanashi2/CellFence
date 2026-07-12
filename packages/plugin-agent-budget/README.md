# @cellfence/plugin-agent-budget

Rule plugin that rejects AI-agent changes outside a declared budget.

```ts
import { agentBudgetPlugin } from "@cellfence/plugin-agent-budget";
```

Use with `checkRepository({ changedFiles, plugins: [agentBudgetPlugin(...)] })`.
