import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkRepository } from "../packages/engine/dist/index.js";

const repoRoot = process.cwd();
const corpusPath = path.join(repoRoot, "fixtures/acceptance-corpus/acceptance-cases.json");

test("acceptance corpus fixtures match their expected gate decisions", () => {
  const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  assert.equal(corpus.schemaVersion, "cellfence.acceptance-corpus.v1");
  assert.ok(corpus.cases.length >= 3);

  for (const entry of corpus.cases) {
    const result = checkRepository({
      rootDir: path.join(repoRoot, entry.fixture),
      manifestPath: "cellfence.manifest.json",
      includeEvidenceGraph: true,
      includeAcceptanceRecord: true,
    });
    const record = result.acceptanceRecord;
    assert.equal(result.ok, entry.expected.ok, entry.id);
    assert.equal(record.decision.gateDecision, entry.expected.gateDecision, entry.id);
    assert.equal(record.evidence.status, "COMPLETE", entry.id);
    assert.ok(record.evidence.requiredObservations.length > 0, entry.id);
    assert.deepEqual(
      record.decision.ruleResults
        .filter((rule) => rule.status === "VIOLATED")
        .map((rule) => rule.ruleId)
        .sort(),
      [...entry.expected.violatedRules].sort(),
      entry.id,
    );
  }
});
