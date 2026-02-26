# OpenTrace Node.js Client — Architecture & Design

> TypeScript port of `opentrace_ruby` for Node.js backends.
> Safety-first: never throw, never block, zero measurable overhead.

**Status:** v0.1.0 — all core features implemented, 189 tests passing.

---

## Project

```
Name:         @opentrace-sdk/node
Version:      0.1.0
Language:     TypeScript (strict mode)
Target:       Node.js >= 18
Module:       ESM + CJS dual-publish
Build:        tsup
Test:         Vitest (189 tests)
Lint:         Biome
CI:           GitHub Actions (Node 18, 20, 22)
Dependencies: ZERO runtime (Node.js built-ins only)
```

---

## File Structure

```
src/
├── index.ts                     # Public API facade (OpenTrace singleton)
├── types.ts                     # Core type definitions (DeferredEntry, Payload, etc.)
├── config.ts                    # Configuration resolution, validation, level filtering
├── client.ts                    # Queue (1000 max), flush timer, HTTP POST, retry, gzip
├── payload-builder.ts           # Deferred entry materialization, smart truncation
├── context.ts                   # AsyncLocalStorage-based per-request context
├── request-collector.ts         # SQL/HTTP aggregation, N+1 detection, timeline
├── trace-context.ts             # W3C traceparent parse/generate, span ID generation
├── breadcrumbs.ts               # FIFO buffer (max 25)
├── circuit-breaker.ts           # closed/open/half_open state machine
├── sampler.ts                   # Graduated backpressure (2^10 max reduction)
├── stats.ts                     # Counter snapshots (enqueued, delivered, dropped, etc.)
├── pii-scrubber.ts              # Regex redaction (email, CC, SSN, phone, bearer, API key)
├── sql-normalizer.ts            # Literal stripping + MD5 fingerprinting
├── middleware/
│   ├── common.ts                # Request extraction, path ignore, trace context
│   ├── express.ts               # Express middleware (res.end interception)
│   ├── fastify.ts               # Fastify plugin (onRequest/onResponse hooks)
│   └── hono.ts                  # Hono middleware (async wrapper)
├── instrumentation/
│   ├── http-outbound.ts         # Monkey-patch http/https.request, trace header injection
│   └── console.ts               # console.log/warn/error capture + forwarding
└── monitors/
    ├── runtime.ts               # V8 heap stats, RSS, active handles (unreffed timer)
    └── pool.ts                  # Generic connection pool stats via user-provided function

test/
├── stats.test.ts                # 5 tests
├── circuit-breaker.test.ts      # 8 tests
├── trace-context.test.ts        # 18 tests
├── breadcrumbs.test.ts          # 7 tests
├── sql-normalizer.test.ts       # 14 tests
├── sampler.test.ts              # 12 tests
├── config.test.ts               # 13 tests
├── pii-scrubber.test.ts         # 14 tests
├── payload-builder.test.ts      # 10 tests
├── client.test.ts               # 12 tests (real HTTP server, no mocks)
├── index.test.ts                # 21 tests (real HTTP server)
├── context.test.ts              # 5 tests (async propagation)
├── request-collector.test.ts    # 8 tests
├── middleware/
│   ├── common.test.ts           # 8 tests
│   └── express.test.ts          # 7 tests (real HTTP app + collector)
├── instrumentation/
│   ├── http-outbound.test.ts    # 5 tests (real HTTP server)
│   └── console.test.ts          # 8 tests
├── monitors/
│   ├── runtime.test.ts          # 4 tests
│   └── pool.test.ts             # 4 tests
└── integration/
    └── end-to-end.test.ts       # 6 tests (full middleware → flush → verify)
```

---

## Public API

