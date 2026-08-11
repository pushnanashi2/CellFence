# Coverage (0.4.0 prototype)

`cellfence coverage` reports the parts of a repository that
CellFence could *not* see through. Fail-invisible becomes
fail-visible: the same way `cellfence check` rejects violations,
`cellfence coverage` flags the shapes that the engine could not
resolve so a human can decide whether to add an adapter, a
`resourceContracts` entry, or an explicit `// @cellfence ignore`.

## What it reports

Three buckets, counted and listed separately:

- **Unresolved imports** — dynamic imports with non-literal
  specifiers, `require(variable)` calls, `tsconfig` paths the
  resolver cannot pin down.
- **Unresolved resources** — ORM calls (Prisma, TypeORM, BullMQ,
  Drizzle, Knex, SQLAlchemy, Celery) that the built-in adapter did
  not recognise. The collector records the call shape and the file
  location so the user can add a `resourceContracts` entry or a
  custom resource adapter.
- **Unresolved public surface** — isolated declarations whose
  public type could not be inferred (often `any` leakage, cyclic
  references, or a hand-rolled `declare module`).

## Output

`cellfence coverage` writes a single `cellfence.coverage.v1` JSON
document on stdout (or prints a human summary with `--format
human`). SARIF output is queued for 0.4.0.

```text
$ cellfence coverage
cellfence coverage: 95.35% (1189/1247 files analyzed, 49 unresolved observations)
```

`--fail-under` (or `CELLFENCE_COVERAGE_FAIL_UNDER=<ratio>`) makes
the command exit non-zero when coverage falls below the threshold
so CI can gate on it.

## Wiring to `init --infer`

The coverage collector's `unresolved` array is the same shape
`init --infer` would consume to seed `resourceContracts`. The full
integration (walking the repository, asking each adapter to call
into the collector, and feeding the output back into `init`) is
queued for 0.4.0.
