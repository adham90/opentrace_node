# OpenTrace Node.js Client — Implementation Plan

> Port of `opentrace_ruby` to TypeScript for Node.js backends.
> Same safety-first philosophy: never throw, never block, zero measurable overhead.

---

## 1. Project Setup

### Package Identity

```
Name:         @opentrace/node
Language:     TypeScript (strict mode)
Target:       Node.js >= 18 (LTS), Bun, Deno
Module:       ESM primary, CJS dual-publish
Build:        tsup (esbuild-based, fast, handles dual output)
Test:         Vitest
Lint:         Biome (fast, single tool for lint + format)
CI:           GitHub Actions
```

### Directory Structure

```
opentrace_node/
├── src/
│   ├── index.ts                  # Public API facade (OpenTrace singleton)
│   ├── client.ts                 # Background dispatcher (queue + flush + retry)
│   ├── config.ts                 # Configuration with defaults and validation
│   ├── payload-builder.ts        # Materialize deferred entries into JSON payloads
│   ├── sampler.ts                # Graduated backpressure sampling
│   ├── circuit-breaker.ts        # Circuit breaker (closed/open/half-open)
│   ├── stats.ts                  # Thread-safe counters
│   ├── breadcrumbs.ts            # FIFO breadcrumb buffer
│   ├── trace-context.ts          # W3C traceparent generation & parsing
│   ├── pii-scrubber.ts           # Regex-based PII redaction
│   ├── sql-normalizer.ts         # SQL literal stripping + fingerprinting
│   ├── middleware/
│   │   ├── express.ts            # Express middleware
│   │   ├── fastify.ts            # Fastify plugin
│   │   ├── hono.ts               # Hono middleware
│   │   └── common.ts             # Shared request extraction logic
│   ├── instrumentation/
│   │   ├── http-outbound.ts      # Monkey-patch http/https for outbound tracking
│   │   └── console.ts            # console.log/warn/error capture
│   ├── monitors/
│   │   ├── runtime.ts            # Event loop lag, heap stats, GC metrics
│   │   └── pool.ts               # Generic connection pool monitor
│   └── context.ts                # AsyncLocalStorage-based request context
├── test/
│   ├── client.test.ts
│   ├── config.test.ts
│   ├── payload-builder.test.ts
│   ├── sampler.test.ts
│   ├── circuit-breaker.test.ts
│   ├── breadcrumbs.test.ts
│   ├── trace-context.test.ts
│   ├── pii-scrubber.test.ts
│   ├── sql-normalizer.test.ts
│   ├── middleware/
│   │   ├── express.test.ts
│   │   ├── fastify.test.ts
│   │   └── hono.test.ts
│   ├── instrumentation/
│   │   ├── http-outbound.test.ts
│   │   └── console.test.ts
│   └── integration/
│       └── end-to-end.test.ts
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── biome.json
├── vitest.config.ts
├── LICENSE
├── README.md
├── CHANGELOG.md
└── .github/
    └── workflows/
        └── ci.yml
```

### Dependencies

```
Runtime:      ZERO (Node.js built-ins only)
Dev:          tsup, typescript, vitest, biome, @types/node
```

Zero runtime dependencies — mirrors the Ruby gem's approach. Uses only Node.js built-ins:
- `node:http` / `node:https` for transport
- `node:crypto` for fingerprints and trace IDs
- `node:zlib` for gzip compression
- `node:async_hooks` (AsyncLocalStorage) for request context
- `node:perf_hooks` for timing
- `node:os` for hostname/memory
- `node:v8` for heap stats

---

## 2. Core Architecture

### 2.1 Request Context (`context.ts`)

**Ruby equivalent:** `Fiber[:opentrace_*]` locals

Node.js equivalent is `AsyncLocalStorage` — provides per-request isolation across async boundaries without manual threading.

