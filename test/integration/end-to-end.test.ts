import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import http from 'node:http';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import OpenTrace from '../../src/index.js';

interface CollectorServer {
  port: number;
  received: Record<string, unknown>[];
  close: () => Promise<void>;
}

async function startCollector(): Promise<CollectorServer> {
  const received: Record<string, unknown>[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body =
        req.headers['content-encoding'] === 'gzip'
          ? JSON.parse(gunzipSync(raw).toString())
          : JSON.parse(raw.toString());
      received.push(...body);
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    received,
    close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
  };
}

function startApp(middleware: Function): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      (middleware as Function)(req, res, () => {
        if (req.url === '/api/users') {
          OpenTrace.recordSql('SELECT users', 5.2, 'SELECT * FROM users WHERE active = true');
          OpenTrace.recordSql('SELECT orders', 3.1, 'SELECT * FROM orders WHERE user_id = 1');
          OpenTrace.addBreadcrumb({ category: 'db', message: 'loaded users' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([{ id: 1, name: 'Alice' }]));
        } else if (req.url === '/api/error') {
          OpenTrace.error(new Error('Something went wrong'), { endpoint: '/api/error' });
          res.writeHead(500);
          res.end('Internal Server Error');
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });
    });
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port });
    });
  });
}

function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    http.request({ hostname: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject).end();
  });
}

let collector: CollectorServer;

beforeEach(async () => {
  collector = await startCollector();
});

afterEach(async () => {
  await OpenTrace.shutdown();
  OpenTrace._reset();
  await collector.close();
});

function initOpenTrace(overrides: Record<string, unknown> = {}) {
  OpenTrace.init({
    endpoint: `http://127.0.0.1:${collector.port}`,
    apiKey: 'e2e-key',
    service: 'e2e-app',
    environment: 'test',
    compression: false,
    flushInterval: 60000,
    ...overrides,
  });
}

describe('End-to-end integration', () => {
  it('full request lifecycle: middleware → SQL tracking → flush → verify payload', async () => {
    initOpenTrace();
    const mw = OpenTrace.middleware.express();
    const { server, port } = await startApp(mw);

    try {
      const status = await httpGet(port, '/api/users');
      expect(status).toBe(200);
      await OpenTrace.flush();

      const requestEntries = collector.received.filter((e) =>
        typeof e.message === 'string' && e.message.includes('GET /api/users'),
      );
      expect(requestEntries.length).toBeGreaterThanOrEqual(1);

      const reqEntry = requestEntries[0];
      expect(reqEntry.level).toBe('INFO');
      expect(reqEntry.service).toBe('e2e-app');
      expect(reqEntry.environment).toBe('test');
      expect(reqEntry.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(reqEntry.request_id).toBeTruthy();

      const summary = reqEntry.request_summary as Record<string, unknown>;
      expect(summary).toBeDefined();
      expect(summary.sqlQueryCount).toBe(2);
    } finally {
      server.close();
    }
  });

  it('error tracking within a request', async () => {
    initOpenTrace();
    const mw = OpenTrace.middleware.express();
    const { server, port } = await startApp(mw);

    try {
      await httpGet(port, '/api/error');
      await OpenTrace.flush();

      const errorEntries = collector.received.filter((e) => e.exception_class === 'Error');
      expect(errorEntries.length).toBeGreaterThanOrEqual(1);

      const errEntry = errorEntries[0];
      expect(errEntry.error_fingerprint).toMatch(/^[0-9a-f]{12}$/);
      expect((errEntry.metadata as Record<string, unknown>).stack_trace).toBeTruthy();

      const reqEntries = collector.received.filter(
        (e) => typeof e.message === 'string' && e.message.includes('GET /api/error 500'),
      );
      expect(reqEntries.length).toBeGreaterThanOrEqual(1);
      expect(reqEntries[0].level).toBe('ERROR');
    } finally {
      server.close();
    }
  });

  it('trace propagation via traceparent header', async () => {
    initOpenTrace();
    const mw = OpenTrace.middleware.express();
    const { server, port } = await startApp(mw);

    try {
      const traceId = 'a'.repeat(32);
      const parentSpanId = 'b'.repeat(16);
      await httpGet(port, '/api/users', {
        traceparent: `00-${traceId}-${parentSpanId}-01`,
      });
      await OpenTrace.flush();

      const reqEntry = collector.received.find(
        (e) => typeof e.message === 'string' && e.message.includes('GET /api/users'),
      );
      expect(reqEntry).toBeDefined();
      expect(reqEntry!.trace_id).toBe(traceId);
      expect(reqEntry!.parent_span_id).toBe(parentSpanId);
    } finally {
      server.close();
    }
  });

  it('shutdown flushes all pending entries', async () => {
    initOpenTrace();

    for (let i = 0; i < 10; i++) {
      OpenTrace.info(`message ${i}`);
    }

    await OpenTrace.shutdown(5000);
    expect(collector.received.length).toBe(10);
  });

  it('stats reflect actual delivery', async () => {
    initOpenTrace();

    OpenTrace.info('one');
    OpenTrace.info('two');
    OpenTrace.info('three');
    await OpenTrace.flush();

    const stats = OpenTrace.stats();
    expect(stats).not.toBeNull();
    expect(stats!.enqueued).toBe(3);
    expect(stats!.delivered).toBe(3);
    expect(stats!.batchesSent).toBe(1);
    expect(stats!.bytesSent).toBeGreaterThan(0);
  });

  it('global context appears in manual log entries', async () => {
    initOpenTrace();

    OpenTrace.setContext({ tenant_id: 'acme', region: 'us-east-1' });
    OpenTrace.info('with context');
    await OpenTrace.flush();

    const entry = collector.received[0];
    const meta = entry.metadata as Record<string, unknown>;
    expect(meta.tenant_id).toBe('acme');
    expect(meta.region).toBe('us-east-1');
  });
});
