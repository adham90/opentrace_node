# @opentrace/node

[![CI](https://img.shields.io/github/actions/workflow/status/adham90/opentrace_node/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/adham90/opentrace_node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org)

Async structured log forwarding for Node.js backends. Ships logs, errors, events, and request traces to an [OpenTrace](https://github.com/adham90/opentrace) server.

> **Requires an OpenTrace server** — This package forwards data to a running [OpenTrace server](https://github.com/adham90/opentrace), a self-hosted observability tool with 75+ MCP tools for logs, database monitoring, and AI-driven debugging. See the [server repo](https://github.com/adham90/opentrace) for setup.

**This package will never crash or slow down your application.** Every public method is wrapped in try/catch. All network errors are handled silently. If the server is unreachable, logs are dropped — your app continues running normally.

## Features

### Core
- **Zero runtime dependencies** — uses only Node.js built-ins (`http`, `crypto`, `zlib`, `async_hooks`, `v8`)
- **Zero measurable overhead** — deferred entries are plain object literals (~1μs), serialized only at flush time
- **TypeScript strict mode** — full type safety with ESM + CJS dual-publish
- **Never throws** — every public method wrapped in try/catch, safe for production
- **Async dispatch** — entries queued in-memory, batched and sent via background timer
- **Bounded queue** — caps at 1,000 entries to prevent memory bloat (drops newest when full)
- **Smart truncation** — oversized payloads are truncated field-by-field instead of dropped
- **Gzip compression** — automatic payload compression with configurable threshold
- **Level filtering** — `minLevel` threshold or `allowedLevels` list
- **Graceful shutdown** — `beforeExit` handler + flush with deadline, no lost data on clean exit
- **Fork detection** — resets state after `cluster.fork()` via PID comparison

### Request Tracking
- **Express, Fastify, Hono** — first-class middleware for all three frameworks
- **Per-request context** — `AsyncLocalStorage` propagates trace IDs across async boundaries
- **Request summaries** — SQL count, HTTP call count, N+1 detection, timeline per request
- **W3C traceparent** — distributed trace context propagation across services
- **Breadcrumbs** — FIFO trail of events (max 25) attached to request context

### Instrumentation
- **Outbound HTTP** — auto-instrument `http.request`/`https.request` with trace header injection
- **Console capture** — forward `console.log`/`warn`/`error` to OpenTrace
- **Runtime metrics** — V8 heap stats, RSS, active handles/requests (unreffed timer)
- **Connection pool** — generic pool stats via user-provided function
- **Manual spans** — `OpenTrace.trace('operation', fn)` with sync + async support and nesting

### Safety
- **Circuit breaker** — 5 failures → open → 30s cooldown → half-open probe
- **Backpressure sampling** — queue > 75% → exponential rate reduction (max 1024x)
- **Rate limit handling** — respects 429 responses with automatic backoff
- **Auth suspension** — stops sending on 401/403 until reinitialized
- **PII scrubbing** — regex redaction for emails, credit cards, SSNs, phone numbers, bearer tokens, API keys
- **SQL normalization** — strips literals, generates stable fingerprints for grouping

## Install

```bash
npm install @opentrace/node
```

## Quick Start

```typescript
import OpenTrace from '@opentrace/node';

OpenTrace.init({
  endpoint: 'https://your-opentrace-server.com',
  apiKey: 'your-api-key',
  service: 'my-app',
  environment: 'production',
});

// Structured logging
OpenTrace.info('User signed in', { userId: 42 });
OpenTrace.warn('Rate limit approaching', { current: 95, max: 100 });

// Error tracking with cause chain + fingerprinting
OpenTrace.error(new Error('Payment failed'), { orderId: 'abc-123' });

// Business events (bypass level filtering)
OpenTrace.event('deploy', 'Deployed v2.1.0', { commit: 'abc123' });

// Global context attached to every entry
OpenTrace.setContext({ tenant: 'acme', region: 'us-east-1' });

// Graceful shutdown
await OpenTrace.shutdown();
```

## Express Middleware

```typescript
import express from 'express';
import OpenTrace from '@opentrace/node';

const app = express();
app.use(OpenTrace.middleware.express());

app.get('/api/users', (req, res) => {
  // SQL tracking within request context
  OpenTrace.recordSql('SELECT users', 5.2, 'SELECT * FROM users');
  OpenTrace.addBreadcrumb({ category: 'db', message: 'loaded users' });
  res.json([{ id: 1, name: 'Alice' }]);
});
```

Each request automatically captures: method, path, status code, duration, trace context (W3C traceparent), request ID, and an optional request summary with SQL/HTTP aggregation and N+1 detection.

## Fastify Plugin

```typescript
import Fastify from 'fastify';
import OpenTrace from '@opentrace/node';

const app = Fastify();
app.register(OpenTrace.middleware.fastify());
```

## Hono Middleware

```typescript
import { Hono } from 'hono';
import OpenTrace from '@opentrace/node';

const app = new Hono();
app.use('*', OpenTrace.middleware.hono());
```

## Distributed Tracing

Trace context propagates automatically via W3C `traceparent` headers. Enable outbound HTTP instrumentation to inject trace headers into all outgoing requests:

```typescript
OpenTrace.init({
  endpoint: 'https://opentrace.example.com',
  apiKey: 'key',
  service: 'my-app',
  instrumentHttp: true,
});
```

Manual span tracing with automatic timing:

```typescript
const result = await OpenTrace.trace('fetchUser', async () => {
  return db.query('SELECT * FROM users WHERE id = ?', [userId]);
});
```

Spans support nesting — child spans automatically link to their parent.

## Configuration

```typescript
OpenTrace.init({
  // Required
  endpoint: 'https://opentrace.example.com',
  apiKey: 'your-api-key',
  service: 'my-app',

  // Environment
  environment: 'production',        // default: ''
  hostname: os.hostname(),           // auto-detected
  gitSha: process.env.GIT_SHA,       // auto-detected from REVISION/GIT_SHA/HEROKU_SLUG_COMMIT

  // Batching
  batchSize: 50,                     // entries per flush (default: 50)
  flushInterval: 5000,               // ms between flushes (default: 5000)
  maxPayloadBytes: 256 * 1024,       // max batch size (default: 256KB)

  // Network
  compression: true,                 // gzip payloads (default: true)
  compressionThreshold: 1024,        // min bytes to compress (default: 1024)
  timeout: 5000,                     // HTTP timeout ms (default: 5000)
  maxRetries: 2,                     // retry on 5xx (default: 2)
  retryBaseDelay: 100,               // initial retry delay ms (default: 100)

  // Circuit breaker
  circuitBreakerThreshold: 5,        // failures before OPEN (default: 5)
  circuitBreakerTimeout: 30000,      // ms before HALF_OPEN (default: 30000)

  // Filtering
  minLevel: 'info',                  // log level threshold (default: 'info')
  sampleRate: 1.0,                   // fraction of requests to trace (default: 1.0)
  ignorePaths: ['/health', '/ready', '/live'],

  // Features (all opt-in)
  requestSummary: true,              // aggregate SQL/HTTP per request (default: true)
  instrumentHttp: false,             // auto-instrument outbound HTTP
  instrumentConsole: false,          // capture console.log/warn/error
  runtimeMetrics: false,             // V8 heap/RSS/handles monitoring

  // PII scrubbing (always on, extend with custom patterns)
  extraPiiPatterns: [/CUSTOM_PATTERN/g],

  // Callbacks
  beforeSend: (payload) => payload,  // transform/filter before send (return null to drop)
  context: { tenant: 'acme' },       // static context merged into all entries
});
```

## API Reference

### Lifecycle

| Method | Description |
|---|---|
| `OpenTrace.init(config)` | Initialize with endpoint, apiKey, service |
| `OpenTrace.shutdown(timeoutMs?)` | Flush remaining entries + cleanup (async) |
| `OpenTrace.enabled()` | Check if initialized and active |
| `OpenTrace.enable()` / `.disable()` | Runtime toggle without reinitializing |

### Logging

| Method | Description |
|---|---|
| `OpenTrace.log(level, message, metadata?)` | Log at any level |
| `OpenTrace.debug(message, metadata?)` | Debug-level log |
| `OpenTrace.info(message, metadata?)` | Info-level log |
| `OpenTrace.warn(message, metadata?)` | Warn-level log |
| `OpenTrace.error(err, metadata?)` | Capture Error or string with fingerprint, cause chain, stack |

### Events & Tracing

| Method | Description |
|---|---|
| `OpenTrace.event(eventType, message, metadata?)` | Business event (bypasses level filtering) |
| `OpenTrace.trace(operation, fn)` | Span timing for sync + async functions with nesting |

### Request Context

| Method | Description |
|---|---|
| `OpenTrace.addBreadcrumb({ category?, message, data?, level? })` | Add breadcrumb to current request |
| `OpenTrace.setTransactionName(name)` | Override auto-detected transaction name |
| `OpenTrace.recordSql(name, durationMs, sql?)` | Record SQL query in request summary |
| `OpenTrace.setContext(ctx)` | Set global context merged into all entries |

### Observability

| Method | Description |
|---|---|
| `OpenTrace.stats()` | Counter snapshot: enqueued, delivered, dropped, bytesSent, etc. |
| `OpenTrace.healthy()` | Circuit breaker + auth status check |
| `OpenTrace.flush()` | Manually trigger a flush (async) |

### Middleware

| Method | Description |
|---|---|
| `OpenTrace.middleware.express()` | Express middleware (intercepts `res.end`) |
| `OpenTrace.middleware.fastify()` | Fastify plugin (`onRequest`/`onResponse` hooks) |
| `OpenTrace.middleware.hono()` | Hono middleware (async wrapper) |

## How It Works

```
OpenTrace.log/error/event/trace
    ↓
level filter → enabled check → sample check
    ↓
create DeferredEntry (object literal — ~1μs)
    ↓
Client.enqueue → Array (bounded 1000, drop newest when full)
    ↓
              [setInterval flush timer — unreffed, won't keep process alive]
                        ↓
              PayloadBuilder.materialize(batch)
              (merge contexts, enrich with hostname/pid/gitSha)
                        ↓
              PII scrub → beforeSend filter → fitPayload (truncate)
                        ↓
              JSON.stringify → gzip if > threshold
                        ↓
              HTTP POST with exponential backoff retry
                        ↓
              circuit breaker → rate limit → auth suspension
```

### Payload Truncation Order

When a single entry exceeds `maxPayloadBytes`, fields are removed in this order:
1. `stack_trace`
2. `params`
3. `job_arguments`
4. `sql` (truncated to 200 chars)
5. `exception_message` (truncated to 200 chars)
6. `timeline`
7. Drop entire entry if still too large

### Batch Splitting

When a batch exceeds `maxPayloadBytes`, it's recursively split in half (max depth 5) and sent as separate requests.

## OpenTrace Ecosystem

This is the **Node.js server-side client**. OpenTrace has clients for every layer of your stack:

| Client | Platform | Repo |
|---|---|---|
| **OpenTrace Server** | Go — self-hosted observability | [adham90/opentrace](https://github.com/adham90/opentrace) |
| **@opentrace/node** | Node.js backends | [adham90/opentrace_node](https://github.com/adham90/opentrace_node) |
| **opentrace** (gem) | Ruby / Rails backends | [adham90/opentrace_ruby](https://github.com/adham90/opentrace_ruby) |
| **opentrace.js** | Browser error tracking | [adham90/opentrace_browser](https://github.com/adham90/opentrace_browser) |

All clients send the same JSON payload format to `POST /api/logs`, so the server treats them identically.

## Requirements

- Node.js >= 18
- TypeScript >= 5.0 (if using TypeScript)

## Development

```bash
npm install
npm test                  # vitest (189 tests)
npm run lint              # biome check
npm run typecheck         # tsc --noEmit
npm run build             # tsup (ESM + CJS)
```

Tests use real HTTP servers (`node:http.createServer`) as mock collectors — no mock libraries.

## License

[MIT](LICENSE)
