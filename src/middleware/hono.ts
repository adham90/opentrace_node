import { randomUUID } from "node:crypto";
import { asyncLocalStorage, createRequestContext } from "../context.js";
import { RequestCollector } from "../request-collector.js";
import { extractTraceContext } from "../trace-context.js";
import type { DeferredRequest } from "../types.js";
import { isIgnoredPath } from "./common.js";

export interface OpenTraceInternals {
  enabled(): boolean;
  config(): {
    ignorePaths: string[];
    requestSummary: boolean;
    timeline: boolean;
    timelineMaxEvents: number;
  } | null;
  enqueue(entry: DeferredRequest): void;
  sample(req?: unknown): boolean;
  recordSampledOut(): void;
}

export interface HonoContext {
  req: {
    method: string;
    path: string;
    header(name: string): string | undefined;
    raw: Request;
  };
  res: { status: number };
  get status(): number;
}

type HonoNext = () => Promise<void>;
// biome-ignore lint/suspicious/noConfusingVoidType: Hono middleware can return void or Response
type HonoMiddleware = (c: HonoContext, next: HonoNext) => Promise<void | Response>;

export function createHonoMiddleware(internals: OpenTraceInternals): HonoMiddleware {
  // biome-ignore lint/suspicious/noConfusingVoidType: Hono middleware can return void or Response
  return async function opentraceMiddleware(c: HonoContext, next: HonoNext): Promise<void | Response> {
    if (!internals.enabled()) return next();

    const cfg = internals.config();
    if (!cfg) return next();

    const path = c.req.path;
    if (isIgnoredPath(path, cfg.ignorePaths)) return next();

    if (!internals.sample()) {
      internals.recordSampledOut();
      return next();
    }

    const start = performance.now();
    const headers: Record<string, string | undefined> = {
      traceparent: c.req.header("traceparent"),
      "x-trace-id": c.req.header("x-trace-id"),
      "x-request-id": c.req.header("x-request-id"),
    };
    const traceInfo = extractTraceContext(headers);
    const requestId = c.req.header("x-request-id") ?? randomUUID();

    const collector = cfg.requestSummary ? new RequestCollector(start, cfg.timeline, cfg.timelineMaxEvents) : null;

    const store = createRequestContext({
      requestId,
      traceId: traceInfo.traceId,
      spanId: traceInfo.spanId,
      parentSpanId: traceInfo.parentSpanId,
      collector,
    });

    return asyncLocalStorage.run(store, async () => {
      await next();

      const durationMs = performance.now() - start;

      const entry: DeferredRequest = {
        kind: "request",
        started: Date.now() - durationMs,
        finished: Date.now(),
        method: c.req.method,
        path,
        status: c.status,
        controller: null,
        action: null,
        requestId: store.requestId,
        traceId: store.traceId,
        spanId: store.spanId,
        parentSpanId: store.parentSpanId,
        context: store.cachedContext,
        summary: collector?.summary() ?? null,
        error: null,
        extra: {},
      };

      internals.enqueue(entry);
    });
  };
}
