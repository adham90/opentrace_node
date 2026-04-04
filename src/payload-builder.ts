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
  const merged = mergeContext(entry.metadata, entry.context, config);

  // Promote known identity fields from metadata to top-level
  const { user_id, tenant_id, session_id, ...rest } = merged;

  const payload = buildBase(entry.ts, entry.level.toLowerCase(), entry.message, config);
  if (user_id !== undefined) payload.user_id = String(user_id);
  if (tenant_id !== undefined) payload.tenant_id = String(tenant_id);
  if (session_id !== undefined) payload.session_id = String(session_id);
  if (entry.requestId) payload.request_id = entry.requestId;
  if (entry.traceId) payload.trace_id = entry.traceId;
  if (entry.spanId) payload.span_id = entry.spanId;
  if (entry.parentSpanId) payload.parent_span_id = entry.parentSpanId;

  // Everything else goes into body.context
  if (Object.keys(rest).length > 0) {
    payload.body = { context: rest };
  }

  return payload;
}

function materializeError(entry: DeferredEntry & { kind: "error" }, config: ResolvedConfig): Payload {
  const merged = mergeContext(entry.metadata, entry.context, config);
  const { user_id, tenant_id, session_id, ...rest } = merged;

  const payload = buildBase(entry.ts, "error", entry.message, config);
  payload.exception_class = entry.exceptionClass;
  if (entry.fingerprint) payload.error_fingerprint = entry.fingerprint;
  if (user_id !== undefined) payload.user_id = String(user_id);
  if (tenant_id !== undefined) payload.tenant_id = String(tenant_id);
  if (session_id !== undefined) payload.session_id = String(session_id);
  if (entry.requestId) payload.request_id = entry.requestId;
  if (entry.traceId) payload.trace_id = entry.traceId;
  if (entry.spanId) payload.span_id = entry.spanId;
  if (entry.parentSpanId) payload.parent_span_id = entry.parentSpanId;

  const body: Record<string, unknown> = {};
  const exception: Record<string, unknown> = { class: entry.exceptionClass };
  if (entry.stack) exception.stack = entry.stack;
  if (entry.causes.length > 0) exception.causes = entry.causes;
  body.exception = exception;

  if (Object.keys(rest).length > 0) {
    body.context = rest;
  }

  payload.body = body;
  return payload;
}

function materializeEvent(entry: DeferredEntry & { kind: "event" }, config: ResolvedConfig): Payload {
  const merged = mergeContext(entry.metadata, entry.context, config);
  const { user_id, tenant_id, session_id, ...rest } = merged;

  const payload = buildBase(entry.ts, "info", entry.message, config);
  payload.event_type = entry.eventType;
  if (user_id !== undefined) payload.user_id = String(user_id);
  if (tenant_id !== undefined) payload.tenant_id = String(tenant_id);
  if (session_id !== undefined) payload.session_id = String(session_id);
  if (entry.requestId) payload.request_id = entry.requestId;
  if (entry.traceId) payload.trace_id = entry.traceId;
  if (entry.spanId) payload.span_id = entry.spanId;
  if (entry.parentSpanId) payload.parent_span_id = entry.parentSpanId;

  if (Object.keys(rest).length > 0) {
    payload.body = { context: rest };
  }

  return payload;
}

