# @opentrace/node

Async structured log forwarding for Node.js backends. TypeScript port of [`opentrace_ruby`](https://github.com/adham90/opentrace_ruby).

Safety-first: never throws, never blocks, zero runtime dependencies, zero measurable overhead on the hot path.

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
OpenTrace.error(new Error('Payment failed'), { orderId: 'abc-123' });

// Events
OpenTrace.event('deploy', 'Deployed v2.1.0', { commit: 'abc123' });

// Graceful shutdown (flushes pending entries)
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

Each request automatically captures: method, path, status, duration, trace context (W3C traceparent), request ID, and an optional request summary with SQL/HTTP aggregation and N+1 detection.

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

Trace context propagates automatically via W3C `traceparent` headers. Outbound HTTP calls can be instrumented to inject trace headers:

```typescript
OpenTrace.init({
  endpoint: 'https://opentrace.example.com',
  apiKey: 'key',
  service: 'my-app',
  instrumentHttp: true, // auto-instrument http/https.request
});
```

Manual span tracing:

```typescript
const result = await OpenTrace.trace('fetchUser', async () => {
  return db.query('SELECT * FROM users WHERE id = ?', [userId]);
});
```

## Configuration

```typescript
OpenTrace.init({
  // Required
  endpoint: 'https://opentrace.example.com',
  apiKey: 'your-api-key',
  service: 'my-app',

  // Optional
  environment: 'production',        // default: ''
  batchSize: 50,                     // entries per flush (default: 50)
  flushInterval: 5000,               // ms between flushes (default: 5000)
  maxPayloadBytes: 256 * 1024,       // max batch size (default: 256KB)
  compression: true,                 // gzip payloads (default: true)
  timeout: 5000,                     // HTTP timeout ms (default: 5000)
  maxRetries: 2,                     // retry on 5xx (default: 2)
  minLevel: 'info',                  // log level threshold (default: 'info')
  sampleRate: 1.0,                   // fraction of requests to trace (default: 1.0)
  ignorePaths: ['/health', '/ready', '/live'],
  requestSummary: true,              // aggregate SQL/HTTP per request (default: true)
  instrumentHttp: false,             // auto-instrument outbound HTTP (default: false)
  instrumentConsole: false,          // capture console.log/warn/error (default: false)
  runtimeMetrics: false,             // V8 heap/RSS/handles monitoring (default: false)

  // PII scrubbing (always on)
  extraPiiPatterns: [/CUSTOM_PATTERN/g],

  // Callbacks
  beforeSend: (payload) => payload,  // transform/filter before send
  context: { tenant: 'acme' },       // static context merged into all entries
});
```

## API Reference

```typescript
// Lifecycle
OpenTrace.init(config)               // Initialize
OpenTrace.shutdown(timeoutMs?)       // Flush + cleanup
OpenTrace.enabled()                  // Check if active
OpenTrace.enable() / .disable()      // Runtime toggle

// Logging
OpenTrace.log(level, message, metadata?)
OpenTrace.debug(message, metadata?)
OpenTrace.info(message, metadata?)
OpenTrace.warn(message, metadata?)
OpenTrace.error(err: Error | string, metadata?)

// Events & Tracing
OpenTrace.event(eventType, message, metadata?)
OpenTrace.trace(operation, fn)       // Span timing (sync + async)

// Request Context (within middleware)
OpenTrace.addBreadcrumb({ category?, message, data?, level? })
OpenTrace.setTransactionName(name)
OpenTrace.recordSql(name, durationMs, sql?)

// Global Context
OpenTrace.setContext(ctx)            // Merged into all entries

// Observability
OpenTrace.stats()                    // { enqueued, delivered, dropped, ... }
OpenTrace.healthy()                  // Circuit breaker + auth status
OpenTrace.flush()                    // Manual flush

// Middleware
OpenTrace.middleware.express()
OpenTrace.middleware.fastify()
OpenTrace.middleware.hono()
```

## How It Works

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
                    materialize batch → PII scrub → truncate
                              ↓
                    JSON.stringify → gzip → HTTP POST
                              ↓
                    circuit breaker → retry → rate limit handling
```

Key design decisions:

- **Deferred entries**: Object literals queued at ~1μs, serialized only at flush time
- **AsyncLocalStorage**: Per-request context propagation across async boundaries
- **Circuit breaker**: 5 failures → open → 30s cooldown → half-open probe
- **Backpressure sampling**: Queue > 75% → exponential rate reduction (max 1024x)
- **PII scrubbing**: Regex redaction for emails, credit cards, SSNs, phone numbers, bearer tokens, API keys
- **Zero dependencies**: Uses only Node.js built-ins (http, crypto, zlib, async_hooks, v8)

## Requirements

- Node.js >= 18
- TypeScript >= 5.0 (if using TypeScript)

## License

MIT
