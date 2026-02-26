import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "../src/client.js";
import { resolveConfig } from "../src/config.js";
import type { DeferredLog } from "../src/types.js";

function makeEntry(overrides: Partial<DeferredLog> = {}): DeferredLog {
  return {
    kind: "log",
    ts: Date.now(),
    level: "info",
    message: "test message",
    metadata: {},
    context: null,
    requestId: null,
    traceId: null,
    spanId: null,
    parentSpanId: null,
    ...overrides,
  };
}

interface TestServer {
  server: Server;
  port: number;
  received: { body: unknown; headers: Record<string, string | string[] | undefined> }[];
  respondWith: (status: number, headers?: Record<string, string>) => void;
  close: () => Promise<void>;
}

async function createTestServer(): Promise<TestServer> {
  let responseStatus = 200;
  let responseHeaders: Record<string, string> = {};

  const received: TestServer["received"] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: unknown;
      const raw = Buffer.concat(chunks);

      if (req.headers["content-encoding"] === "gzip") {
        body = JSON.parse(gunzipSync(raw).toString("utf8"));
      } else {
        body = JSON.parse(raw.toString("utf8"));
      }

      received.push({ body, headers: req.headers });

      for (const [k, v] of Object.entries(responseHeaders)) {
        res.setHeader(k, v);
      }
      res.writeHead(responseStatus);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  return {
    server,
    port,
    received,
    respondWith(status: number, headers: Record<string, string> = {}) {
      responseStatus = status;
      responseHeaders = headers;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function makeClient(port: number, overrides: Record<string, unknown> = {}): Client {
  const config = resolveConfig({
    endpoint: `http://127.0.0.1:${port}`,
    apiKey: "test-key",
    service: "test-svc",
    flushInterval: 60000, // manual flush in tests
    compression: false,
    maxRetries: 0,
    ...overrides,
  });
  const client = new Client(config);
  client.start();
  return client;
}

let testServer: TestServer | null = null;
let testClient: Client | null = null;

afterEach(async () => {
  if (testClient?.isRunning) await testClient.shutdown(1000);
  testClient = null;
  if (testServer) await testServer.close();
  testServer = null;
});

describe("Client", () => {
  it("enqueues and flushes entries to the server", async () => {
    testServer = await createTestServer();
    testClient = makeClient(testServer.port);

    testClient.enqueue(makeEntry({ message: "hello" }));
    testClient.enqueue(makeEntry({ message: "world" }));

    await testClient.flush();

    expect(testServer.received).toHaveLength(1);
    const batch = testServer.received[0].body as unknown[];
    expect(batch).toHaveLength(2);
    expect((batch[0] as Record<string, unknown>).message).toBe("hello");
    expect((batch[1] as Record<string, unknown>).message).toBe("world");
  });

  it("sends correct headers", async () => {
    testServer = await createTestServer();
    testClient = makeClient(testServer.port);

    testClient.enqueue(makeEntry());
    await testClient.flush();

    const headers = testServer.received[0].headers;
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["user-agent"]).toContain("@opentrace-sdk/node");
  });

  it("compresses payloads when enabled and above threshold", async () => {
    testServer = await createTestServer();
    testClient = makeClient(testServer.port, {
      compression: true,
      compressionThreshold: 10,
    });

    testClient.enqueue(makeEntry({ message: "a".repeat(200) }));
    await testClient.flush();

    expect(testServer.received).toHaveLength(1);
    // Server handler decompresses, so we can check the headers
    const headers = testServer.received[0].headers;
    expect(headers["content-encoding"]).toBe("gzip");
  });

  it("tracks stats correctly", async () => {
    testServer = await createTestServer();
    testClient = makeClient(testServer.port);

    testClient.enqueue(makeEntry());
    testClient.enqueue(makeEntry());
    await testClient.flush();

    const stats = testClient.stats.snapshot();
    expect(stats.enqueued).toBe(2);
    expect(stats.delivered).toBe(2);
    expect(stats.batchesSent).toBe(1);
    expect(stats.bytesSent).toBeGreaterThan(0);
  });

  it("drops entries when queue is full", async () => {
    testServer = await createTestServer();
    testClient = makeClient(testServer.port);

    // Fill the queue past capacity (1000)
    for (let i = 0; i < 1010; i++) {
      testClient.enqueue(makeEntry());
    }

    expect(testClient.queueSize).toBe(1000);
    expect(testClient.stats.droppedQueueFull).toBe(10);
  });

  it("does not enqueue after shutdown", async () => {
    testServer = await createTestServer();
    testClient = makeClient(testServer.port);

    await testClient.shutdown();
    testClient.enqueue(makeEntry());

    expect(testClient.queueSize).toBe(0);
  });

  it("handles server errors gracefully", async () => {
    testServer = await createTestServer();
    testServer.respondWith(500);
    testClient = makeClient(testServer.port, { maxRetries: 0 });

    testClient.enqueue(makeEntry());
    await testClient.flush();

    const stats = testClient.stats.snapshot();
    expect(stats.delivered).toBe(0);
    expect(stats.droppedError).toBe(1);
  });

  it("suspends on 401 auth failure", async () => {
    testServer = await createTestServer();
    testServer.respondWith(401);
    testClient = makeClient(testServer.port);

    testClient.enqueue(makeEntry());
    await testClient.flush();

    expect(testClient.stats.authFailures).toBe(1);
    expect(testClient.isHealthy).toBe(false);
  });

  it("handles rate limiting (429)", async () => {
    testServer = await createTestServer();
    testServer.respondWith(429);
    testClient = makeClient(testServer.port);

    testClient.enqueue(makeEntry());
    await testClient.flush();

    expect(testClient.stats.rateLimited).toBe(1);
  });

  it("respects beforeSend filter", async () => {
    testServer = await createTestServer();
    const config = resolveConfig({
      endpoint: `http://127.0.0.1:${testServer.port}`,
      apiKey: "test-key",
      service: "test-svc",
      flushInterval: 60000,
      compression: false,
      maxRetries: 0,
      beforeSend: (payload) => {
        if ((payload as Record<string, unknown>).message === "drop me") return null;
        return payload;
      },
    });
    testClient = new Client(config);
    testClient.start();

    testClient.enqueue(makeEntry({ message: "drop me" }));
    testClient.enqueue(makeEntry({ message: "keep me" }));
    await testClient.flush();

    expect(testServer.received).toHaveLength(1);
    const batch = testServer.received[0].body as unknown[];
    expect(batch).toHaveLength(1);
    expect((batch[0] as Record<string, unknown>).message).toBe("keep me");
    expect(testClient.stats.droppedFiltered).toBe(1);
  });

  it("flushes remaining entries on shutdown", async () => {
    testServer = await createTestServer();
    testClient = makeClient(testServer.port);

    for (let i = 0; i < 5; i++) {
      testClient.enqueue(makeEntry({ message: `msg-${i}` }));
    }

    await testClient.shutdown(5000);

    const allEntries = testServer.received.flatMap((r) => r.body as unknown[]);
    expect(allEntries).toHaveLength(5);
  });

  it("splits oversized batches", async () => {
    testServer = await createTestServer();
    testClient = makeClient(testServer.port, {
      batchSize: 100,
      maxPayloadBytes: 500, // very small — forces splitting
    });

    for (let i = 0; i < 10; i++) {
      testClient.enqueue(makeEntry({ message: `message-${i}-${"x".repeat(50)}` }));
    }
    await testClient.flush();

    // Should have received multiple smaller batches
    expect(testServer.received.length).toBeGreaterThan(1);
    const totalEntries = testServer.received.reduce((sum, r) => sum + (r.body as unknown[]).length, 0);
    expect(totalEntries).toBe(10);
  });
});
