import type { IncomingMessage, ServerResponse } from 'node:http';
import { asyncLocalStorage, createRequestContext } from '../context.js';
import { RequestCollector } from '../request-collector.js';
import { extractRequestInfo, extractTraceInfo, isIgnoredPath } from './common.js';
import type { DeferredRequest } from '../types.js';

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

type NextFunction = (err?: unknown) => void;

export function createExpressMiddleware(internals: OpenTraceInternals) {
  return function opentraceMiddleware(req: IncomingMessage, res: ServerResponse, next: NextFunction): void {
    if (!internals.enabled()) return next();

    const cfg = internals.config();
    if (!cfg) return next();

    const info = extractRequestInfo(req);

    if (isIgnoredPath(info.path, cfg.ignorePaths)) return next();

    if (!internals.sample(req)) {
      internals.recordSampledOut();
      return next();
    }

    const traceInfo = extractTraceInfo(req);
    const start = performance.now();

    const collector = cfg.requestSummary
      ? new RequestCollector(start, cfg.timeline, cfg.timelineMaxEvents)
      : null;

    const store = createRequestContext({
      requestId: info.requestId,
      traceId: traceInfo.traceId,
      spanId: traceInfo.spanId,
      parentSpanId: traceInfo.parentSpanId,
      collector,
    });

    asyncLocalStorage.run(store, () => {
      // Intercept response end to capture timing
      const originalEnd = res.end;
      res.end = function (
        this: ServerResponse,
        // biome-ignore lint/suspicious/noExplicitAny: must match overloaded res.end signature
        chunk?: any,
        // biome-ignore lint/suspicious/noExplicitAny: must match overloaded res.end signature
        encodingOrCb?: any,
        cb?: () => void,
      ) {
        const durationMs = performance.now() - start;

        const entry: DeferredRequest = {
          kind: 'request',
          started: Date.now() - durationMs,
          finished: Date.now(),
          method: info.method,
          path: info.path,
          status: res.statusCode,
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

        return originalEnd.call(this, chunk, encodingOrCb, cb);
      } as typeof res.end;

      next();
    });
  };
}
