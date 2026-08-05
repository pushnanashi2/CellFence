import { spawnSync } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";

const packageManagerCommands = new Set(["bun", "npm", "npx", "pnpm", "yarn"]);
const shellCommands = new Set(["bash", "cmd", "cmd.exe", "dash", "fish", "ksh", "powershell", "pwsh", "sh", "zsh"]);

function commandBasename(command) {
  return path.basename(String(command)).toLowerCase().replace(/\.(?:cmd|exe)$/i, "");
}

export function isExactCommit(value) {
  return /^[a-f0-9]{40}$/i.test(String(value || ""));
}

export function installCommandReason(command, args = []) {
  const basename = commandBasename(command);
  if (shellCommands.has(basename)) {
    return `shell command ${basename} is not allowed in the evidence harness`;
  }
  if (packageManagerCommands.has(basename)) return `${basename} may install packages or run target-repository scripts`;
  const normalizedArgs = args.map((argument) => String(argument));
  const loweredArgs = normalizedArgs.map((argument) => argument.toLowerCase());
  if (basename === "env") return "env command indirection is not allowed in the evidence harness";
  if (basename === "busybox" && shellCommands.has(commandBasename(normalizedArgs[0] || ""))) {
    return `busybox shell command ${normalizedArgs[0]} is not allowed in the evidence harness`;
  }
  if (["python", "python3", "py"].includes(basename)) {
    if (normalizedArgs.some((argument) => argument === "-c" || /^-c.+/.test(argument))) {
      return "inline Python execution is not allowed in the evidence harness";
    }
    const moduleIndex = normalizedArgs.indexOf("-m");
    if (moduleIndex >= 0 && ["pip", "pip3", "ensurepip"].includes(loweredArgs[moduleIndex + 1] || "")) {
      return "Python package-manager execution is not allowed in the evidence harness";
    }
  }
  if (["node", "nodejs"].includes(basename) && normalizedArgs.some((argument) => (
    argument === "-e" || argument === "-p" || argument === "--eval" || argument === "--print"
    || /^-(?:e|p).+/.test(argument) || /^--(?:eval|print)=/.test(argument)
  ))) return "inline Node.js execution is not allowed in the evidence harness";
  if (loweredArgs.some((argument) => /(?:^|[\\/])(?:npm|npx|pip|pip3)(?:-cli)?(?:\.[a-z0-9]+)?$/.test(argument))) {
    return "package-manager command indirection is not allowed in the evidence harness";
  }
  return null;
}

export function runEvidenceCommand(command, args, options = {}) {
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.env,
      CI: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
      LC_ALL: "C",
      TZ: "UTC",
    },
    input: options.input,
    maxBuffer: options.maxBuffer || 100 * 1024 * 1024,
    shell: false,
    timeout: options.timeoutMs,
  });
  const errorCode = result.error && typeof result.error === "object" && "code" in result.error
    ? String(result.error.code)
    : undefined;
  const timedOut = errorCode === "ETIMEDOUT";
  return {
    command: [command, ...args].join(" "),
    status: result.status ?? (timedOut ? 124 : 1),
    signal: result.signal || undefined,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? String(result.error.message || result.error) : undefined,
    errorCode,
    timedOut,
    timeoutMs: options.timeoutMs,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

export function summarizeCommandFailure(result) {
  return result.error
    || result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join("\n")
    || result.stdout.trim().split(/\r?\n/).filter(Boolean).slice(-3).join("\n")
    || `exit ${result.status}`;
}

export function classifyExit(result, exitCodes = {}) {
  if (result.timedOut) return "timeout";
  if (result.errorCode === "ENOENT") return "unavailable";
  const groups = [
    ["clean", exitCodes.clean || [0]],
    ["findings", exitCodes.findings || []],
    ["configuration_error", exitCodes.configurationError || []],
  ];
  for (const [classification, codes] of groups) {
    if (codes.includes(result.status)) return classification;
  }
  return "tool_error";
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  const index = Math.max(0, Math.ceil(percentile * values.length) - 1);
  return values[index];
}

export function latencySummary(rawValues) {
  const values = rawValues.filter(Number.isFinite).sort((left, right) => left - right);
  if (values.length === 0) {
    return { count: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null, meanMs: null };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    minMs: values[0],
    p50Ms: nearestRank(values, 0.5),
    p95Ms: nearestRank(values, 0.95),
    maxMs: values.at(-1),
    meanMs: Number((total / values.length).toFixed(3)),
  };
}
