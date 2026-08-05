import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  AdversarialEvidenceInputError,
  fileSha256,
  fixtureTreeSha256,
  verifyAdversarialEvidence,
} from "../scripts/adversarial-evidence-verify.mjs";

const repoRoot = path.resolve(".");
const fixturesRoot = path.join(repoRoot, "fixtures");
const fixtureRelative = "invalid/private-cross-cell-import";
const fixtureRoot = path.join(fixturesRoot, ...fixtureRelative.split("/"));
const manifestPath = path.join(fixtureRoot, "cellfence.manifest.json");
const witnessPath = path.join(fixtureRoot, "src", "consumer", "public.ts");
const historicalStdoutPath = path.join(fixtureRoot, ".cellfence-evidence", "historical-stdout.json");

function evidenceInput(patch = {}) {
  const attempt = {
    id: "private-import-self-play-001",
    fixtureRoot: fixtureRelative,
    fixtureTreeSha256: fixtureTreeSha256(fixtureRoot),
    manifest: {
      path: "cellfence.manifest.json",
      sha256: fileSha256(manifestPath),
    },
    expectedViolation: {
      category: "private-cross-cell-import",
      description: "The consumer directly imports the producer's private implementation.",
      witness: {
        path: "src/consumer/public.ts",
        sha256: fileSha256(witnessPath),
        startLine: 1,
        endLine: 1,
        excerpt: "../producer/private",
      },
    },
    commandEvidence: {
      cwd: ".",
      argv: ["cellfence", "check", "--root", ".", "--manifest", "cellfence.manifest.json", "--json"],
      exitCode: 0,
      stdoutPath: ".cellfence-evidence/historical-stdout.json",
      stdoutSha256: fileSha256(historicalStdoutPath),
    },
    claimedBypass: {
      kind: "accepted-human-obvious-violation",
      summary: "CellFence was claimed to accept the private import.",
    },
    ...patch,
  };
  return { schemaVersion: "cellfence.adversarial-evidence.v1", attempts: [attempt] };
}

test("classifies a locally rerun CellFence violation as blocked", () => {
  const report = verifyAdversarialEvidence(evidenceInput(), { fixturesRoot });

  assert.equal(report.ok, true);
  assert.deepEqual(report.summary.byClassification, {
    reproduced_bypass: 0,
    blocked: 1,
    invalid_setup: 0,
    tool_error: 0,
  });
  assert.equal(report.attempts[0].classification, "blocked");
  assert.deepEqual(report.attempts[0].rerun.findingRuleIds, ["CELLFENCE_PRIVATE_IMPORT"]);
  assert.equal(report.attempts[0].promotionCandidate, null);
});

test("classifies exit zero with an explicit witness as a reproduced bypass using an injected runner", () => {
  let invocation;
  const runner = (received) => {
    invocation = received;
    return {
      status: 0,
      stdout: JSON.stringify({ ok: true, exitCode: 0, findings: [], warnings: [] }),
      stderr: "",
    };
  };

  const first = verifyAdversarialEvidence(evidenceInput(), { fixturesRoot, runner, timeoutMs: 2500 });
  const second = verifyAdversarialEvidence(evidenceInput(), { fixturesRoot, runner, timeoutMs: 2500 });

  assert.equal(first.attempts[0].classification, "reproduced_bypass");
  assert.equal(first.attempts[0].promotionCandidate.automaticTestModification, false);
  assert.equal(first.attempts[0].promotionCandidate.expectedViolation.witness.startLine, 1);
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args[1], "check");
  assert.ok(invocation.env.PATH.split(path.delimiter).every((entry) => path.isAbsolute(entry)));
  assert.equal(invocation.env.PATH.includes(fixtureRoot), false);
  assert.equal(invocation.timeoutMs, 2500);
  assert.deepEqual(first, second);
});

test("rejects unsafe fixture paths before invoking CellFence", () => {
  let invoked = false;
  const input = evidenceInput({ fixtureRoot: "../outside" });
  const report = verifyAdversarialEvidence(input, {
    fixturesRoot,
    runner() {
      invoked = true;
      throw new Error("must not run");
    },
  });

  assert.equal(invoked, false);
  assert.equal(report.attempts[0].classification, "invalid_setup");
  assert.match(report.attempts[0].setupErrors[0], /parent segments/);
});

test("rejects malformed top-level input", () => {
  assert.throws(
    () => verifyAdversarialEvidence({ schemaVersion: "cellfence.adversarial-evidence.v1" }, { fixturesRoot }),
    (error) => error instanceof AdversarialEvidenceInputError && /attempts must be a non-empty array/.test(error.message),
  );
});

test("rejects historical stdout claims that do not match the pinned artifact", () => {
  const input = evidenceInput();
  input.attempts[0].commandEvidence.stdoutSha256 = "a".repeat(64);
  const report = verifyAdversarialEvidence(input, { fixturesRoot });
  assert.equal(report.attempts[0].classification, "invalid_setup");
  assert.match(report.attempts[0].setupErrors[0], /does not match commandEvidence.stdoutPath/);
});
