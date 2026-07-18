# OSS Python Framework 800 Onboarding Run

This run checks whether CellFence can onboard and statically check large,
framework-shaped Python OSS corpora without target installs or repository
scripts. It is not a precision study: every subject uses an unreviewed inferred
production-scope manifest, so findings are tuning and onboarding evidence until
manual labels or reviewed manifests exist.

## Corpus

Four GitHub topic corpora were frozen on 2026-07-18:

| framework topic | corpus | rows |
| --- | --- | ---: |
| Django | `docs/research/corpora/oss-python-django-200-2026-07-18.json` | 200 |
| FastAPI | `docs/research/corpora/oss-python-fastapi-200-2026-07-18.json` | 200 |
| SQLAlchemy | `docs/research/corpora/oss-python-sqlalchemy-200-2026-07-18.json` | 200 |
| Celery | `docs/research/corpora/oss-python-celery-200-2026-07-18.json` | 200 |

Selection rule per topic:

```text
GitHub Search API
topic:<framework> language:Python fork:false archived:false size:<100000
sort=stars order=desc
```

Each row stores the repository clone URL and an exact 40-hex `HEAD` commit from
`git ls-remote`. The 800 rows contain 754 unique repositories; 46 rows overlap
between framework topics.

## Command

Each corpus was run with shallow clones, discarded checkouts, and
production-scope manifest inference:

```bash
npm run research:corpus -- \
  --corpus docs/research/corpora/oss-python-<framework>-200-2026-07-18.json \
  --out reports/corpus/oss-python-<framework>-200-2026-07-18.after-python-syntax-fix.json \
  --workdir tmp/corpus-python-<framework>-200-2026-07-18-after-python-syntax-fix \
  --clone-mode shallow \
  --discard-checkouts \
  --infer-scope production
```

The harness did not install target dependencies, execute package scripts, open
pull requests, or file issues.

## Result

The first run exposed a Python robustness gap: Python AST parse failures from
Python 3.12 type-alias/generic syntax, Python 2 syntax, and cookiecutter/Jinja
templates aborted manifest inference for 34 subjects.

CellFence was then changed to report those cases as
`CELLFENCE_UNSUPPORTED_PYTHON_SYNTAX` fail-closed findings instead of internal
manifest failures. The same frozen corpora were rerun.

| framework | before completed | before failed | after completed | after failed | clean checks | checks with findings | total findings | unsupported Python syntax findings |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Django | 195 | 5 | 200 | 0 | 67 | 133 | 1,708 | 17 |
| FastAPI | 191 | 9 | 200 | 0 | 54 | 146 | 3,358 | 116 |
| SQLAlchemy | 189 | 11 | 200 | 0 | 76 | 124 | 2,390 | 73 |
| Celery | 191 | 9 | 200 | 0 | 61 | 139 | 1,345 | 40 |
| **Total** | **766** | **34** | **800** | **0** | **258** | **542** | **8,801** | **246** |

Dominant post-fix rule families:

| framework | leading rule counts |
| --- | --- |
| Django | `CELLFENCE_UNRESOLVED_IMPORT` 966; `CELLFENCE_PRIVATE_IMPORT` 474; `CELLFENCE_UNDECLARED_RESOURCE_ACCESS` 143 |
| FastAPI | `CELLFENCE_UNDECLARED_RESOURCE_ACCESS` 1,918; `CELLFENCE_PRIVATE_IMPORT` 966; `CELLFENCE_UNRESOLVED_IMPORT` 175 |
| SQLAlchemy | `CELLFENCE_PRIVATE_IMPORT` 792; `CELLFENCE_UNDECLARED_CONSUMER` 667; `CELLFENCE_UNDECLARED_RESOURCE_ACCESS` 442 |
| Celery | `CELLFENCE_PRIVATE_IMPORT` 477; `CELLFENCE_UNRESOLVED_IMPORT` 373; `CELLFENCE_UNDECLARED_RESOURCE_ACCESS` 332 |

## Interpretation

This materially strengthens Python onboarding robustness:

- 800/800 framework-topic subjects now reach `cellfence check`;
- unsupported Python syntax and template-like `.py` files are counted as
  fail-closed findings rather than aborting the harness;
- Python import and public-surface extraction now survives mixed real-world
  Python corpora with Python 2 remnants, Python 3.12 syntax, and templates.

It does not prove Python precision. The findings come from inferred manifests,
and many are likely policy/setup/scope questions rather than upstream defects.
The next proof step is to label a deterministic sample or rerun selected
subjects with reviewed manifests.