function materializeRequest(entry: DeferredRequest, config: ResolvedConfig): Payload {
  const durationMs = entry.finished - entry.started;
  const level = requestLevel(entry.status, entry.error);
  const message = `${entry.method} ${entry.path} ${entry.status} ${Math.round(durationMs)}ms`;

  const payload = buildBase(entry.started, level, message, config);
  payload.event_type = "http.request";

  // Flat request fields
  payload.method = entry.method;
  payload.path = entry.path;
  payload.status = entry.status;
  payload.duration_ms = Math.round(durationMs * 100) / 100;
  if (entry.controller) payload.controller = entry.controller;
  if (entry.action) payload.action = entry.action;

  // Trace fields
  if (entry.requestId) payload.request_id = entry.requestId;
  if (entry.traceId) payload.trace_id = entry.traceId;
  if (entry.spanId) payload.span_id = entry.spanId;
  if (entry.parentSpanId) payload.parent_span_id = entry.parentSpanId;

  // Flat DB summary fields from request summary
  if (entry.summary) {
    payload.db_ms = entry.summary.sqlTotalMs;
    payload.db_count = entry.summary.sqlQueryCount;
    payload.n_plus_one = entry.summary.nPlusOneWarning;
    payload.dup_queries = entry.summary.duplicateQueries;
    // slow_queries: count queries slower than a reasonable threshold (>100ms)
    payload.slow_queries = entry.summary.sqlSlowestMs > 100 ? 1 : 0;
  }

  // Merge context and extra, promote identity fields
  const merged = mergeContext(entry.extra, entry.context, config);
  const { user_id, tenant_id, session_id, ...rest } = merged;
  if (user_id !== undefined) payload.user_id = String(user_id);
  if (tenant_id !== undefined) payload.tenant_id = String(tenant_id);
  if (session_id !== undefined) payload.session_id = String(session_id);

  // Build body with structured sub-objects
  const body: Record<string, unknown> = {};

  if (Object.keys(rest).length > 0) {
    body.context = rest;
  }

  if (entry.summary) {
    body.performance = {
      sql_query_count: entry.summary.sqlQueryCount,
      sql_total_ms: entry.summary.sqlTotalMs,
      sql_slowest_ms: entry.summary.sqlSlowestMs,
      sql_slowest_name: entry.summary.sqlSlowestName,
      n_plus_one_warning: entry.summary.nPlusOneWarning,
      duplicate_queries: entry.summary.duplicateQueries,
      worst_duplicate_count: entry.summary.worstDuplicateCount,
      http_count: entry.summary.httpCount,
      http_total_ms: entry.summary.httpTotalMs,
      http_slowest_ms: entry.summary.httpSlowestMs,
      http_slowest_host: entry.summary.httpSlowestHost,
    };
    if (entry.summary.timeline) {
      body.timeline = entry.summary.timeline;
    }
  }

  if (entry.error) {
    payload.exception_class = entry.error.className;
    body.exception = {
      class: entry.error.className,
      message: entry.error.message,
      stack: entry.error.stack,
      fingerprint: entry.error.fingerprint,
    };
  }

  if (Object.keys(body).length > 0) {
    payload.body = body;
  }

  return payload;
}

function buildBase(
  ts: number,
  level: string,
  message: string,
  config: ResolvedConfig,
): Payload {
  const payload: Payload = {
    ts: new Date(ts).toISOString(),
    level,
    service: config.service,
    message,
  };

  if (config.environment) payload.env = config.environment;
  if (config.gitSha) payload.version = config.gitSha;

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

  // Always include hostname and pid
  result.hostname = config.hostname;
  result.pid = config.pid;

  return result;
}

function requestLevel(status: number, error: unknown): string {
  if (error) return "error";
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
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

  const p = { ...payload, body: payload.body ? { ...payload.body } : undefined };

  const steps: (() => void)[] = [
    () => {
      if (p.body?.exception && typeof p.body.exception === "object") {
        const ex = p.body.exception as Record<string, unknown>;
        ex.stack = undefined;
      }
    },
    () => {
      if (p.body?.context && typeof p.body.context === "object") {
        const ctx = p.body.context as Record<string, unknown>;
        ctx.params = undefined;
      }
    },
    () => {
      if (p.body?.context && typeof p.body.context === "object") {
        const ctx = p.body.context as Record<string, unknown>;
        ctx.job_arguments = undefined;
      }
    },
    () => {
      if (p.body?.context && typeof p.body.context === "object") {
        const ctx = p.body.context as Record<string, unknown>;
        if (typeof ctx.sql === "string") ctx.sql = ctx.sql.slice(0, 200);
      }
    },
    () => {
      if (p.body?.exception && typeof p.body.exception === "object") {
        const ex = p.body.exception as Record<string, unknown>;
        if (typeof ex.message === "string") ex.message = ex.message.slice(0, 200);
      }
    },
    () => {
      if (p.body) {
        p.body.timeline = undefined;
      }
    },
  ];

  for (let i = 0; i < MAX_PAYLOAD_TRUNCATION_STEPS; i++) {
    steps[i]();
    if (jsonSize(p) <= maxBytes) return p;
  }

  // Still too large -- drop
  return null;
}

function jsonSize(obj: unknown): number {
  return Buffer.byteLength(JSON.stringify(obj), "utf8");
}
