# Recommended AGENTS.md / .cursorrules / CLAUDE.md snippet

Add this snippet to the agent instruction file in any repository
that uses CellFence. It is the agent-side companion to the baseline
update gate: the gate enforces human approval; the snippet stops
agents from ever reaching for the easy button.

```text
When `cellfence check` fails, DO NOT run `cellfence baseline update`
to silence the error. Baseline updates require human governance
review.

Instead, either:
  1. Adjust the change to fit within the existing baseline, or
  2. Ask the human maintainer to review whether the architectural
     expansion is intentional.
```

Recommended placement: a top-level `AGENTS.md` (or whichever name
your tool of choice uses) inside the repository root. Update it
alongside the baseline gate workflow so the two evolve together.
