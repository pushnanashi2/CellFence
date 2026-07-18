import assert from "node:assert/strict";
import test from "node:test";

import { runAdversarialValidation } from "../scripts/adversarial-validation.mjs";

test("adversarial validation harness exercises every category", () => {
  const report = runAdversarialValidation({ iterations: 3 });

  assert.equal(report.schemaVersion, "cellfence.adversarial-validation.v1");
  assert.equal(report.ok, true, JSON.stringify(report.failures, null, 2));
  assert.deepEqual(report.categories, ["language-independent", "python", "js-ts"]);
  assert.equal(report.summary["language-independent"].total, 3);
  assert.equal(report.summary.python.total, 3);
  assert.equal(report.summary["js-ts"].total, 3);
});

test("adversarial validation harness can run one category", () => {
  const report = runAdversarialValidation({ iterations: 2, category: "python" });

  assert.equal(report.ok, true, JSON.stringify(report.failures, null, 2));
  assert.deepEqual(report.categories, ["python"]);
  assert.equal(report.summary.python.total, 2);
  assert.equal(report.summary["js-ts"], undefined);
});
