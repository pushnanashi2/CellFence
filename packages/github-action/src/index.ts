#!/usr/bin/env node
import { checkRepository, formatHumanResult } from "@cellfence/engine";

function readInput(name: string, fallback: string | undefined): string | undefined {
  const environmentName = `INPUT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const value = process.env[environmentName];
  return value && value.trim().length > 0 ? value : fallback;
}

export function main(): number {
  const manifestPath = readInput("manifest", "cellfence.manifest.json");
  const baselinePath = readInput("baseline", undefined);
  const result = checkRepository({ manifestPath, baselinePath });
  console.log(formatHumanResult(result));
  return result.exitCode;
}

const exitCode = main();
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = exitCode;
}
