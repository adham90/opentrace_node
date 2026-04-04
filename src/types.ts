export interface DeferredLog {
  kind: "log";
  ts: number;
  level: string;
  message: string;
  metadata: Record<string, unknown>;
  context: Record<string, unknown> | null;
  requestId: string | null;
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
}

export interface DeferredError {
  kind: "error";
  ts: number;
  message: string;
  exceptionClass: string;
  stack: string;
  fingerprint: string;
  causes: ErrorCause[];
  metadata: Record<string, unknown>;
  context: Record<string, unknown> | null;
  requestId: string | null;
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
}

export interface ErrorCause {
  className: string;
  message: string;
  stack: string;
}

export interface DeferredEvent {
  kind: "event";
  ts: number;
  eventType: string;
  message: string;
  metadata: Record<string, unknown>;
  context: Record<string, unknown> | null;
  requestId: string | null;
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
}

export interface RequestSummary {
  sqlQueryCount: number;
  sqlTotalMs: number;
  sqlSlowestMs: number;
  sqlSlowestName: string;
  nPlusOneWarning: boolean;
  duplicateQueries: number;
  worstDuplicateCount: number;
  httpCount: number;
  httpTotalMs: number;
  httpSlowestMs: number;
  httpSlowestHost: string;
  timeline?: TimelineEvent[];
}

export interface TimelineEvent {
  t: string;
  n: string;
  ms: number;
  at: number;
  s?: number;
  hit?: boolean;
  a?: string;
}

export interface DeferredRequest {
  kind: "request";
  started: number;
  finished: number;
  method: string;
  path: string;
  status: number;
  controller: string | null;
  action: string | null;
  requestId: string | null;
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  context: Record<string, unknown> | null;
  summary: RequestSummary | null;
  error: { message: string; className: string; stack: string; fingerprint: string } | null;
  extra: Record<string, unknown>;
}

export type DeferredEntry = DeferredLog | DeferredError | DeferredEvent | DeferredRequest;

export interface Payload {
  ts: string;
  level: string;
  service: string;
  env?: string;
  version?: string;
  message: string;

  // Trace & identity
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  request_id?: string;
  user_id?: string;
  tenant_id?: string;
  session_id?: string;

  // Classification
  event_type?: string;
  exception_class?: string;
  error_fingerprint?: string;

  // Flat request fields
  method?: string;
  path?: string;
  status?: number;
  duration_ms?: number;
  controller?: string;
  action?: string;

  // Flat DB summary fields
  db_ms?: number;
  db_count?: number;
  n_plus_one?: boolean;
  slow_queries?: number;
  dup_queries?: number;

  // Structured body bucket
  body?: Record<string, unknown>;
}
