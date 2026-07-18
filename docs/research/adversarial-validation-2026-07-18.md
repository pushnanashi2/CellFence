# Adversarial Validation - 2026-07-18

This is an adversarial mechanism validation run for CellFence's boundary checks. It is not a corpus precision claim and it is not evidence that arbitrary real repositories are defect-free. The goal is narrower: try to turn plausible bypasses and severe false positives into deterministic fixtures, fix the false greens, and preserve green controls.

## Setup

Six independent review agents attacked the current implementation from three angles:

- language-independent: manifest/schema, ownership, waivers, claims, baseline seals, and runtime evidence trust boundaries;
- Python: import resolution plus FastAPI, Django, SQLAlchemy, and Celery resource detection;
- JS/TS: CommonJS loaders, `createRequire`, `import type`, path aliases, package `imports`/`exports`, and public surface hashing.

The committed harness is `scripts/adversarial-validation.mjs`. It creates temporary repositories, writes minimal manifests and source files, runs `checkRepository`, and verifies that expected blocking cases block while control cases stay green. It does not publish packages, open issues, install subject dependencies, or execute untrusted fixture code.

## Result

The final run wrote `docs/research/adversarial-validation-2026-07-18.json`.

| Category | Iterations | Matched | Confirmed blocks | Confirmed greens |
| --- | ---: | ---: | ---: | ---: |
| language-independent | 100 | 100 | 95 | 5 |
| Python | 100 | 100 | 90 | 10 |
| JS/TS | 100 | 100 | 92 | 8 |

Command:

```sh
node scripts/adversarial-validation.mjs --iterations 100 --out docs/research/adversarial-validation-2026-07-18.json
```

## Issues Converted Into Fixtures

Language-independent fixes:

- wildcard ownership overlap such as `src/*/public.ts` intersecting `src/a/*.ts`;
- escaped duplicate JSON keys such as `"cells"` plus `"\u0063ells"`;
- source-local waivers no longer suppress required rules;
- unsealed/unverified baselines no longer grandfather runtime evidence resource access;
- sealed baselines fail closed when no verifier is configured;
- repo-outside runtime evidence paths are rejected;
- runtime evidence `commitSha` is checked against `HEAD` when the checked root is the Git worktree root.

Python fixes:

- `from producer import internal` resolves as a candidate private submodule import;
- literal dynamic imports through `importlib.import_module`, `__import__`, `pkgutil.resolve_name`, aliases, `getattr`, and literal `eval`/`exec` are inspected;
- computed Python dynamic imports fail closed;
- FastAPI constants, route method lists, websockets, and `include_router` prefixes are resolved;
- Django URL aliases, model managers, default managers, model instances, and writes are covered;
- SQLAlchemy `session.get`, table methods, constants, driver SQL, and bulk writes are covered even without import-word hints;
- Celery task declarations and signatures are covered while arbitrary `.delay()` methods are not treated as Celery publishes.

JS/TS fixes:

- indirect CommonJS loaders cover `global.require`, `this.require`, `process.mainModule.require`, `module.constructor._load`, `call`, `apply`, `Reflect.apply`, and bound aliases;
- literal `eval` / `Function` string execution containing `require("...")` is inspected, and computed string execution fails closed;
- `import("...").Type` nodes are included as type-only imports;
- importer-nearest tsconfig path aliases are preferred before flattened workspace aliases;
- package `imports` / self `exports` condition selection no longer prefers `types` for runtime imports;
- public surface hashing follows project re-exports and public `import type` dependencies.

## Remaining Scope

This run validates fixed adversarial mechanisms and controls. It does not estimate real-world precision/recall, long-term developer friction, or full dynamic language behavior. Runtime strings and framework behavior remain intentionally bounded by static evidence and fail-closed findings when they cannot be resolved.
