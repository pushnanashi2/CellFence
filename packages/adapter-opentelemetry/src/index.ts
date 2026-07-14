import {
  CELLFENCE_RESOURCE_EVIDENCE_SCHEMA_VERSION,
  type CellFenceResourceEvidence,
  type ResourceAccessMode,
  type ResourceContractKind,
  type ResourceEvidenceAccess,
} from "@cellfence/schema";

export type OpenTelemetryEvidenceOptions = {
  defaultCellId?: string;
  commitSha?: string;
  generatedAt?: string;
};

type SpanLike = {
  name?: unknown;
  attributes?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAttribute(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (isRecord(value) && typeof value.stringValue === "string" && value.stringValue.trim().length > 0) return value.stringValue;
  return undefined;
}

function normalizeKind(value: string | undefined): ResourceContractKind | undefined {
  if (value === "file" || value === "database" || value === "queue" || value === "http") return value;
  if (value === "db") return "database";
  if (value === "messaging" || value === "queue_topic") return "queue";
  if (value === "rpc") return "http";
  return undefined;
}

function normalizeOperation(kind: ResourceContractKind, value: string | undefined): ResourceAccessMode {
  if (value === "read" || value === "write" || value === "publish" || value === "subscribe" || value === "call" || value === "serve") return value;
  if (kind === "database") return value && /insert|update|delete|write/i.test(value) ? "write" : "read";
  if (kind === "queue") return value && /receive|consume|subscribe/i.test(value) ? "subscribe" : "publish";
  if (kind === "http") return value && /server|serve/i.test(value) ? "serve" : "call";
  return value && /write/i.test(value) ? "write" : "read";
}

function flattenSpans(input: unknown): SpanLike[] {
  if (Array.isArray(input)) return input.flatMap(flattenSpans);
  // Stryker disable all: non-record fallback values are discarded by accessFromSpan, so fake spans are observationally equivalent.
  if (!isRecord(input)) return [];
  // Stryker restore all
  if (Array.isArray(input.spans)) return input.spans.flatMap(flattenSpans);
  if (Array.isArray(input.resourceSpans)) return input.resourceSpans.flatMap(flattenSpans);
  if (Array.isArray(input.scopeSpans)) return input.scopeSpans.flatMap(flattenSpans);
  if (Array.isArray(input.instrumentationLibrarySpans)) return input.instrumentationLibrarySpans.flatMap(flattenSpans);
  // Stryker disable all: plain container objects without span fields produce no access either way.
  if (input.name || input.attributes) return [input as SpanLike];
  return [];
  // Stryker restore all
}

function spanAttributes(span: SpanLike): Record<string, unknown> {
  if (isRecord(span.attributes)) return span.attributes;
  if (Array.isArray(span.attributes)) {
    const attributes: Record<string, unknown> = {};
    for (const item of span.attributes) {
      if (isRecord(item) && typeof item.key === "string" && "value" in item) attributes[item.key] = item.value;
    }
    return attributes;
  }
  return {};
}

function accessFromSpan(span: SpanLike, options: OpenTelemetryEvidenceOptions): ResourceEvidenceAccess | undefined {
  const attributes = spanAttributes(span);
  const kind = normalizeKind(
    stringAttribute(attributes, "cellfence.resource.kind")
    || stringAttribute(attributes, "db.system")
    || stringAttribute(attributes, "messaging.system")
    || stringAttribute(attributes, "rpc.system")
    || stringAttribute(attributes, "http.scheme")
    || stringAttribute(attributes, "url.scheme"),
  );
  const inferredKind = kind
    || (stringAttribute(attributes, "db.name") || stringAttribute(attributes, "db.sql.table") ? "database" : undefined)
    || (stringAttribute(attributes, "messaging.destination.name") ? "queue" : undefined)
    || (stringAttribute(attributes, "http.route") || stringAttribute(attributes, "url.full") ? "http" : undefined);
  if (!inferredKind) return undefined;
  const selector = stringAttribute(attributes, "cellfence.resource.selector")
    || stringAttribute(attributes, "db.sql.table")
    || stringAttribute(attributes, "db.name")
    || stringAttribute(attributes, "messaging.destination.name")
    || stringAttribute(attributes, "messaging.destination")
    || stringAttribute(attributes, "http.route")
    || stringAttribute(attributes, "url.full")
    || String(span.name || "").trim();
  if (!selector) return undefined;
  return {
    kind: inferredKind,
    access: normalizeOperation(inferredKind, stringAttribute(attributes, "cellfence.resource.operation") || stringAttribute(attributes, "db.operation") || stringAttribute(attributes, "messaging.operation") || stringAttribute(attributes, "http.request.method")),
    selector,
    cellId: stringAttribute(attributes, "cellfence.cell") || stringAttribute(attributes, "cell.id") || stringAttribute(attributes, "service.name") || options.defaultCellId,
    observedAt: stringAttribute(attributes, "time") || options.generatedAt,
    detectedBy: "opentelemetry",
    confidence: "runtime",
  };
}

export function openTelemetryToResourceEvidence(input: unknown, options: OpenTelemetryEvidenceOptions = {}): CellFenceResourceEvidence {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const accesses = flattenSpans(input)
    .map((span) => accessFromSpan(span, { ...options, generatedAt }))
    .filter((access): access is ResourceEvidenceAccess => Boolean(access));
  return {
    schemaVersion: CELLFENCE_RESOURCE_EVIDENCE_SCHEMA_VERSION,
    commitSha: options.commitSha,
    generatedAt,
    accesses,
  };
}
