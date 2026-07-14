#!/usr/bin/env node
import { checkRepository, formatHumanResult } from "@cellfence/engine";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

function readInput(name: string, fallback: string | undefined): string | undefined {
  // Stryker disable next-line StringLiteral: current GitHub Action inputs are manifest/baseline/evidence, so separator replacement is unobservable until a non-alphanumeric input name is added.
  const environmentName = `INPUT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const value = process.env[environmentName];
  return value && value.trim().length > 0 ? value : fallback;
}

export function main(): number {
  // Stryker disable next-line StringLiteral: the engine treats an empty manifest path as its default manifest path, so this fallback string is observationally equivalent.
  const manifestPath = readInput("manifest", "cellfence.manifest.json");
  const baselinePath = readInput("baseline", undefined);
  const result = checkRepository({ manifestPath, baselinePath });
  console.log(formatHumanResult(result));
  return result.exitCode;
}

function isDirectActionExecution(): boolean {
  // Stryker disable next-line ConditionalExpression: removing this guard is equivalent because realpathSync(undefined) is caught and returns false below.
  if (!process.argv[1]) return false;
  // Stryker disable BlockStatement: empty catch returns undefined, which is falsy like the explicit false used for non-direct execution.
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
  // Stryker restore BlockStatement
}

if (isDirectActionExecution()) {
  process.exitCode = main();
}
