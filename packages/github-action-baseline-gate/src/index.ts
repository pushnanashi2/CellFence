// 0.4.0 (prototype) — cellfence-baseline-gate.
//
// The full implementation will:
//   1. download the base and head CellFence baselines
//   2. call `cellfence baseline gate` (or the in-process equivalent)
//   3. apply the `governance-change` label
//   4. upsert a sticky PR comment summarising the change
//   5. block merge until an approver from the `baseline-codeowners`
//      list (or the `.cellfence/baselines/` CODEOWNERS section) has
//      approved
//   6. warn or fail when the PR mixes baseline and implementation
//      changes
//
// This skeleton exists so the action.yml is real (GitHub reads it on
// the marketplace) and so engineers can sketch a workflow against
// `@cellfence/github-action-baseline-gate@v0` before the 0.4.0 wiring
// is finished. The `dist/index.js` produced by `npm run build` is
// intentionally a no-op for now.

import * as core from "@actions/core";

async function run(): Promise<void> {
  core.warning("cellfence-baseline-gate is a 0.4.0 prototype; no enforcement is performed yet.");
  const version = core.getInput("cellfence-version") || "0.2.1";
  core.info(`cellfence version: ${version}`);
  const codeowners = core.getInput("baseline-codeowners");
  if (codeowners) {
    core.info(`baseline codeowners: ${codeowners}`);
  } else {
    core.info("baseline codeowners: using repository CODEOWNERS for .cellfence/baselines/");
  }
  // The full implementation lives in the 0.4.0 milestone. See
  // docs/baseline-gate.md for the design.
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