```typescript
import OpenTrace from '@opentrace-sdk/node';

// Lifecycle
OpenTrace.init(config)               // Initialize with endpoint, apiKey, service
OpenTrace.shutdown(timeoutMs?)       // Flush remaining + cleanup (async)
OpenTrace.enabled()                  // Check if active
OpenTrace.enable() / .disable()      // Runtime toggle

// Logging
OpenTrace.log(level, message, metadata?)
OpenTrace.debug(message, metadata?)
OpenTrace.info(message, metadata?)
OpenTrace.warn(message, metadata?)
OpenTrace.error(err: Error | string, metadata?)  // Fingerprint, cause chain, stack

// Events & Tracing
OpenTrace.event(eventType, message, metadata?)
OpenTrace.trace(operation, fn)       // Span timing (sync + async), parent/child nesting

// Request Context
OpenTrace.addBreadcrumb({ category?, message, data?, level? })
OpenTrace.setTransactionName(name)
OpenTrace.recordSql(name, durationMs, sql?)
OpenTrace.setContext(ctx)            // Global context merged into all entries

// Observability
OpenTrace.stats()                    // StatsSnapshot | null
OpenTrace.healthy()                  // Circuit breaker + auth status
OpenTrace.flush()                    // Manual flush (async)

// Middleware
OpenTrace.middleware.express()       // Returns Express middleware
OpenTrace.middleware.fastify()       // Returns Fastify plugin
OpenTrace.middleware.hono()          // Returns Hono middleware
```

---

## Data Flow

```
OpenTrace.log/error/event/trace
    ↓
level filter → enabled check
    ↓
create DeferredEntry (object literal — ~1μs)
    ↓
Client.enqueue → Array (bounded 1000, drop newest when full)
    ↓
                    [setInterval flush timer — unreffed]
                              ↓
                    PayloadBuilder.materialize(batch)
                    (timestamp, context merge, static context)
                              ↓
                    PII scrub → beforeSend filter → fitPayload (truncate)
                              ↓
                    JSON.stringify → gzip if > threshold
                              ↓
                    HTTP POST with exponential backoff retry
                              ↓
                    circuit breaker → rate limit → auth suspension
```

---

## Key Design Decisions

| Pattern | Implementation | Why |
|---------|---------------|-----|
| Deferred entries | Object literals queued, materialized at flush | ~1μs hot path, no serialization in request |
| AsyncLocalStorage | Per-request context across async boundaries | No manual threading like Ruby's Fiber[] |
| Simple Array queue | No lock-free structures needed | JS is single-threaded |
| Factory middlewares | `createExpressMiddleware(internals)` | Avoids circular deps, testable in isolation |
| Real HTTP servers in tests | `node:http.createServer` as mock collector | No mock libraries, tests actual behavior |
| Circuit breaker | 5 failures → OPEN → 30s → HALF_OPEN → probe | Prevents cascading failures |
| Backpressure sampling | Queue > 75% → exponential rate reduction | Auto-adapts to overload |
| Graceful shutdown | `beforeExit` handler + flush with deadline | No lost data on clean exit |
| Fork detection | `process.pid` comparison on enqueue | Reset state after cluster fork |

---

## Configuration Defaults

| Option | Default | Description |
|--------|---------|-------------|
| `batchSize` | 50 | Entries per flush |
| `flushInterval` | 5000ms | Auto-flush timer |
| `maxPayloadBytes` | 256KB | Max batch size before splitting |
| `compression` | true | Gzip payloads |
| `compressionThreshold` | 1024 | Min bytes to compress |
| `timeout` | 5000ms | HTTP request timeout |
| `maxRetries` | 2 | Retry attempts on 5xx |
| `retryBaseDelay` | 100ms | Initial retry delay |
| `circuitBreakerThreshold` | 5 | Failures before OPEN |
| `circuitBreakerTimeout` | 30s | Cooldown before HALF_OPEN |
| `minLevel` | info | Log level threshold |
| `sampleRate` | 1.0 | Fraction of requests to trace |
| `ignorePaths` | /health, /ready, /live | Skip these paths |
| `requestSummary` | true | Aggregate SQL/HTTP per request |
| All instrumentation | false | Opt-in: sql, http, console, timeline, memory, runtime |

---

## API Compatibility

Same JSON payload format as `opentrace_ruby` and `@opentrace/browser`:

```
POST {endpoint}/api/logs
Authorization: Bearer {apiKey}
Content-Type: application/json
```

All three clients (Ruby, Browser, Node) send identical payload structures to the OpenTrace server.

---

## Future Work

- **npm publish** — publish `@opentrace-sdk/node` to npm registry
- **Prisma plugin** — auto-instrument Prisma queries via middleware
- **Knex/pg plugin** — auto-instrument via query events
- **`diagnostics_channel`** — native Node.js instrumentation (Node 19+)
- **Next.js integration** — dedicated middleware for App Router
- **Event loop lag** — `perf_hooks.monitorEventLoopDelay()` in runtime monitor
- **GC tracking** — `PerformanceObserver` for GC events
