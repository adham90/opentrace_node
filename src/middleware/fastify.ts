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

export interface FastifyRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  id?: string;
  raw: unknown;
}

export interface FastifyReply {
  statusCode: number;
}

type DoneCallback = (err?: Error) => void;

export interface FastifyInstance {
  addHook(name: "onRequest", handler: (req: FastifyRequest, reply: FastifyReply, done: DoneCallback) => void): void;
  addHook(name: "onResponse", handler: (req: FastifyRequest, reply: FastifyReply, done: DoneCallback) => void): void;
}

export function createFastifyPlugin(internals: OpenTraceInternals) {
  function opentracePlugin(fastify: FastifyInstance, _opts: Record<string, unknown>, done: DoneCallback): void {
    const requestTiming = new WeakMap<object, { start: number; store: ReturnType<typeof createRequestContext> }>();

    fastify.addHook("onRequest", (req, _reply, done) => {
      if (!internals.enabled()) return done();

      const cfg = internals.config();
      if (!cfg) return done();

      const urlPath = req.url.split("?")[0];
      if (isIgnoredPath(urlPath, cfg.ignorePaths)) return done();

      if (!internals.sample(req)) {
        internals.recordSampledOut();
        return done();
      }

      const start = performance.now();
      const traceInfo = extractTraceContext(req.headers);
      const requestId = (req.headers["x-request-id"] as string) ?? req.id ?? randomUUID();

      const collector = cfg.requestSummary ? new RequestCollector(start, cfg.timeline, cfg.timelineMaxEvents) : null;

      const store = createRequestContext({
        requestId,
        traceId: traceInfo.traceId,
        spanId: traceInfo.spanId,
        parentSpanId: traceInfo.parentSpanId,
        collector,
      });

      requestTiming.set(req as object, { start, store });

      asyncLocalStorage.enterWith(store);
      done();
    });

    fastify.addHook("onResponse", (req, reply, done) => {
      const timing = requestTiming.get(req as object);
      if (!timing) return done();

      requestTiming.delete(req as object);

      const durationMs = performance.now() - timing.start;
      const { store } = timing;

      const entry: DeferredRequest = {
        kind: "request",
        started: Date.now() - durationMs,
        finished: Date.now(),
        method: req.method,
        path: req.url.split("?")[0],
        status: reply.statusCode,
        controller: null,
        action: null,
        requestId: store.requestId,
        traceId: store.traceId,
        spanId: store.spanId,
        parentSpanId: store.parentSpanId,
        context: store.cachedContext,
        summary: store.collector?.summary() ?? null,
        error: null,
        extra: {},
      };

      internals.enqueue(entry);
      done();
    });

    done();
  }

  // Fastify expects plugin metadata
  Object.defineProperty(opentracePlugin, Symbol.for("fastify.display-name"), {
    value: "opentrace",
  });

  return opentracePlugin;
}
