import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import {
  generatedHelpBlock,
  updateGeneratedHelp,
} from "../scripts/cli-help-doc.mjs";

test("CLI help documentation replaces only its generated block", () => {
  const original = "before\n<!-- BEGIN GENERATED CLI HELP -->\nold\n<!-- END GENERATED CLI HELP -->\nafter\n";
  const updated = updateGeneratedHelp(original, "Usage:\r\n  cellfence check\r\n");
  assert.equal(updated, `before\n${generatedHelpBlock("Usage:\n  cellfence check")}\nafter\n`);
  assert.throws(() => updateGeneratedHelp("no markers", "help"), /missing/);
});

test("CLI help documentation preserves CRLF checkouts", () => {
  const original = "before\r\n<!-- BEGIN GENERATED CLI HELP -->\r\nold\r\n<!-- END GENERATED CLI HELP -->\r\nafter\r\n";
  const updated = updateGeneratedHelp(original, "Usage:\n  cellfence check\n");
  assert.equal(updated, `before\r\n${generatedHelpBlock("Usage:\n  cellfence check", "\r\n")}\r\nafter\r\n`);
  assert.equal(updateGeneratedHelp(updated, "Usage:\r\n  cellfence check\r\n"), updated);
});

test("committed README CLI help matches the built CLI", () => {
  const result = spawnSync(process.execPath, [path.resolve("scripts/cli-help-doc.mjs"), "--check"], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
