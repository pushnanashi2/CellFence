# Agent Policy

Agents working in this repository must preserve governance before convenience.

- Do not weaken checks to make a change pass.
- Fix implementation rather than bypassing CellFence.
- Do not modify sealed files unless the task explicitly authorizes it.
- Do not add unrelated refactors.
- Do not copy source from private repositories.
- Do not change expected fixture results merely to match faulty implementation.
- Document suspected specification conflicts instead of bypassing them.
- Use descriptive identifiers. Avoid one-letter identifiers except conventional loop indexes.
- Keep dependencies minimal and justified.
- Run `npm run mutation:changed` for pull-request changes that touch a mutation target, its dedicated tests, or mutation infrastructure. Do not treat the scoped result as repository-wide mutation evidence.
- Keep `.github/workflows/mutation-audit.yml` non-incremental and preserve the Stryker `break: 100` threshold for every authoritative scope.
