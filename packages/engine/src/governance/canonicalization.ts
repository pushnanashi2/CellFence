import crypto from "node:crypto";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function stableStringCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function stableCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableCanonicalJson(item)).join(",")}]`;
  if (isJsonObject(value)) {
    const entries = Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => stableStringCompare(left, right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableCanonicalJson(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  if (typeof value === "object") {
    throw new Error(`stableCanonicalJson only accepts JSON plain objects, arrays, and scalar values`);
  }
  return JSON.stringify(value);
}

export function sha256Hex(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function stableDigest(value: unknown): string {
  return sha256Hex(stableCanonicalJson(value));
}
