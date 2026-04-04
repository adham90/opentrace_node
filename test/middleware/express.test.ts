import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import OpenTrace from "../../src/index.js";

interface TestServer {
  port: number;
  received: unknown[];
  close: () => Promise<void>;
}

async function startCollector(): Promise<TestServer> {
  const received: unknown[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body =
        req.headers["content-encoding"] === "gzip"
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
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

// Simple HTTP app that uses the middleware
function createApp(middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) {
  return createServer((req, res) => {
    middleware(req, res, () => {
      // Simple router
      if (req.url === "/api/users") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ id: 1 }]));
      } else if (req.url === "/health") {
        res.writeHead(200);
        res.end("ok");
      } else if (req.url === "/error") {
        res.writeHead(500);
        res.end("error");
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
  });
}

function request(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = require("node:http").request({ hostname: "127.0.0.1", port, path, headers }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });
}

let collector: TestServer;
let app: Server;

beforeEach(async () => {
  collector = await startCollector();
  OpenTrace.init({
    endpoint: `http://127.0.0.1:${collector.port}`,
    apiKey: "test-key",
    service: "express-test",
    compression: false,
    flushInterval: 60000,
  });
});

afterEach(async () => {
  await OpenTrace.shutdown();
  OpenTrace._reset();
  await collector.close();
  if (app) await new Promise<void>((r, j) => app.close((e) => (e ? j(e) : r())));
});

describe("Express middleware", () => {
  it("sends request entries to collector", async () => {
    const mw = OpenTrace.middleware.express();
    app = createApp(mw);
    await new Promise<void>((r) => app.listen(0, r));
    const appPort = (app.address() as { port: number }).port;

    await request(appPort, "/api/users");
    await OpenTrace.flush();

    expect(collector.received.length).toBeGreaterThanOrEqual(1);
    const entry = collector.received[0] as Record<string, unknown>;
    expect(entry.message).toContain("GET /api/users 200");
    expect(entry.level).toBe("info");
    expect(entry.service).toBe("express-test");
    expect(entry.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.request_id).toBeTruthy();
  });

  it("includes request_summary with SQL data", async () => {
    const mw = OpenTrace.middleware.express();
    app = createApp((req, res, next) => {
      mw(req, res, () => {
        // Simulate SQL queries during request
        OpenTrace.recordSql("SELECT users", 5.2, "SELECT * FROM users");
        OpenTrace.recordSql("SELECT orders", 3.1, "SELECT * FROM orders");
        next();
      });
    });
    await new Promise<void>((r) => app.listen(0, r));
    const appPort = (app.address() as { port: number }).port;

    await request(appPort, "/api/users");
    await OpenTrace.flush();

    const entry = collector.received.find((e) => (e as Record<string, unknown>).db_count) as Record<
      string,
      unknown
    >;
    expect(entry).toBeDefined();
    expect(entry.db_count).toBe(2);
    const body = entry.body as Record<string, unknown>;
    const perf = body.performance as Record<string, unknown>;
    expect(perf.sql_query_count).toBe(2);
  });

  it("skips ignored paths", async () => {
    const mw = OpenTrace.middleware.express();
    app = createApp(mw);
    await new Promise<void>((r) => app.listen(0, r));
    const appPort = (app.address() as { port: number }).port;

    await request(appPort, "/health");
    await OpenTrace.flush();

    // Only flush entry should be empty — health was ignored
    const requestEntries = collector.received.filter(
      (e) =>
        (e as Record<string, unknown>).message &&
        ((e as Record<string, unknown>).message as string).includes("/health"),
    );
    expect(requestEntries).toHaveLength(0);
  });

  it("uses traceparent from incoming headers", async () => {
    const mw = OpenTrace.middleware.express();
    app = createApp(mw);
    await new Promise<void>((r) => app.listen(0, r));
    const appPort = (app.address() as { port: number }).port;

    const traceId = "a".repeat(32);
    const parentId = "b".repeat(16);
    await request(appPort, "/api/users", {
      traceparent: `00-${traceId}-${parentId}-01`,
    });
    await OpenTrace.flush();

    const entry = collector.received[0] as Record<string, unknown>;
    expect(entry.trace_id).toBe(traceId);
    expect(entry.parent_span_id).toBe(parentId);
  });

  it("reports ERROR level for 5xx responses", async () => {
    const mw = OpenTrace.middleware.express();
    app = createApp(mw);
    await new Promise<void>((r) => app.listen(0, r));
    const appPort = (app.address() as { port: number }).port;

    await request(appPort, "/error");
    await OpenTrace.flush();

    const entry = collector.received[0] as Record<string, unknown>;
    expect(entry.level).toBe("error");
  });

  it("reports WARN level for 4xx responses", async () => {
    const mw = OpenTrace.middleware.express();
    app = createApp(mw);
    await new Promise<void>((r) => app.listen(0, r));
    const appPort = (app.address() as { port: number }).port;

    await request(appPort, "/nonexistent");
    await OpenTrace.flush();

    const entry = collector.received[0] as Record<string, unknown>;
    expect(entry.level).toBe("warn");
  });

  it("does nothing when disabled", async () => {
    OpenTrace.disable();
    const mw = OpenTrace.middleware.express();
    app = createApp(mw);
    await new Promise<void>((r) => app.listen(0, r));
    const appPort = (app.address() as { port: number }).port;

    await request(appPort, "/api/users");
    await OpenTrace.flush();

    expect(collector.received).toHaveLength(0);
  });
});
