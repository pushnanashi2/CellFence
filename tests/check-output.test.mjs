import assert from "node:assert/strict";
import test from "node:test";

import { findingFingerprint as cliFindingFingerprint } from "../packages/cli/dist/check-output.js";
import { findingFingerprint as engineFindingFingerprint } from "../packages/engine/dist/index.js";

test("CLI check output uses the engine canonical finding fingerprint fallback", () => {
  const finding = {
    ruleId: "CELLFENCE_PRIVATE_IMPORT",
    severity: "error",
    filePath: "src\\consumer\\public.ts",
    cellId: "consumer",
    producerCellId: "producer",
    message: "consumer imports private producer source",
    details: {
      message: "wording should not affect the canonical fingerprint",
      currentHash: "old",
      nextHash: "new",
      specifier: "../producer/internal",
      targetPath: "src\\producer\\internal.ts",
    },
  };

  assert.equal(cliFindingFingerprint(finding), engineFindingFingerprint(finding));
  assert.equal(cliFindingFingerprint({ ...finding, fingerprint: "precomputed-fingerprint" }), "precomputed-fingerprint");
});