```typescript
interface RequestContext {
  requestId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  transactionName: string | null;
  sqlCount: number;
  sqlTotalMs: number;
  breadcrumbs: BreadcrumbBuffer;
  collector: RequestCollector | null;
  cachedContext: Record<string, unknown> | null;
  sessionId: string | null;
  memoryBefore: number | null;
}
```

**Key difference from Ruby:** `AsyncLocalStorage` propagates across `await`, `setTimeout`, `Promise` chains automatically — no manual cleanup needed like Fiber locals. However, we still clean up in middleware `finally` block to prevent memory leaks in long-lived contexts.

### 2.2 Client (`client.ts`)

**Ruby equivalent:** `Client` with `Thread::Queue` + background dispatch thread

Node.js approach: bounded in-memory array + `setInterval` flush timer + `fetch()` / `node:http` for transport.

```
Enqueue flow:
  OpenTrace.log() → deferred entry → client.enqueue()
    → if queue.length >= MAX_QUEUE_SIZE: drop + stats.dropped_queue_full++
    → else: queue.push(entry)

Flush flow (runs on timer or manual):
  drain queue → PayloadBuilder.materialize batch
    → PII scrub → fit_payload (truncate) → JSON.stringify
    → gzip if > threshold → HTTP POST with retry
    → circuit breaker check → rate limit handling
```

**Queue implementation:**
- Simple `Array<DeferredEntry>` (no need for lock-free queue — JS is single-threaded)
- `MAX_QUEUE_SIZE = 1000`
- Drop newest when full (same as Ruby)
- This is a major simplification over Ruby — no Mutex, no try_lock needed

**Flush timer:**
- `setInterval(flush, config.flushInterval)` with `unref()` so it doesn't keep process alive
- `flush()` also called on `process.on('beforeExit')` and `process.on('SIGTERM')`

**HTTP transport:**
- Primary: `node:http`/`node:https` with keep-alive agent (persistent connections)
- Optional: Unix domain socket via `{ socketPath }` option
- Headers: `Authorization: Bearer <key>`, `Content-Type: application/json`, `Content-Encoding: gzip`, `User-Agent`, `X-API-Version`, `X-Batch-ID`
- Timeout: configurable (default 5s via `AbortController`)

**Fork/cluster safety:**
- Detect `cluster.isWorker` and `process.pid` changes
- Reset queue + timer + HTTP agent on fork
- `cluster.on('fork')` hook for automatic reset

### 2.3 Deferred Entry Pattern

**Ruby equivalent:** frozen Arrays pushed to queue, materialized by PayloadBuilder on background thread

In Node.js there's no background thread, but we still defer materialization to flush time to keep the hot path fast:

```typescript
type DeferredLog = {
  kind: 'log';
  ts: number;          // Date.now() — cheap
  level: string;
  message: string;
  metadata: Record<string, unknown>;
  context: Record<string, unknown> | null;
  requestId: string | null;
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
};

type DeferredRequest = {
  kind: 'request';
  started: number;
  finished: number;
  method: string;
  path: string;
  status: number;
  controller: string | null;
  action: string | null;
  collector: RequestCollector | null;
  context: Record<string, unknown> | null;
  // ... same fields as Ruby
};

type DeferredEntry = DeferredLog | DeferredRequest | DeferredError | DeferredEvent;
```

**Hot path cost:** ~1μs (object literal + array push). No serialization, no hashing, no string formatting.

### 2.4 PayloadBuilder (`payload-builder.ts`)

**Ruby equivalent:** `PayloadBuilder#materialize`

Runs at flush time (not in request path). Converts deferred entries to API-ready payloads:

```typescript
materialize(entry: DeferredEntry): Payload {
  // 1. Format timestamp as ISO 8601 with microseconds
  // 2. Merge context + metadata
  // 3. Merge static context (hostname, pid, gitSha)
  // 4. Promote indexed fields to top level
  // 5. Attach request_summary if collector present
  // 6. Return ready-to-serialize object
}
```

