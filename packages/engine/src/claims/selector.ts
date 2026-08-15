// 0.4.0: claim backend selector. The 0.3.0 prototype shipped the
// `ClaimStoreBackend` interface and reference implementations behind
// it. Only synchronous backends may be exposed through manifest
// configuration while the public claim commands remain synchronous.

import type { CellFenceManifest } from "@cellfence/schema";

import {
  type ClaimStoreBackend,
} from "./backend.js";
import { LocalFileClaimStore } from "./backends/local-file.js";

export type ClaimBackendType = "local-file";

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
    case "local-file":
      return {
        type: "local-file",
        backend: new LocalFileClaimStore({ filePath: options.defaultFilePath }),
        source: fromEnv ? "env" : fromManifest ? "manifest" : "default",
      };
    default:
      throw new Error(`unsupported claim backend ${type}; only local-file is available`);
  }
}

export type { ClaimStoreBackend };
