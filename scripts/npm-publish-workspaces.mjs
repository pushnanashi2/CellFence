import { fileURLToPath } from "node:url";
import { publicWorkspaceDirs } from "./public-workspaces.mjs";

const heldOutRegistryWorkspaces = new Set([
  "packages/mcp-proxy",
]);

export function npmPublishWorkspaceDirs(rootDir = process.cwd()) {
  return publicWorkspaceDirs(rootDir).filter((workspaceDir) => !heldOutRegistryWorkspaces.has(workspaceDir));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dirs = npmPublishWorkspaceDirs();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(dirs, null, 2)}\n`);
  } else {
    process.stdout.write(`${dirs.join("\n")}\n`);
  }
}
