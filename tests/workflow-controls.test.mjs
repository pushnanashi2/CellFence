import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { diffWorkflowControls } from "../packages/engine/dist/workflow-controls.js";

const root = process.cwd();
const fixtureRoot = path.join(root, "tests/fixtures/semantic-event-detector-v32");

function readFixture(name) {
  return fs.readFileSync(path.join(fixtureRoot, name), "utf8");
}

function includesDelta(deltas, predicate, message) {
  assert.ok(deltas.some(predicate), `${message}\n${JSON.stringify(deltas, null, 2)}`);
}

test("semantic detector v3.2 fixture freezes workflow deletion controls", () => {
  const deltas = diffWorkflowControls(
    readFixture("workflow-deletion.before.yml"),
    readFixture("workflow-deletion.after.yml"),
  );

  includesDelta(
    deltas,
    (delta) => delta.kind === "workflow_trigger" && delta.before === "present" && delta.after === null,
    "workflow deletion must report trigger removal",
  );
  includesDelta(
    deltas,
    (delta) => delta.kind === "permission" && delta.before === "write" && delta.after === null,
    "workflow deletion must report permission removal",
  );
  includesDelta(
    deltas,
    (delta) => delta.kind === "credential_or_secret" && delta.before === "secrets.NPM_TOKEN" && delta.after === null,
    "workflow deletion must report secret removal",
  );
  includesDelta(
    deltas,
    (delta) => delta.kind === "action_reference" && delta.before === "actions/checkout@v4" && delta.after === null,
    "workflow deletion must report checkout action removal",
  );
  includesDelta(
    deltas,
    (delta) => delta.kind === "action_reference" && delta.before === "actions/setup-node@v4" && delta.after === null,
    "workflow deletion must report setup-node action removal",
  );
  includesDelta(
    deltas,
    (delta) => delta.kind === "repository_write_or_publish" && delta.before?.includes("npm publish") && delta.after === null,
    "workflow deletion must report publish operation removal",
  );
});

test("semantic detector v3.2 fixture freezes suppression replacement granularity", () => {
  const deltas = diffWorkflowControls(
    readFixture("suppression-replacement.before.yml"),
    readFixture("suppression-replacement.after.yml"),
  ).filter((delta) => delta.kind === "failure_enforcement");

  includesDelta(
    deltas,
    (delta) => delta.before === "sudo systemctl stop myapp" && delta.after === null,
    "suppression replacement must report removed systemctl command",
  );
  includesDelta(
    deltas,
    (delta) => delta.before === null && delta.after === "sudo docker stop trippiece-container",
    "suppression replacement must report added docker stop command",
  );
  includesDelta(
    deltas,
    (delta) => delta.before === null && delta.after === "sudo docker rm trippiece-container",
    "suppression replacement must report added docker rm command",
  );
});

test("semantic detector v3.2 freeze record keeps comparable REMOVED_TP at zero", () => {
  const summary = JSON.parse(readFixture("freeze-summary.json"));
  assert.equal(summary.detectorVersion, "v3.2");
  assert.equal(summary.comparableControlTombstones.removedTruePositive, 0);
  assert.equal(summary.comparableEventTombstones.removedTruePositive, 0);
  assert.equal(summary.windowDrift.excludedFromRecallRegressionDenominator, true);
  assert.deepEqual(summary.regressionFixtures, ["workflow-deletion", "suppression-replacement"]);
});
