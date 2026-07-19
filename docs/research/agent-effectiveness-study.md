# Agent Effectiveness Study

This protocol measures whether CellFence helps coding agents complete realistic
repository changes with fewer boundary, public API, and resource-contract
violations. It is an A/B study harness, not a crawler and not a precision claim
by itself.

The harness prepares local task packs from a frozen public-OSS corpus. Execution
agents then edit the cloned repositories under two arms:

- `cellfence`: the agent may inspect CellFence context and run CellFence checks.
- `control`: the agent uses ordinary repository reasoning and does not inspect
  CellFence output or manifest paths.

A separate judge, ideally a different agent or a human reviewer, labels each
result from the patch and logs. The report aggregates those labels by arm and by
paired subject/scenario.

## What This Can Claim

This study can support a narrow mechanism claim:

> On a frozen corpus and pre-registered scenarios, the CellFence-assisted arm
> produced fewer judged boundary violations than the control arm.

It does not prove broad CellFence precision, recall, long-term operational ROI,
or that every finding is a real bug. Those require reviewed manifests, history
replay, independent labels, and dogfooding evidence.

## Safety Rules

The harness is local-only and non-invasive:

- pin every subject to an exact 40-hex commit before running;
- clone only repositories listed in the corpus JSON;
- do not create upstream issues, pull requests, comments, or discussions;
- do not publish packages or upload artifacts externally;
- do not install target dependencies or run target install scripts;
- keep target manifests and generated control files outside the checkout when
  using copied manifests;
- treat public-OSS results as research evidence, not automated bug reports.

If a separate experiment needs dependency installation, use an isolated runner
and pre-register that risk separately.

## Corpus File

```json
{
  "schemaVersion": "cellfence.agent-effectiveness.corpus.v1",
  "studyId": "agent-effectiveness-ts-js-2026-07-19",
  "seed": "agent-effectiveness-ts-js-2026-07-19-v1",
  "subjects": [
    {
      "id": "example-project",
      "repository": "https://github.com/example/project.git",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "manifest": {
        "strategy": "copy",
        "source": "manifests/example-project.cellfence.manifest.json",
        "reviewStatus": "reviewed"
      }
    }
  ]
}
```

Manifest strategies:

| Strategy | Use case |
| --- | --- |
| `existing` | The subject already has `cellfence.manifest.json`. |
| `copy` | A reviewed CellFence manifest is stored next to the corpus file and copied into the study control directory. |
| `infer` | The task pack records a non-destructive planned manifest path. Use this for onboarding/friction studies, not precision claims. |

## Scenario File

```json
{
  "schemaVersion": "cellfence.agent-effectiveness.scenarios.v1",
  "scenarios": [
    {
      "id": "extract-client",
      "title": "Extract a reusable client layer",
      "task": "Move duplicated HTTP request construction into a shared client module while keeping existing public imports stable.",
      "expectedScale": {
        "filesChanged": 6,
        "insertions": 180,
        "deletions": 80
      },
      "riskTags": ["ownership", "public-api", "resource-contract"],
      "successCriteria": [
        "The feature still builds or the attempted build failure is explained.",
        "No private implementation module is imported across a declared boundary.",
        "New external resource access is declared or avoided."
      ],
      "antiGoals": [
        "Do not change package publishing metadata.",
        "Do not update CellFence baselines as a shortcut."
      ]
    }
  ]
}
```

## Prepare Task Packs

Validate a corpus without cloning:

```bash
npm run research:effectiveness -- \
  --corpus docs/research/corpora/agent-effectiveness-ts-js.example.json \
  --scenarios docs/research/scenarios/agent-effectiveness-ts-js.example.json \
  --out reports/agent-effectiveness/example.plan.json \
  --dry-run
```

Prepare local checkouts and task packs:

```bash
npm run research:effectiveness -- \
  --corpus docs/research/corpora/agent-effectiveness-ts-js-200.json \
  --scenarios docs/research/scenarios/agent-effectiveness-ts-js.json \
  --workdir tmp/agent-effectiveness-ts-js-200 \
  --out reports/agent-effectiveness/ts-js-200.plan.json \
  --clone-mode shallow
```

The report contains stable `assignmentId` values. Give each execution agent the
matching `TASK.md` under the `assignments/` directory.

Each `assignmentId` is bound to the study id, seed, subject repository/commit
metadata, manifest declaration, copied manifest content hash when applicable,
scenario content, and arm. If the frozen commit, copied manifest, or scenario
text changes without changing the seed, stale run or judgment JSONL will
reference unknown assignments instead of silently aggregating.

Use `--discard-checkouts` only for validation or inventory runs where no agent
will edit the prepared checkouts.

## Execution JSONL

Agents write one run record per assignment:

```json
{"schemaVersion":"cellfence.agent-effectiveness.run.v1","studyId":"agent-effectiveness-ts-js-2026-07-19","assignmentId":"sha256:...","agentId":"worker-001","status":"completed","diffStat":{"filesChanged":6,"insertions":190,"deletions":75}}
```

Allowed `status` values are `planned`, `completed`, `failed`, `blocked`, and
`timeout`.

When a `--runs` file is supplied, the harness requires exactly one resolved run
record for every assignment before the report is claim-eligible.

## Judgment JSONL

Judges write one record per assignment:

```json
{"schemaVersion":"cellfence.agent-effectiveness.judgment.v1","studyId":"agent-effectiveness-ts-js-2026-07-19","assignmentId":"sha256:...","judgeId":"judge-001","taskSuccess":"pass","frictionCost":"low","promiseLabel":"promising","boundaryViolations":0,"publicApiDrift":0,"resourceContractDrift":0,"reviewability":5,"rationale":"The patch completed the task without crossing declared boundaries."}
```

Label definitions:

| Field | Meaning |
| --- | --- |
| `taskSuccess` | `pass`, `partial`, `fail`, or `unknown`. |
| `frictionCost` | `none`, `low`, `medium`, `high`, or `unknown`. |
| `promiseLabel` | `promising`, `neutral`, `harmful`, or `inconclusive`. |
| `boundaryViolations` | Count of judged ownership or private import violations in the patch. |
| `publicApiDrift` | Count of public surface changes not justified by the task. |
| `resourceContractDrift` | Count of new undeclared file, DB, queue, HTTP, or similar resource accesses. |
| `reviewability` | Integer from 1 to 5, where 5 is easiest to review. |

When multiple judges review the same patch, resolve their disagreement into one
adjudicated judgment record before aggregation. The v1 report intentionally
rejects multiple judgment records for the same assignment so paired deltas do
not depend on JSONL order.

Run aggregation:

```bash
npm run research:effectiveness -- \
  --corpus docs/research/corpora/agent-effectiveness-ts-js-200.json \
  --scenarios docs/research/scenarios/agent-effectiveness-ts-js.json \
  --runs reports/agent-effectiveness/ts-js-200.runs.jsonl \
  --judgments reports/agent-effectiveness/ts-js-200.judgments.jsonl \
  --out reports/agent-effectiveness/ts-js-200.report.json \
  --dry-run
```

The final report records corpus, scenario, run, and judgment hashes plus an
`evidenceSetSha256` over the stable evidence fields. `claimEligibility.eligible`
is true only when every subject is pinned to an exact 40-hex commit, run and
judgment files are both supplied, every assignment has exactly one resolved run
and one adjudicated judgment, and validation findings are zero. `--allow-floating-ref`
is allowed for exploratory dry-runs only; those reports remain proof-ineligible.
A non-zero validation finding count means the result is not claim-eligible until
the JSONL inputs are fixed.
