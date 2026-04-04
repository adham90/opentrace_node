import { Client } from "./client.js";
import {
  type OpenTraceConfig,
  type ResolvedConfig,
  clearLevelCache,
  isLevelEnabled,
  resolveConfig,
  validateConfig,
} from "./config.js";
import { getContext } from "./context.js";
import { type OpenTraceInternals, createExpressMiddleware } from "./middleware/express.js";
import { createFastifyPlugin } from "./middleware/fastify.js";
import { createHonoMiddleware } from "./middleware/hono.js";
import type { StatsSnapshot } from "./stats.js";
import { generateSpanId } from "./trace-context.js";
import type { DeferredEntry, DeferredError, DeferredEvent, DeferredLog, ErrorCause } from "./types.js";

export type { OpenTraceConfig } from "./config.js";
export type { LogLevel } from "./config.js";
export type { Payload, DeferredEntry, RequestSummary } from "./types.js";
export type { StatsSnapshot } from "./stats.js";
export { getContext } from "./context.js";
export { RequestCollector } from "./request-collector.js";

let initialized = false;
let config: ResolvedConfig | null = null;
let client: Client | null = null;
let enabled = true;
let globalContext: Record<string, unknown> = {};
let beforeExitHandler: (() => void) | null = null;

function debugLog(...args: unknown[]): void {
  if (config?.debug) {
    console.debug("[OpenTrace]", ...args);
  }
}

function getInternals(): OpenTraceInternals {
  return {
    enabled: () => initialized && enabled,
    config: () =>
      config
        ? {
            ignorePaths: config.ignorePaths,
            requestSummary: config.requestSummary,
            timeline: config.timeline,
            timelineMaxEvents: config.timelineMaxEvents,
          }
        : null,
    enqueue: (entry) => client?.enqueue(entry),
    sample: (req) => client?.sampler.sample(req) ?? false,
    recordSampledOut: () => {
      if (client) client.stats.sampledOut++;
    },
  };
}

