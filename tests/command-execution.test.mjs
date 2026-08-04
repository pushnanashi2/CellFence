import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCmdCommandLine,
  execCommandSync,
  prepareCommandExecution,
  resolveCommand,
} from "../packages/engine/dist/command-execution.js";

function withCommandEnvironment(environment, action) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const previous = new Map(
    ["PATH", "PATHEXT", "ComSpec", "COMSPEC"].map((name) => [name, process.env[name]]),
  );
  try {
    if (environment.platform) {
      Object.defineProperty(process, "platform", { configurable: true, value: environment.platform });
    }
    for (const [name, value] of Object.entries(environment.variables || {})) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return action();
  } finally {
    if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("Windows batch command lines quote cmd metacharacters and embedded quotes", () => {
  const commandLine = buildCmdCommandLine("C:\\Tools\\runner.cmd", [
    "plain",
    "a&b",
    "x|y",
    "x>y",
    "x<y",
    "x^y",
    "x!y",
    "say\"hi",
  ]);

  assert.equal(
    commandLine,
    String.raw`""C:\Tools\runner.cmd" "plain" "a&b" "x|y" "x>y" "x<y" "x^y" "x!y" "say\"hi""`,
  );
});

test("Windows batch command lines reject expansion and line-breaking inputs", () => {
  assert.throws(
    () => buildCmdCommandLine("C:\\Tools\\runner.cmd", ["%PATH%"]),
    /argument cannot contain %/,
  );
  assert.throws(
    () => buildCmdCommandLine("C:\\Tools\\runner.cmd", ["first\nsecond"]),
    /argument cannot contain a newline/,
  );
  assert.throws(
    () => buildCmdCommandLine("C:\\Tools\\runner.cmd", ["first\rsecond"]),
    /argument cannot contain a newline/,
  );
  assert.throws(
    () => buildCmdCommandLine("C:\\Unsafe%Path\\runner.cmd", []),
    /path cannot contain %/,
  );
});

test("Windows command resolution prefers native executables over batch shims", () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-command-resolution-"));
  try {
    const comPath = path.join(binDir, "cellfence.COM");
    const commandPath = path.join(binDir, "cellfence.CMD");
    const executablePath = path.join(binDir, "cellfence.EXE");
    fs.writeFileSync(comPath, "native com executable\n");
    fs.writeFileSync(commandPath, "batch shim\n");
    fs.writeFileSync(executablePath, "native executable\n");
    withCommandEnvironment({
      platform: "win32",
      variables: { PATH: binDir, PATHEXT: ".CMD;.EXE;.COM" },
    }, () => {
      assert.equal(resolveCommand("cellfence"), comPath);
      fs.unlinkSync(comPath);
      assert.equal(resolveCommand("cellfence"), executablePath);
      fs.unlinkSync(executablePath);
      assert.equal(resolveCommand("cellfence"), commandPath);
    });
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("Windows command resolution normalizes PATHEXT and handles explicit extensions", () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-command-pathext-"));
  try {
    const extensionlessPath = path.join(binDir, "cellfence");
    const commandPath = path.join(binDir, "cellfence.CMD");
    const appendedExtensionPath = path.join(binDir, "cellfence.CMD.COM");
    fs.writeFileSync(extensionlessPath, "extensionless executable\n");
    fs.writeFileSync(commandPath, "batch shim\n");
    fs.writeFileSync(appendedExtensionPath, "wrong executable\n");
    withCommandEnvironment({
      platform: "win32",
      variables: { PATH: binDir, PATHEXT: "; .cmd ;" },
    }, () => {
      assert.equal(resolveCommand("cellfence"), commandPath);
      assert.equal(resolveCommand("cellfence.CMD"), commandPath);
    });
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("Windows command resolution uses the default PATHEXT and extensionless fallback", () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-command-default-pathext-"));
  try {
    const defaultCommandPath = path.join(binDir, "default-command.CMD");
    const executablePath = path.join(binDir, "native.EXE");
    const extensionlessPath = path.join(binDir, "script");
    fs.writeFileSync(defaultCommandPath, "default batch command\n");
    fs.writeFileSync(executablePath, "native executable\n");
    fs.writeFileSync(extensionlessPath, "extensionless executable\n");
    withCommandEnvironment({
      platform: "win32",
      variables: { PATH: binDir, PATHEXT: undefined },
    }, () => {
      assert.equal(resolveCommand("default-command"), defaultCommandPath);
      assert.equal(resolveCommand("native"), executablePath);
      assert.equal(resolveCommand("script"), extensionlessPath);
      assert.equal(resolveCommand("missing"), "missing");
    });
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("command resolution preserves direct paths and POSIX extension rules", () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-command-posix-"));
  try {
    const executablePath = path.join(binDir, "tool");
    const windowsExecutablePath = path.join(binDir, "windows-only.EXE");
    const nestedCandidate = path.join(binDir, "nested", "tool");
    const backslashCandidate = path.join(binDir, "nested\\tool");
    fs.mkdirSync(path.dirname(nestedCandidate), { recursive: true });
    for (const candidate of [executablePath, windowsExecutablePath, nestedCandidate, backslashCandidate]) {
      fs.writeFileSync(candidate, "executable\n");
    }
    withCommandEnvironment({
      platform: "linux",
      variables: { PATH: binDir, PATHEXT: ".EXE" },
    }, () => {
      assert.equal(resolveCommand("tool"), executablePath);
      assert.equal(resolveCommand("windows-only"), "windows-only");
      assert.equal(resolveCommand("nested/tool"), "nested/tool");
      assert.equal(resolveCommand("nested\\tool"), "nested\\tool");
      assert.equal(resolveCommand(executablePath), executablePath);
    });
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("command resolution ignores empty PATH entries", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-command-empty-path-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-command-nonempty-path-"));
  const previousCwd = process.cwd();
  try {
    fs.writeFileSync(path.join(rootDir, "local-tool"), "local executable\n");
    fs.writeFileSync(path.join(binDir, "local-tool"), "selected executable\n");
    fs.mkdirSync(path.join(rootDir, "Stryker was here!"));
    fs.writeFileSync(path.join(rootDir, "Stryker was here!", "fallback-tool"), "mutant target\n");
    process.chdir(rootDir);
    withCommandEnvironment({
      platform: "linux",
      variables: { PATH: `${path.delimiter}${binDir}`, PATHEXT: undefined },
    }, () => {
      assert.equal(resolveCommand("local-tool"), path.join(binDir, "local-tool"));
    });
    withCommandEnvironment({
      platform: "linux",
      variables: { PATH: "", PATHEXT: undefined },
    }, () => {
      assert.equal(resolveCommand("fallback-tool"), "fallback-tool");
    });
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("Windows batch execution plans force cmd.exe safety options", () => {
  const options = { encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "pipe"] };
  withCommandEnvironment({
    platform: "win32",
    variables: { ComSpec: "C:\\Windows\\cmd.exe" },
  }, () => {
    assert.deepEqual(prepareCommandExecution("C:\\Tools\\runner.BAT", ["a&b"], options), {
      commandPath: "C:\\Windows\\cmd.exe",
      args: ["/d", "/s", "/c", String.raw`""C:\Tools\runner.BAT" "a&b""`],
      options: { ...options, shell: false, windowsVerbatimArguments: true },
    });
  });
  withCommandEnvironment({
    platform: "win32",
    variables: { ComSpec: undefined, COMSPEC: "C:\\Fallback\\cmd.exe" },
  }, () => {
    assert.equal(
      prepareCommandExecution("C:\\Tools\\runner.CMD", [], options).commandPath,
      "C:\\Fallback\\cmd.exe",
    );
  });
  withCommandEnvironment({
    platform: "win32",
    variables: { ComSpec: undefined, COMSPEC: undefined },
  }, () => {
    assert.equal(prepareCommandExecution("C:\\Tools\\runner.CMD", [], options).commandPath, "cmd.exe");
  });
});

test("non-batch execution plans preserve executable arguments and options", () => {
  const args = ["--version"];
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  withCommandEnvironment({ platform: "linux" }, () => {
    assert.deepEqual(prepareCommandExecution(process.execPath, args, options), {
      commandPath: process.execPath,
      args,
      options,
    });
  });
  withCommandEnvironment({ platform: "win32" }, () => {
    assert.deepEqual(prepareCommandExecution("C:\\Tools\\runner.exe", args, options), {
      commandPath: "C:\\Tools\\runner.exe",
      args,
      options,
    });
  });
});

test("Windows batch execution delegates one quoted command line to cmd.exe", {
  skip: process.platform === "win32" ? "the fake cmd executable is a POSIX test fixture" : false,
}, () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-command-execution-"));
  try {
    const commandPath = path.join(binDir, "runner.CMD");
    const fakeCmdPath = path.join(binDir, "fake-cmd");
    fs.writeFileSync(commandPath, "batch shim\n");
    fs.writeFileSync(
      fakeCmdPath,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
    );
    fs.chmodSync(fakeCmdPath, 0o755);
    const output = withCommandEnvironment({
      platform: "win32",
      variables: { PATH: binDir, PATHEXT: ".CMD", ComSpec: fakeCmdPath },
    }, () => execCommandSync("runner", ["a&b", "x|y"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }));

    assert.equal(output, JSON.stringify([
      "/d",
      "/s",
      "/c",
      `""${commandPath}" "a&b" "x|y""`,
    ]));
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("POSIX execution does not route .cmd files through cmd.exe", {
  skip: process.platform === "win32" ? "the executable fixture is POSIX-only" : false,
}, () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-command-posix-cmd-"));
  try {
    const commandPath = path.join(binDir, "runner.cmd");
    fs.writeFileSync(commandPath, `#!${process.execPath}\nprocess.stdout.write(process.argv[2]);\n`);
    fs.chmodSync(commandPath, 0o755);
    const output = execCommandSync(commandPath, ["direct"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(output, "direct");
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("command execution preserves direct executable behavior", () => {
  const output = execCommandSync(process.execPath, ["-e", "process.stdout.write('ok')"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(output, "ok");
});