**Truncation priority** (same as Ruby):
1. Remove stack trace
2. Remove params
3. Truncate SQL (200 chars)
4. Truncate exception message (200 chars)
5. Remove request_summary.timeline
6. Drop entire payload if still oversized

**Batch splitting:**
- If `JSON.stringify(batch).length > maxPayloadBytes`: split in half, recurse
- Max recursion depth: 5

### 2.5 Config (`config.ts`)

Mirror Ruby's config with JS idioms:

```typescript
interface OpenTraceConfig {
  // Required
  endpoint: string;
  apiKey: string;
  service: string;

  // Identity
  environment?: string;
  hostname?: string;           // default: os.hostname()
  pid?: number;                // default: process.pid
  gitSha?: string;             // default: env.REVISION || env.GIT_SHA

  // Batching & Transport
  batchSize?: number;          // default: 50
  flushInterval?: number;      // default: 5000 (ms)
  maxPayloadBytes?: number;    // default: 256 * 1024
  compression?: boolean;       // default: true
  compressionThreshold?: number; // default: 1024
  timeout?: number;            // default: 5000 (ms)
  transport?: 'http' | 'unix_socket';
  socketPath?: string;

  // Retry & Resilience
  maxRetries?: number;         // default: 2
  retryBaseDelay?: number;     // default: 100 (ms)
  retryMaxDelay?: number;      // default: 2000 (ms)
  circuitBreakerThreshold?: number;  // default: 5
  circuitBreakerTimeout?: number;    // default: 30000 (ms)

  // Filtering & Sampling
  minLevel?: 'debug' | 'info' | 'warn' | 'error';  // default: 'info'
  allowedLevels?: string[] | null;
  sampleRate?: number;         // default: 1.0
  sampler?: (req: IncomingMessage) => number;
  ignorePaths?: string[];      // default: ['/health', '/ready', '/live']

  // Instrumentation (all opt-in)
  requestSummary?: boolean;    // default: true
  sqlLogging?: boolean;        // default: false
  httpTracking?: boolean;      // default: false
  consoleCapture?: boolean;    // default: false
  timeline?: boolean;          // default: false
  timelineMaxEvents?: number;  // default: 200
  memoryTracking?: boolean;    // default: false

  // Data Protection
  piiScrubbing?: boolean;      // default: false
  piiPatterns?: RegExp[];
  beforeSend?: (payload: Payload) => Payload | null;
  onError?: (err: Error, meta: Record<string, unknown>) => void;
  afterSend?: (batchSize: number, bytes: number) => void;
  onDrop?: (count: number, reason: string) => void;

  // Context
  context?: (() => Record<string, unknown>) | Record<string, unknown>;

  // Monitors
  runtimeMetrics?: boolean;    // default: false
  runtimeMetricsInterval?: number;  // default: 30000 (ms)

  // Debug
  debug?: boolean;             // default: false
}
```

### 2.6 Sampler (`sampler.ts`)

**Identical to Ruby** — graduated backpressure:

```
Queue > 75% full → increase backpressure (exponential)
Queue < 25% full → decrease backpressure
Max backpressure: 2^10 = 1024x reduction

effectiveRate = (sampler(req) || sampleRate) / (2 ** backpressure)
```

### 2.7 Circuit Breaker (`circuit-breaker.ts`)

**Identical to Ruby** — three states:

```
CLOSED → (N failures) → OPEN → (timeout) → HALF_OPEN → (success) → CLOSED
                                           → (failure) → OPEN
```

### 2.8 Stats (`stats.ts`)

Simple counter object (no mutex needed — single-threaded):

```typescript
interface Stats {
  enqueued: number;
  delivered: number;
  droppedQueueFull: number;
  droppedCircuitOpen: number;
  droppedAuthSuspended: number;
  droppedError: number;
  droppedFiltered: number;
  retries: number;
  rateLimited: number;
  authFailures: number;
  batchesSent: number;
  bytesSent: number;
  sampledOut: number;
  uptime: number;
}
```

---

## 3. Middleware Layer

