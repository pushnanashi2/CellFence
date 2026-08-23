import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
}

test("ci-counts exits nonzero when any measured category fails", (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX executable stubs are sufficient for CI coverage on Linux.");
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-ci-counts-"));
  context.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const binDir = path.join(tempDir, "bin");
  const outDir = path.join(tempDir, "out");
  fs.mkdirSync(binDir, { recursive: true });

  writeExecutable(path.join(binDir, "npm"), `#!/bin/sh
exit 0
`);
  writeExecutable(path.join(binDir, "npx"), `#!/bin/sh
if [ "$1" = "c8" ]; then
  exit 1
fi
printf '[]\\n'
exit 0
`);
  writeExecutable(path.join(binDir, "node"), `#!/bin/sh
if [ "$1" = "--test" ]; then
  printf 'TAP version 13\\n# fail 0\\n# cancelled 0\\n'
  exit 0
fi
printf '{"findings":[],"warnings":[]}\\n'
exit 0
`);

  const result = spawnSync(process.execPath, ["scripts/ci-counts.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CELLFENCE_CI_COUNTS_DIR: outDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);

  const summary = JSON.parse(fs.readFileSync(path.join(outDir, "summary.json"), "utf8"));
  assert.equal(summary.results.coverage.exitCode, 1);
  assert.equal(summary.results.lint.exitCode, 0);
});
