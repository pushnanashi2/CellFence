import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const reviewedCorpusScript = path.join(root, "scripts", "reviewed-corpus-validate.mjs");
const expandedCorpusPath = path.join(root, "docs", "research", "corpora", "ts-js-reviewed-pilot-52-2026-07-25.json");
const policyDecisionsPath = path.join(root, "docs", "research", "ts-js-reviewed-pilot-12-2026-07-25-round18-policy-decisions.json");
const externalProtocolPath = path.join(root, "docs", "research", "protocols", "ts-js-reviewed-pilot-12-2026-07-25-round18-external.claim.json");

function runNode(args) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

test("round18 policy decisions resolve needs_policy without denominator shrinkage", () => {
  const decisions = JSON.parse(fs.readFileSync(policyDecisionsPath, "utf8"));
  assert.equal(decisions.schemaVersion, "cellfence.precision-policy-decisions.v1");
  assert.equal(decisions.summary.round17NeedsPolicyFindings, 11);
  assert.equal(decisions.summary.manifestPolicy, 11);
  assert.equal(decisions.summary.outOfScope, 0);
  assert.equal(decisions.summary.detectorSuppression, 0);
  assert.equal(decisions.summary.round17LabelsChanged, 0);
  assert.equal(decisions.summary.projectedIfFuturePolicyAdopted.blockingSuccesses, 86);
  assert.equal(decisions.summary.projectedIfFuturePolicyAdopted.blockingTrials, 86);
  assert.equal(decisions.summary.projectedIfFuturePolicyAdopted.claimStatus, "still_insufficient_evidence");
  assert.equal(decisions.decisions.length, 11);
  assert.equal(new Set(decisions.decisions.map((entry) => entry.findingId)).size, 11);
  assert.deepEqual(new Set(decisions.decisions.map((entry) => entry.round17FinalLabel)), new Set(["needs_policy"]));
  assert.deepEqual(new Set(decisions.decisions.map((entry) => entry.round18Decision)), new Set(["manifest_policy"]));
  assert.ok(decisions.decisions.every((entry) => entry.outOfScope === false));
  assert.ok(decisions.decisions.every((entry) => String(entry.futureDispositionIfPolicyAdopted).startsWith("detected_violation")));
});

test("round18 expanded corpus is agent-review valid but external-claim blocked", () => {
  const corpus = JSON.parse(fs.readFileSync(expandedCorpusPath, "utf8"));
  assert.equal(corpus.schemaVersion, "cellfence.corpus.v1");
  assert.equal(corpus.subjects.length, 52);
  assert.equal(new Set(corpus.subjects.map((subject) => subject.id)).size, 52);
  assert.equal(new Set(corpus.subjects.map((subject) => subject.repository)).size, 52);
  assert.equal(corpus.selectionPolicy.projectedBalance.projectedSelectedFindings, 251);
  assert.ok(corpus.selectionPolicy.projectedBalance.projectedMaxRepositoryContribution <= 0.1);

  const reviewed = runNode([reviewedCorpusScript, "--corpus", expandedCorpusPath]);
  assert.equal(reviewed.status, 0, reviewed.stderr || reviewed.stdout);
  const reviewedReport = JSON.parse(reviewed.stdout);
  assert.equal(reviewedReport.summary.subjects, 52);
  assert.equal(reviewedReport.summary.precisionEligibleSubjects, 52);
  assert.equal(reviewedReport.summary.issues, 0);

  const external = runNode([reviewedCorpusScript, "--corpus", expandedCorpusPath, "--external-claim"]);
  assert.equal(external.status, 1, external.stderr || external.stdout);
  const externalReport = JSON.parse(external.stdout);
  assert.equal(externalReport.externalClaim, true);
  assert.equal(externalReport.summary.precisionEligibleSubjects, 0);
  assert.equal(externalReport.summary.issues, 208);
  assert.ok(externalReport.issues.every((issue) => issue.includes("external claim review requires")));
});

test("round18 external protocol binds clean bundle and human organization worklist", () => {
  const protocol = JSON.parse(fs.readFileSync(externalProtocolPath, "utf8"));
  assert.equal(protocol.schemaVersion, "cellfence.precision-claim-protocol.v1");
  assert.equal(protocol.claim.artifactSetSha256, "2332ecafa136454250fe7335a86480852de8946547832f5599b197eaa2c67b7a");
  assert.deepEqual(protocol.claim.worklistArtifactSetSha256s, [
    "e0759d26d8d36556b9308006d33d913ee7063a6300b36d28952e26ed6f91bf56",
  ]);
  assert.equal(protocol.labelingPlan.requireExternalIndependentRaters, true);
  assert.deepEqual(protocol.labelingPlan.externalRaterTypes, ["human", "organization"]);
  assert.equal(protocol.labelingPlan.minimumExternalIndependentRaters, 1);
  assert.equal(protocol.samplingPlan.maxRepositoryContribution, 0.1);
});