### 3.1 Common Request Extraction (`middleware/common.ts`)

Shared logic for all frameworks:

```typescript
function extractRequestInfo(req): RequestInfo {
  return {
    method: req.method,
    path: req.url,                    // normalized, query stripped
    userAgent: req.headers['user-agent'],
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    requestId: req.headers['x-request-id'] || crypto.randomUUID(),
    contentType: req.headers['content-type'],
  };
}

function extractTraceContext(req): TraceInfo {
  // Priority: W3C traceparent > X-Trace-ID > X-Request-ID > generate
  // Same logic as Ruby's TraceContext module
}
```

### 3.2 Express Middleware (`middleware/express.ts`)

```typescript
export function opentraceMiddleware(options?: MiddlewareOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!OpenTrace.enabled()) return next();
    if (isIgnoredPath(req.path)) return next();
    if (!sampler.sample(req)) { stats.sampledOut++; return next(); }

    const store = createRequestContext(req);

    asyncLocalStorage.run(store, () => {
      const start = performance.now();

      // Track response
      const originalEnd = res.end;
      res.end = function(...args) {
        const duration = performance.now() - start;
        const ctx = asyncLocalStorage.getStore();

        // Enqueue request entry
        client.enqueue({
          kind: 'request',
          started: start,
          finished: start + duration,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          collector: ctx?.collector ?? null,
          context: ctx?.cachedContext ?? null,
          requestId: ctx?.requestId ?? null,
          traceId: ctx?.traceId ?? null,
          spanId: ctx?.spanId ?? null,
          parentSpanId: ctx?.parentSpanId ?? null,
        });

        return originalEnd.apply(this, args);
      };

      next();
    });
  };
}
```

### 3.3 Fastify Plugin (`middleware/fastify.ts`)

```typescript
export const opentracePlugin: FastifyPluginCallback = (fastify, opts, done) => {
  fastify.addHook('onRequest', (req, reply, done) => {
    // Set up AsyncLocalStorage context
    // Same as Express but using Fastify's lifecycle
  });

  fastify.addHook('onResponse', (req, reply, done) => {
    // Enqueue request entry with timing
  });

  fastify.addHook('onError', (req, reply, error, done) => {
    // Capture error with fingerprint
  });

  done();
};
```

### 3.4 Hono Middleware (`middleware/hono.ts`)

```typescript
export function opentraceMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!OpenTrace.enabled()) return next();

    const store = createRequestContext(c.req.raw);
    return asyncLocalStorage.run(store, async () => {
      const start = performance.now();
      await next();
      const duration = performance.now() - start;

      client.enqueue({
        kind: 'request',
        started: start,
        finished: start + duration,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        collector: store.collector,
        context: store.cachedContext,
        // ...
      });
    });
  };
}
```

---

## 4. Instrumentation

### 4.1 HTTP Outbound Tracking (`instrumentation/http-outbound.ts`)

**Ruby equivalent:** `HttpTracker` (Net::HTTP prepend)

Monkey-patch `http.request` and `https.request`:

```typescript
export function enableHttpTracking() {
  const originalRequest = http.request;

  http.request = function(options, callback) {
    const ctx = asyncLocalStorage.getStore();
    if (!ctx) return originalRequest.call(this, options, callback);

    // Inject trace headers
    options.headers = {
      ...options.headers,
      'X-Trace-ID': ctx.traceId,
      'X-Request-ID': ctx.requestId,
      'traceparent': buildTraceparent(ctx),
    };

    const start = performance.now();
    const req = originalRequest.call(this, options, (res) => {
      const duration = performance.now() - start;

      // Record in collector
      ctx.collector?.recordHttp({
        method: options.method || 'GET',
        host: options.hostname || options.host,
        path: options.path,
        status: res.statusCode,
        durationMs: duration,
      });

      callback?.(res);
    });

    return req;
  };
}
```

**Guard:** Skip tracking when the request is OpenTrace's own flush (check destination against config.endpoint).

