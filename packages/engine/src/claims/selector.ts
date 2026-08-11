// 0.4.0: claim backend selector. The 0.3.0 prototype shipped the
// `ClaimStoreBackend` interface and two reference implementations
// behind it. The full 0.4.0 selector reads `governance.claimBackend`
// from the manifest and returns the matching backend. The full
// migration of `packages/engine/src/claims.ts` to call through this
// interface is queued for a follow-up so this commit stays scoped
// to "you can configure which backend your repo uses"; the
// existing JSON-file behaviour is still the default until that
// migration lands.

import path from "node:path";

import type { CellFenceManifest } from "@cellfence/schema";

import {
  type ClaimStoreBackend,
  type ClaimStoreState,
} from "./backend.js";
import { LocalFileClaimStore } from "./backends/local-file.js";
import { GitHubArtifactClaimStore } from "./backends/github-artifact.js";

export type ClaimBackendType = "local-file" | "github-artifact";

export type ResolvedClaimBackend = {
  type: ClaimBackendType;
  backend: ClaimStoreBackend;
  /** Source location the resolver found the configuration in. */
  source: "manifest" | "default" | "env";
};

export type ResolveOptions = {
  rootDir: string;
  /** Path to the JSON file the legacy code path uses. */
  defaultFilePath: string;
  manifest?: CellFenceManifest;
  /** Optional env-var override (used by CI runners). */
  envType?: string;
};

function manifestType(manifest: CellFenceManifest | undefined): string | undefined {
  const backend = manifest?.governance && (manifest.governance as Record<string, unknown>)["claimBackend"];
  if (!backend || typeof backend !== "object") return undefined;
  const type = (backend as Record<string, unknown>)["type"];
  return typeof type === "string" ? type : undefined;
}

export function resolveClaimBackend(options: ResolveOptions): ResolvedClaimBackend {
  const fromEnv = options.envType ?? process.env.CELLFENCE_CLAIM_BACKEND;
  const fromManifest = manifestType(options.manifest);
  const type = (fromEnv || fromManifest || "local-file") as ClaimBackendType;
  switch (type) {
    case "github-artifact": {
      const manifestBackend = (options.manifest?.governance as Record<string, unknown> | undefined)?.["claimBackend"] as
        | Record<string, unknown>
        | undefined;
      const artifactName = (manifestBackend?.["artifactName"] as string | undefined) ?? "cellfence-claims";
      const retentionDays = (manifestBackend?.["retentionDays"] as number | undefined) ?? 1;
      return {
        type: "github-artifact",
        backend: new GitHubArtifactClaimStore({
          artifactName,
          retentionDays,
        }),
        source: fromEnv ? "env" : fromManifest ? "manifest" : "default",
      };
    }
    case "local-file":
    default:
      return {
        type: "local-file",
        backend: new LocalFileClaimStore({ filePath: options.defaultFilePath }),
        source: fromEnv ? "env" : fromManifest ? "manifest" : "default",
      };
  }
}

export type { ClaimStoreBackend, ClaimStoreState };
