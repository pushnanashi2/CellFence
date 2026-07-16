import crypto from "node:crypto";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stableCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableCanonicalJson(item)).join(",")}]`;
  if (isJsonObject(value)) {
    const entries = Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableCanonicalJson(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function stableDigest(value: unknown): string {
  return sha256Hex(stableCanonicalJson(value));
}
