import type { ResolvedConfig } from "./config.js";
import type { DeferredEntry, DeferredRequest, Payload } from "./types.js";

export function materialize(entry: DeferredEntry, config: ResolvedConfig): Payload {
  switch (entry.kind) {
    case "log":
      return materializeLog(entry, config);
    case "error":
      return materializeError(entry, config);
    case "event":
      return materializeEvent(entry, config);
    case "request":
      return materializeRequest(entry, config);
  }
}

function materializeLog(entry: DeferredEntry & { kind: "log" }, config: ResolvedConfig): Payload {
  const metadata = mergeContext(entry.metadata, entry.context, config);
  const payload = buildBase(entry.ts, entry.level.toUpperCase(), entry.message, metadata, config);
  assignTraceFields(payload, entry);
  return payload;
}

function materializeError(entry: DeferredEntry & { kind: "error" }, config: ResolvedConfig): Payload {
  const metadata = mergeContext(entry.metadata, entry.context, config);
  if (entry.stack) metadata.stack_trace = entry.stack;
  if (entry.causes.length > 0) metadata.exception_causes = entry.causes;

  const payload = buildBase(entry.ts, "ERROR", entry.message, metadata, config);
  payload.exception_class = entry.exceptionClass;
  payload.error_fingerprint = entry.fingerprint;
  assignTraceFields(payload, entry);
  return payload;
}

function materializeEvent(entry: DeferredEntry & { kind: "event" }, config: ResolvedConfig): Payload {
  const metadata = mergeContext(entry.metadata, entry.context, config);
  const payload = buildBase(entry.ts, "INFO", entry.message, metadata, config);
  payload.event_type = entry.eventType;
  assignTraceFields(payload, entry);
  return payload;
}

function materializeRequest(entry: DeferredRequest, config: ResolvedConfig): Payload {
  const durationMs = entry.finished - entry.started;
  const level = requestLevel(entry.status, entry.error);
  const message = `${entry.method} ${entry.path} ${entry.status} ${Math.round(durationMs)}ms`;

  const metadata: Record<string, unknown> = {
    ...entry.extra,
    method: entry.method,
    path: entry.path,
    status: entry.status,
    duration_ms: Math.round(durationMs * 100) / 100,
  };
  if (entry.controller) metadata.controller = entry.controller;
  if (entry.action) metadata.action = entry.action;

  const merged = mergeContext(metadata, entry.context, config);
  const payload = buildBase(entry.started, level, message, merged, config);

  if (entry.summary) {
    payload.request_summary = entry.summary;
  }

  if (entry.error) {
    payload.exception_class = entry.error.className;
    payload.error_fingerprint = entry.error.fingerprint;
    merged.stack_trace = entry.error.stack;
  }

  assignTraceFields(payload, entry);
  return payload;
}

function buildBase(
  ts: number,
  level: string,
  message: string,
  metadata: Record<string, unknown>,
  config: ResolvedConfig,
): Payload {
  metadata.hostname = config.hostname;
  metadata.pid = config.pid;

  const payload: Payload = {
    timestamp: new Date(ts).toISOString(),
    level,
    service: config.service,
    message,
    metadata,
  };

  if (config.environment) payload.environment = config.environment;
  if (config.gitSha) payload.commit_hash = config.gitSha;

  return payload;
}

function mergeContext(
  metadata: Record<string, unknown>,
  context: Record<string, unknown> | null,
  config: ResolvedConfig,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Static context from config
  if (config.context) {
    const ctx = typeof config.context === "function" ? safeCall(config.context) : config.context;
    if (ctx) Object.assign(result, ctx);
  }

  // Per-request context
  if (context) Object.assign(result, context);

  // Entry metadata (highest priority)
  Object.assign(result, metadata);

  return result;
}

function assignTraceFields(
  payload: Payload,
  entry: { requestId: string | null; traceId: string | null; spanId: string | null; parentSpanId: string | null },
): void {
  if (entry.requestId) payload.request_id = entry.requestId;
  if (entry.traceId) payload.trace_id = entry.traceId;
  if (entry.spanId) payload.span_id = entry.spanId;
  if (entry.parentSpanId) payload.parent_span_id = entry.parentSpanId;
}

function requestLevel(status: number, error: unknown): string {
  if (error) return "ERROR";
  if (status >= 500) return "ERROR";
  if (status >= 400) return "WARN";
  return "INFO";
}

function safeCall<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

const MAX_PAYLOAD_TRUNCATION_STEPS = 6;

export function fitPayload(payload: Payload, maxBytes: number): Payload | null {
  if (jsonSize(payload) <= maxBytes) return payload;

  const p = { ...payload, metadata: { ...payload.metadata } };

  const steps: (() => void)[] = [
    () => {
      p.metadata.stack_trace = undefined;
    },
    () => {
      p.metadata.params = undefined;
    },
    () => {
      p.metadata.job_arguments = undefined;
    },
    () => {
      if (typeof p.metadata.sql === "string") p.metadata.sql = p.metadata.sql.slice(0, 200);
    },
    () => {
      if (typeof p.metadata.exception_message === "string")
        p.metadata.exception_message = p.metadata.exception_message.slice(0, 200);
    },
    () => {
      if (p.request_summary) {
        p.request_summary = { ...p.request_summary };
        p.request_summary.timeline = undefined;
      }
    },
  ];

  for (let i = 0; i < MAX_PAYLOAD_TRUNCATION_STEPS; i++) {
    steps[i]();
    if (jsonSize(p) <= maxBytes) return p;
  }

  // Still too large — drop
  return null;
}

function jsonSize(obj: unknown): number {
  return Buffer.byteLength(JSON.stringify(obj), "utf8");
}