### 4.2 Console Capture (`instrumentation/console.ts`)

**No Ruby equivalent** — unique to Node.js.

Optionally intercept `console.log/warn/error` and forward to OpenTrace:

```typescript
export function enableConsoleCapture() {
  const original = { log: console.log, warn: console.warn, error: console.error };

  console.error = function(...args) {
    original.error.apply(console, args);
    OpenTrace.log('error', formatArgs(args), { source: 'console' });
  };
  // Same for warn, log
}
```

Opt-in only. Default: off.

---

## 5. RequestCollector

**Ruby equivalent:** `RequestCollector`

Per-request aggregation of SQL, HTTP, and custom events:

```typescript
class RequestCollector {
  // SQL
  sqlCount = 0;
  sqlTotalMs = 0;
  sqlSlowestMs = 0;
  sqlSlowestName = '';
  sqlFingerprints = new Map<string, number>();  // max 100

  // HTTP outbound
  httpCount = 0;
  httpTotalMs = 0;
  httpSlowestMs = 0;
  httpSlowestHost = '';

  // Timeline (if enabled)
  timeline: TimelineEvent[] = [];  // max 200

  // Memory
  memoryBefore: number | null = null;
  memoryAfter: number | null = null;

  recordSql(name: string, durationMs: number, fingerprint: string): void;
  recordHttp(info: HttpInfo): void;
  recordSpan(name: string, durationMs: number): void;

  summary(): RequestSummary;
}
```

**N+1 detection:** `sqlCount > 20` or any duplicate fingerprint count > 5.

---

## 6. Monitors

### 6.1 Runtime Monitor (`monitors/runtime.ts`)

**Ruby equivalent:** `RuntimeMonitor`

Collect Node.js-specific metrics via `setInterval` (unreffed):

```typescript
// Collected every 30s (configurable):
{
  event_loop_lag_ms: number;       // perf_hooks.monitorEventLoopDelay()
  heap_used_mb: number;            // v8.getHeapStatistics()
  heap_total_mb: number;
  external_mb: number;
  rss_mb: number;                  // process.memoryUsage()
  active_handles: number;          // process._getActiveHandles().length
  active_requests: number;         // process._getActiveRequests().length
  gc_major_count: number;          // perf_hooks PerformanceObserver
  gc_minor_count: number;
  uptime_seconds: number;
}
```

Sent as `OpenTrace.event('runtime.metrics', ...)`.

### 6.2 Pool Monitor (`monitors/pool.ts`)

Generic interface for connection pool stats (pg, mysql2, ioredis, etc.):

```typescript
interface PoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

// User provides a function that returns pool stats:
config.poolMonitor = () => ({
  totalCount: pool.totalCount,
  idleCount: pool.idleCount,
  waitingCount: pool.waitingCount,
});
```

---

## 7. Public API

### 7.1 Main Module (`index.ts`)

```typescript
const OpenTrace = {
  // Lifecycle
  init(config: OpenTraceConfig): void;
  shutdown(timeout?: number): Promise<void>;
  enabled(): boolean;
  enable(): void;
  disable(): void;

  // Logging
  log(level: string, message: string, metadata?: Record<string, unknown>): void;
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(error: Error | string, metadata?: Record<string, unknown>): void;

  // Events
  event(eventType: string, message: string, metadata?: Record<string, unknown>): void;

  // Tracing
  trace<T>(operation: string, fn: () => T | Promise<T>): T | Promise<T>;

  // Breadcrumbs
  addBreadcrumb(crumb: { type?: string; data?: unknown; message?: string }): void;

  // Context
  setContext(ctx: Record<string, unknown>): void;
  setTransactionName(name: string): void;

  // Observability
  stats(): Stats;
  healthy(): boolean;
  flush(): Promise<void>;

  // Middleware (convenience re-exports)
  middleware: {
    express: typeof expressMiddleware;
    fastify: typeof fastifyPlugin;
    hono: typeof honoMiddleware;
  };
};

export default OpenTrace;
```

