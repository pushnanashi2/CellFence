import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultSummaryPath = path.join(repositoryRoot, "reports/mutation/changed/summary.json");

function formatValue(value) {
  return value === undefined || value === null ? "n/a" : String(value);
}

export function formatMutationStepSummary(summary) {
  const lines = [
    "## CellFence Mutation",
    "",
    `- Result: ${summary.ok ? "passed" : "failed"}`,
    `- Diff: ${summary.baseRef}...${summary.headRef}`,
    `- Changed files: ${summary.changedFiles?.length ?? 0}`,
  ];
  if (summary.reason) lines.push(`- Reason: ${summary.reason}`);
  const executions = summary.executions ?? [];
  if (executions.length === 0) return `${lines.join("\n")}\n`;
  lines.push(
    "",
    "| scope | status | elapsed | score | killed | timeout | survived | no cov | errors | report |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---|",
  );
  for (const execution of executions) {
    const result = execution.result ?? {};
    const errors = (result.runtimeErrors ?? 0) + (result.compileErrors ?? 0);
    lines.push([
      `| ${execution.id}`,
      execution.status,
      `${Math.round((execution.elapsedMs ?? 0) / 1000)}s`,
      formatValue(result.mutationScore),
      formatValue(result.killed),
      formatValue(result.timeout),
      formatValue(result.survived),
      formatValue(result.noCoverage),
      formatValue(errors),
      execution.reportPath ? `\`${execution.reportPath}\`` : "n/a",
    ].join(" | ") + " |");
  }
  return `${lines.join("\n")}\n`;
}

export function formatMissingMutationStepSummary(summaryPath = defaultSummaryPath) {
  return [
    "## CellFence Mutation",
    "",
    "- Result: incomplete",
    `- Summary: \`${path.relative(repositoryRoot, summaryPath)}\` was not produced`,
    "",
  ].join("\n");
}

export function main(args = process.argv.slice(2), environment = process.env) {
  const summaryPath = path.resolve(args[0] ?? defaultSummaryPath);
  const markdown = fs.existsSync(summaryPath)
    ? formatMutationStepSummary(JSON.parse(fs.readFileSync(summaryPath, "utf8")))
    : formatMissingMutationStepSummary(summaryPath);
  if (environment.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(environment.GITHUB_STEP_SUMMARY, markdown);
  } else {
    process.stdout.write(markdown);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
