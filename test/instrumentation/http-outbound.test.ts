import http from "node:http";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asyncLocalStorage, createRequestContext } from "../../src/context.js";
import { installHttpTracking, uninstallHttpTracking } from "../../src/instrumentation/http-outbound.js";
import { RequestCollector } from "../../src/request-collector.js";

let targetServer: Server;
let targetPort: number;

beforeEach(async () => {
  targetServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        traceId: req.headers["x-trace-id"],
        requestId: req.headers["x-request-id"],
        traceparent: req.headers.traceparent,
      }),
    );
  });
  await new Promise<void>((r) => targetServer.listen(0, r));
  targetPort = (targetServer.address() as { port: number }).port;
});

afterEach(async () => {
  uninstallHttpTracking();
  await new Promise<void>((r, j) => targetServer.close((e) => (e ? j(e) : r())));
});

function makeRequest(path = "/"): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    // Use http.request (the module property) so our patch is visible
    const req = http.request({ hostname: "127.0.0.1", port: targetPort, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("HTTP outbound tracking", () => {
  it("injects trace headers into outgoing requests", async () => {
    installHttpTracking("http://opentrace.example.com");

    const store = createRequestContext({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      requestId: "req-123",
    });

    const result = await asyncLocalStorage.run(store, () => makeRequest("/api/data"));

    expect(result.body.traceId).toBe("a".repeat(32));
    expect(result.body.requestId).toBe("req-123");
    expect(result.body.traceparent).toContain("a".repeat(32));
  });

  it("records HTTP call in request collector", async () => {
    installHttpTracking("http://opentrace.example.com");

    const collector = new RequestCollector(performance.now());
    const store = createRequestContext({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      collector,
    });

    await asyncLocalStorage.run(store, () => makeRequest("/api/users"));

    const summary = collector.summary();
    expect(summary.httpCount).toBe(1);
    expect(summary.httpTotalMs).toBeGreaterThan(0);
    expect(summary.httpSlowestHost).toBe("127.0.0.1");
  });

  it("works without AsyncLocalStorage context", async () => {
    installHttpTracking("http://opentrace.example.com");

    const result = await makeRequest("/");
    expect(result.status).toBe(200);
    expect(result.body.traceId).toBeUndefined();
  });

  it("skips tracking OpenTrace own requests", async () => {
    installHttpTracking(`http://127.0.0.1:${targetPort}`);

    const collector = new RequestCollector(performance.now());
    const store = createRequestContext({ collector });

    await asyncLocalStorage.run(store, () => makeRequest("/api/logs"));

    expect(collector.summary().httpCount).toBe(0);
  });

  it("restores original methods on uninstall", () => {
    const original = http.request;
    installHttpTracking("http://opentrace.example.com");
    // After install, http.request should be patched
    expect(http.request).not.toBe(original);

    uninstallHttpTracking();
    expect(http.request).toBe(original);
  });
});