### 7.2 Error Handling

**Every public method wraps in try/catch — never throws:**

```typescript
log(level: string, message: string, metadata?: Record<string, unknown>): void {
  try {
    if (!this._initialized || !this._config.enabled) return;
    if (!this._isLevelEnabled(level)) return;
    // ... enqueue
  } catch {
    // Never throw to host app
  }
}
```

### 7.3 Error Capture

```typescript
error(err: Error | string, metadata?: Record<string, unknown>): void {
  // Extract: message, name, stack
  // Clean backtrace (strip node_modules, internal)
  // Fingerprint: crypto.createHash('md5').update(`${name}||${origin}`).digest('hex').slice(0, 12)
  // Walk cause chain: err.cause (up to 5 levels)
  // Enqueue as DeferredError
}
```

### 7.4 Tracing (Spans)

```typescript
trace<T>(operation: string, fn: () => T | Promise<T>): T | Promise<T> {
  const ctx = asyncLocalStorage.getStore();
  const span = new Span(operation, ctx?.spanId);

  // Push span onto context
  const prevSpanId = ctx?.spanId;
  if (ctx) ctx.spanId = span.spanId;

  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(
        (val) => { span.finish(); return val; },
        (err) => { span.finish(err); throw err; }
      );
    }
    span.finish();
    return result;
  } catch (err) {
    span.finish(err);
    throw err;  // Re-throw user errors (unlike log methods)
  } finally {
    if (ctx) ctx.spanId = prevSpanId;  // Restore parent
  }
}
```

---

## 8. Key Differences from Ruby Gem

| Aspect | Ruby | Node.js | Reason |
|--------|------|---------|--------|
| Concurrency | Background thread + Mutex | Single-threaded event loop + timers | JS runtime model |
| Queue | `Thread::Queue` with `try_lock` | Simple `Array.push` | No thread contention |
| Request context | `Fiber[:opentrace_*]` | `AsyncLocalStorage` | Equivalent purpose |
| HTTP client | `Net::HTTP` persistent | `node:http` with keep-alive Agent | Built-in |
| Compression | `Zlib::GzipWriter` | `node:zlib.gzipSync` | Built-in |
| Fingerprint | `Digest::MD5` | `crypto.createHash('md5')` | Built-in |
| Fork detection | `Process.pid` check | `cluster` module hooks | Different fork model |
| Timer | `Thread` with sleep loop | `setInterval().unref()` | Non-blocking |
| Graceful shutdown | `at_exit` + thread.join | `process.on('beforeExit')` + flush promise | Async |
| Middleware | Rack middleware | Framework-specific (Express/Fastify/Hono) | No universal standard |
| Log forwarding | `BroadcastLogger` / Logger wrapper | Console monkey-patch (opt-in) | Different logging model |
| SQL subscriber | `ActiveSupport::Notifications` | Manual (user calls `recordSql`) | No universal ORM events |
| View tracking | `render_template.action_view` | N/A | No equivalent concept |
| Cache tracking | `cache_*.active_support` | N/A | No equivalent concept |

---

## 9. SQL Integration Strategy

Unlike Ruby (where ActiveSupport::Notifications provides universal hooks), Node.js has no standard ORM event system. Strategy:

### Option A: Manual recording (Phase 1)
```typescript
// User instruments their own queries:
const result = await db.query(sql);
OpenTrace.recordSql(sql, durationMs);
```

### Option B: Prisma integration (Phase 2)
```typescript
// Prisma middleware:
prisma.$use(async (params, next) => {
  const start = performance.now();
  const result = await next(params);
  OpenTrace.recordSql(params.model + '.' + params.action, performance.now() - start);
  return result;
});
```

### Option C: Knex/pg instrumentation (Phase 2)
```typescript
// Knex event:
knex.on('query-response', (response, query) => {
  OpenTrace.recordSql(query.sql, query.__knexQueryUid);
});
```

