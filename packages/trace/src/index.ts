import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  CELLFENCE_RESOURCE_EVIDENCE_SCHEMA_VERSION,
  type ResourceEvidenceAccess,
} from "@cellfence/schema";

type TraceAccessInput = Omit<ResourceEvidenceAccess, "detectedBy" | "confidence"> & {
  detectedBy?: string;
  confidence?: "runtime";
};

const originalReadFileSync = fs.readFileSync.bind(fs);
const originalWriteFileSync = fs.writeFileSync.bind(fs);
const originalAppendFileSync = fs.appendFileSync.bind(fs);
const originalReadFile = fs.promises.readFile.bind(fs.promises);
const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
const originalAppendFile = fs.promises.appendFile.bind(fs.promises);
const accesses = new Map<string, ResourceEvidenceAccess>();
const SOURCE_FILE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".mts", ".cts"]);
let installed = false;
let flushed = false;

function normalizeSelector(selector: fs.PathOrFileDescriptor): string | undefined {
  if (typeof selector === "number") return undefined;
  const text = selector instanceof URL ? selector.pathname : selector.toString();
  return text.split(path.sep).join("/");
}

function defaultCellId(): string | undefined {
  return process.env.CELLFENCE_TRACE_CELL || process.env.CELLFENCE_CELL_ID;
}

function evidencePath(): string {
  return path.resolve(process.cwd(), process.env.CELLFENCE_TRACE_OUT || "cellfence.resource-evidence.json");
}

function accessKey(access: ResourceEvidenceAccess): string {
  return `${access.cellId || ""}:${access.kind}:${access.access}:${access.selector}`;
}

export function recordResourceAccess(access: TraceAccessInput): void {
  const resolvedAccess: ResourceEvidenceAccess = {
    ...access,
    cellId: access.cellId || defaultCellId(),
    detectedBy: access.detectedBy || "cellfence-trace",
    confidence: access.confidence || "runtime",
  };
  accesses.set(accessKey(resolvedAccess), resolvedAccess);
}

function recordFileAccess(access: "read" | "write", selector: fs.PathOrFileDescriptor): void {
  const normalizedSelector = normalizeSelector(selector);
  if (!normalizedSelector) return;
  if (SOURCE_FILE_EXTENSIONS.has(path.extname(normalizedSelector))) return;
  if (path.resolve(process.cwd(), normalizedSelector) === evidencePath()) return;
  recordResourceAccess({
    kind: "file",
    access,
    selector: normalizedSelector,
  });
}

export function flushEvidence(): void {
  if (flushed || accesses.size === 0) return;
  flushed = true;
  const outputPath = evidencePath();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const evidence = {
    schemaVersion: CELLFENCE_RESOURCE_EVIDENCE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    commitSha: process.env.GITHUB_SHA || process.env.CELLFENCE_TRACE_COMMIT_SHA,
    cellId: defaultCellId(),
    accesses: [...accesses.values()].sort((left, right) => accessKey(left).localeCompare(accessKey(right))),
  };
  originalWriteFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

export function installTrace(): void {
  if (installed || process.env.CELLFENCE_TRACE_DISABLE === "1") return;
  installed = true;

  fs.readFileSync = ((selector: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    recordFileAccess("read", selector);
    return originalReadFileSync(selector, ...args as [options?: BufferEncoding | { encoding?: BufferEncoding | null; flag?: string } | null]);
  }) as typeof fs.readFileSync;

  fs.writeFileSync = ((selector: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, ...args: unknown[]) => {
    recordFileAccess("write", selector);
    return originalWriteFileSync(selector, data, ...args as [options?: fs.WriteFileOptions]);
  }) as typeof fs.writeFileSync;

  fs.appendFileSync = ((selector: fs.PathOrFileDescriptor, data: string | Uint8Array, ...args: unknown[]) => {
    recordFileAccess("write", selector);
    return originalAppendFileSync(selector, data, ...args as [options?: fs.WriteFileOptions]);
  }) as typeof fs.appendFileSync;

  fs.promises.readFile = (async (selector: fs.PathLike | FileHandle, ...args: unknown[]) => {
    if (!(typeof selector === "object" && "fd" in selector)) recordFileAccess("read", selector as fs.PathLike);
    return originalReadFile(selector as Parameters<typeof fs.promises.readFile>[0], ...args as [options?: Parameters<typeof fs.promises.readFile>[1]]);
  }) as typeof fs.promises.readFile;

  fs.promises.writeFile = (async (selector: fs.PathLike | FileHandle, data: string | NodeJS.ArrayBufferView | Iterable<string | NodeJS.ArrayBufferView> | AsyncIterable<string | NodeJS.ArrayBufferView>, ...args: unknown[]) => {
    if (!(typeof selector === "object" && "fd" in selector)) recordFileAccess("write", selector as fs.PathLike);
    return originalWriteFile(selector as Parameters<typeof fs.promises.writeFile>[0], data, ...args as [options?: Parameters<typeof fs.promises.writeFile>[2]]);
  }) as typeof fs.promises.writeFile;

  fs.promises.appendFile = (async (selector: fs.PathLike | FileHandle, data: string | Uint8Array, ...args: unknown[]) => {
    if (!(typeof selector === "object" && "fd" in selector)) recordFileAccess("write", selector as fs.PathLike);
    return originalAppendFile(selector as Parameters<typeof fs.promises.appendFile>[0], data, ...args as [options?: Parameters<typeof fs.promises.appendFile>[2]]);
  }) as typeof fs.promises.appendFile;

  process.once("beforeExit", flushEvidence);
  process.once("exit", flushEvidence);
}

installTrace();