const OpenTrace = {
  init(options: OpenTraceConfig): void {
    if (initialized) {
      debugLog("Already initialized, ignoring duplicate init()");
      return;
    }

    const error = validateConfig(options);
    if (error) {
      debugLog(`Configuration error: ${error}, OpenTrace disabled`);
      return;
    }

    config = resolveConfig(options);
    client = new Client(config);
    client.start();
    initialized = true;
    enabled = true;

    beforeExitHandler = () => {
      client?.flush();
    };
    process.on("beforeExit", beforeExitHandler);

    debugLog("Initialized", { endpoint: config.endpoint, service: config.service });
  },

  async shutdown(timeoutMs = 5000): Promise<void> {
    if (!initialized || !client) return;
    if (beforeExitHandler) {
      process.removeListener("beforeExit", beforeExitHandler);
      beforeExitHandler = null;
    }
    await client.shutdown(timeoutMs);
    initialized = false;
    config = null;
    client = null;
    enabled = true;
    globalContext = {};
    clearLevelCache();
    debugLog("Shut down");
  },

  enabled(): boolean {
    return initialized && enabled;
  },

  enable(): void {
    enabled = true;
  },

  disable(): void {
    enabled = false;
  },

  log(level: string, message: string, metadata: Record<string, unknown> = {}): void {
    try {
      if (!initialized || !enabled || !config || !client) return;
      if (!isLevelEnabled(level, config)) return;

      const ctx = getContext();
      const entry: DeferredLog = {
        kind: "log",
        ts: Date.now(),
        level,
        message,
        metadata,
        context: resolveContext(),
        requestId: ctx?.requestId ?? null,
        traceId: ctx?.traceId ?? null,
        spanId: ctx?.spanId ?? null,
        parentSpanId: ctx?.parentSpanId ?? null,
      };

      client.enqueue(entry);
    } catch {
      // Never throw
    }
  },

  debug(message: string, metadata: Record<string, unknown> = {}): void {
    this.log("debug", message, metadata);
  },

  info(message: string, metadata: Record<string, unknown> = {}): void {
    this.log("info", message, metadata);
  },

  warn(message: string, metadata: Record<string, unknown> = {}): void {
    this.log("warn", message, metadata);
  },

  error(err: Error | string, metadata: Record<string, unknown> = {}): void {
    try {
      if (!initialized || !enabled || !config || !client) return;

      const isError = err instanceof Error;
      const message = isError ? err.message : String(err);
      const errorClass = isError ? err.name : "Error";
      const stack = isError ? cleanStack(err.stack ?? "") : "";
      const causes = isError ? walkCauses(err) : [];

      const ctx = getContext();
      const entry: DeferredError = {
        kind: "error",
        ts: Date.now(),
        message,
        errorClass,
        stack,
        fingerprint: "", // server computes fingerprint
        causes,
        metadata,
        context: resolveContext(),
        requestId: ctx?.requestId ?? null,
        traceId: ctx?.traceId ?? null,
        spanId: ctx?.spanId ?? null,
        parentSpanId: ctx?.parentSpanId ?? null,
      };

      client.enqueue(entry);
    } catch {
      // Never throw
    }
  },

  event(eventType: string, message: string, metadata: Record<string, unknown> = {}): void {
    try {
      if (!initialized || !enabled || !config || !client) return;

      const ctx = getContext();
      const entry: DeferredEvent = {
        kind: "event",
        ts: Date.now(),
        eventType,
        message,
        metadata,
        context: resolveContext(),
        requestId: ctx?.requestId ?? null,
        traceId: ctx?.traceId ?? null,
        spanId: ctx?.spanId ?? null,
        parentSpanId: ctx?.parentSpanId ?? null,
      };

      client.enqueue(entry);
    } catch {
      // Never throw
    }
  },

  trace<T>(operation: string, fn: () => T): T {
    const ctx = getContext();
    const parentSpanId = ctx?.spanId ?? null;
    const spanId = generateSpanId();
    const start = performance.now();

    if (ctx) ctx.spanId = spanId;

    try {
      const result = fn();

      // Handle async functions
      if (result instanceof Promise) {
        return result.then(
          (val) => {
            finishSpan(operation, start, ctx, parentSpanId);
            return val;
          },
          (err) => {
            finishSpan(operation, start, ctx, parentSpanId);
            throw err;
          },
        ) as T;
      }

      finishSpan(operation, start, ctx, parentSpanId);
      return result;
    } catch (err) {
      finishSpan(operation, start, ctx, parentSpanId);
      throw err;
    }
  },

  addBreadcrumb(crumb: { category?: string; message: string; data?: Record<string, unknown>; level?: string }): void {
    try {
      const ctx = getContext();
      ctx?.breadcrumbs.add(crumb.category ?? "custom", crumb.message, crumb.data, crumb.level);
    } catch {
      // Never throw
    }
  },

  setTransactionName(name: string): void {
    const ctx = getContext();
    if (ctx) ctx.transactionName = name;
  },

  recordSql(name: string, durationMs: number, sql?: string): void {
    try {
      const ctx = getContext();
      if (ctx) {
        ctx.sqlCount += 1;
        ctx.sqlTotalMs += durationMs;
        ctx.collector?.recordSql(name, durationMs, sql);
      }
    } catch {
      // Never throw
    }
  },

  setContext(ctx: Record<string, unknown>): void {
    globalContext = { ...globalContext, ...ctx };
  },

  stats(): StatsSnapshot | null {
    return client?.stats.snapshot() ?? null;
  },

  healthy(): boolean {
    return client?.isHealthy ?? false;
  },

  async flush(): Promise<void> {
    await client?.flush();
  },

  middleware: {
    express() {
      return createExpressMiddleware(getInternals());
    },
    fastify() {
      return createFastifyPlugin(getInternals());
    },
    hono() {
      return createHonoMiddleware(getInternals());
    },
  },

  /** @internal — exposed for testing */
  _client(): Client | null {
    return client;
  },

  /** @internal — reset for testing */
  _reset(): void {
    initialized = false;
    config = null;
    client = null;
    enabled = true;
    globalContext = {};
    clearLevelCache();
  },
};

function resolveContext(): Record<string, unknown> | null {
  if (Object.keys(globalContext).length === 0) return null;
  return { ...globalContext };
}

function finishSpan(
  operation: string,
  start: number,
  ctx: ReturnType<typeof getContext>,
  parentSpanId: string | null,
): void {
  const durationMs = performance.now() - start;
  ctx?.collector?.recordSpan(operation, durationMs);
  if (ctx) ctx.spanId = parentSpanId ?? ctx.spanId;

  // Log the span completion
  try {
    if (initialized && enabled && client && config) {
      const entry: DeferredLog = {
        kind: "log",
        ts: Date.now(),
        level: "info",
        message: `span: ${operation} ${Math.round(durationMs)}ms`,
        metadata: {
          span_operation: operation,
          span_duration_ms: Math.round(durationMs * 100) / 100,
        },
        context: resolveContext(),
        requestId: ctx?.requestId ?? null,
        traceId: ctx?.traceId ?? null,
        spanId: ctx?.spanId ?? null,
        parentSpanId,
      };
      client.enqueue(entry);
    }
  } catch {
    // Never throw
  }
}

function cleanStack(stack: string): string {
  return stack
    .split("\n")
    .filter((line) => !line.includes("node_modules") && !line.includes("node:internal"))
    .join("\n");
}


const MAX_CAUSE_DEPTH = 5;

function walkCauses(err: Error): ErrorCause[] {
  const causes: ErrorCause[] = [];
  let current = err.cause;
  let depth = 0;

  while (current instanceof Error && depth < MAX_CAUSE_DEPTH) {
    causes.push({
      className: current.name,
      message: current.message,
      stack: cleanStack(current.stack ?? ""),
    });
    current = current.cause;
    depth++;
  }

  return causes;
}

export default OpenTrace;