### Option D: `diagnostics_channel` (Phase 3, Node 19+)
```typescript
// Future: hook into native diagnostics
import dc from 'node:diagnostics_channel';
dc.subscribe('pg.query', (message) => { ... });
```

**Decision:** Ship Phase 1 (manual) first. Add Prisma/Knex plugins as separate optional exports.

---

## 10. Implementation Phases

### Phase 1 — Core (Week 1-2)
**Goal:** Minimal working client that can send logs to OpenTrace server.

| # | File | Description | Tests |
|---|------|-------------|-------|
| 1 | `config.ts` | Configuration with defaults, validation, level caching | ✓ |
| 2 | `stats.ts` | Counter object with snapshot() | ✓ |
| 3 | `circuit-breaker.ts` | State machine (closed/open/half-open) | ✓ |
| 4 | `trace-context.ts` | W3C traceparent parse/generate, span IDs | ✓ |
| 5 | `breadcrumbs.ts` | FIFO buffer, max 25, to_array | ✓ |
| 6 | `sql-normalizer.ts` | Literal stripping, fingerprint (MD5 first 12) | ✓ |
| 7 | `payload-builder.ts` | Materialize deferred entries, truncation, batch split | ✓ |
| 8 | `sampler.ts` | Backpressure sampling | ✓ |
| 9 | `client.ts` | Queue, flush timer, HTTP POST, retry, gzip | ✓ |
| 10 | `index.ts` | Public API: init, log, error, event, shutdown | ✓ |

**Deliverable:** `OpenTrace.init({ endpoint, apiKey, service })` → `OpenTrace.log('info', 'hello')` → logs appear in server.

### Phase 2 — Middleware & Context (Week 3)
**Goal:** Per-request tracking with framework middleware.

| # | File | Description | Tests |
|---|------|-------------|-------|
| 11 | `context.ts` | AsyncLocalStorage store, getContext(), cleanup | ✓ |
| 12 | `middleware/common.ts` | Request extraction, trace context, ignore paths | ✓ |
| 13 | `middleware/express.ts` | Express middleware | ✓ |
| 14 | `middleware/fastify.ts` | Fastify plugin | ✓ |
| 15 | `middleware/hono.ts` | Hono middleware | ✓ |
| 16 | `request-collector.ts` | SQL/HTTP aggregation, N+1 detection, timeline | ✓ |

**Deliverable:** Express/Fastify/Hono apps get automatic request logging with timing.

### Phase 3 — Instrumentation & Monitors (Week 4)
**Goal:** Outbound HTTP tracking, console capture, runtime metrics.

| # | File | Description | Tests |
|---|------|-------------|-------|
| 17 | `instrumentation/http-outbound.ts` | Monkey-patch http.request, trace injection | ✓ |
| 18 | `instrumentation/console.ts` | console.log/warn/error forwarding | ✓ |
| 19 | `monitors/runtime.ts` | Event loop lag, heap, GC, handles | ✓ |
| 20 | `monitors/pool.ts` | Generic pool stat collector | ✓ |
| 21 | `pii-scrubber.ts` | Regex patterns, sensitive keys, deep scrub | ✓ |

**Deliverable:** Full-featured client with all Ruby gem capabilities ported.

### Phase 4 — Polish & Publish (Week 5)
**Goal:** Production-ready npm package.

| # | Task | Description |
|---|------|-------------|
| 22 | Integration tests | End-to-end with mock server |
| 23 | README.md | Usage guide with examples for Express, Fastify, Hono, Next.js |
| 24 | CHANGELOG.md | Initial release notes |
| 25 | CI pipeline | GitHub Actions: lint, test, build, publish |
| 26 | npm publish | `@opentrace/node` on npm |
| 27 | tsup config | Dual ESM/CJS output, sourcemaps, dts |

---

## 11. API Compatibility

The Node client sends the **exact same JSON payload format** as the Ruby gem:

```json
{
  "timestamp": "2026-02-26T12:34:56.123456Z",
  "level": "INFO",
  "service": "my-api",
  "environment": "production",
  "message": "GET /api/users 200 45ms",
  "metadata": { "user_id": 42 },
  "commit_hash": "abc123",
  "request_id": "req-uuid",
  "trace_id": "32-char-hex",
  "span_id": "16-char-hex",
  "parent_span_id": "16-char-hex",
  "event_type": "request",
  "request_summary": {
    "sql_query_count": 5,
    "sql_total_ms": 23.4,
    "http_count": 2,
    "http_total_ms": 150.0,
    "n_plus_one_warning": false
  }
}
```

**Endpoint:** `POST {config.endpoint}/api/logs` with `Authorization: Bearer {apiKey}`

This ensures the OpenTrace server works identically with Ruby, Browser, and Node clients.

---

## 12. Usage Examples

### Minimal

```typescript
import OpenTrace from '@opentrace/node';

OpenTrace.init({
  endpoint: 'https://opentrace.example.com',
  apiKey: process.env.OPENTRACE_API_KEY,
  service: 'my-api',
});

OpenTrace.info('Server started', { port: 3000 });
```

### Express

```typescript
import express from 'express';
import OpenTrace from '@opentrace/node';

OpenTrace.init({
  endpoint: process.env.OPENTRACE_URL,
  apiKey: process.env.OPENTRACE_KEY,
  service: 'my-express-app',
  environment: process.env.NODE_ENV,
  httpTracking: true,
  runtimeMetrics: true,
});

const app = express();
app.use(OpenTrace.middleware.express());

app.get('/users', async (req, res) => {
  const users = await OpenTrace.trace('db.users.findAll', () => db.query('SELECT * FROM users'));
  res.json(users);
});

process.on('SIGTERM', async () => {
  await OpenTrace.shutdown(5000);
  process.exit(0);
});
```

### Fastify

```typescript
import Fastify from 'fastify';
import OpenTrace from '@opentrace/node';

OpenTrace.init({ endpoint, apiKey, service: 'my-fastify-app' });

const app = Fastify();
app.register(OpenTrace.middleware.fastify);

app.get('/health', async () => ({ status: 'ok' }));
```

### Next.js (App Router)

```typescript
// lib/opentrace.ts
import OpenTrace from '@opentrace/node';

OpenTrace.init({
  endpoint: process.env.OPENTRACE_URL,
  apiKey: process.env.OPENTRACE_KEY,
  service: 'my-next-app',
});

export default OpenTrace;

// middleware.ts
import OpenTrace from './lib/opentrace';

export function middleware(req: NextRequest) {
  // OpenTrace auto-tracks via instrumentation
  return NextResponse.next();
}
```

---

## 13. Testing Strategy

- **Unit tests:** Each module in isolation with Vitest
- **HTTP mocking:** Use `node:http.createServer` for local mock server (no external deps)
- **Timer control:** `vi.useFakeTimers()` for flush interval testing
- **AsyncLocalStorage tests:** Verify context propagation across async boundaries
- **Integration tests:** Spin up mock HTTP server, init OpenTrace, send logs, verify received payloads
- **No network calls in CI:** All HTTP intercepted or pointed at localhost mock

---

## 14. npm Package Config

```json
{
  "name": "@opentrace/node",
  "version": "0.1.0",
  "description": "OpenTrace Node.js client — async structured log forwarding",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    },
    "./middleware/express": {
      "import": "./dist/middleware/express.js",
      "require": "./dist/middleware/express.cjs"
    },
    "./middleware/fastify": {
      "import": "./dist/middleware/fastify.js",
      "require": "./dist/middleware/fastify.cjs"
    },
    "./middleware/hono": {
      "import": "./dist/middleware/hono.js",
      "require": "./dist/middleware/hono.cjs"
    }
  },
  "files": ["dist"],
  "engines": { "node": ">=18" },
  "license": "MIT",
  "keywords": ["opentrace", "logging", "monitoring", "observability", "tracing", "debugging"]
}
```
