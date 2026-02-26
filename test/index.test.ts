import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import OpenTrace from "../src/index.js";

interface TestServer {
  port: number;
  received: unknown[];
  close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
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

let server: TestServer;

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  await OpenTrace.shutdown();
  OpenTrace._reset();
  await server.close();
});

describe("OpenTrace", () => {
  function init(overrides: Record<string, unknown> = {}) {
    OpenTrace.init({
      endpoint: `http://127.0.0.1:${server.port}`,
      apiKey: "test-key",
      service: "test-app",
      compression: false,
      flushInterval: 60000,
      ...overrides,
    });
  }

  describe("init", () => {
    it("marks as enabled after init", () => {
      init();
      expect(OpenTrace.enabled()).toBe(true);
    });

    it("ignores duplicate init calls", () => {
      init();
      init(); // should not throw
      expect(OpenTrace.enabled()).toBe(true);
    });

    it("does not initialize without required fields", () => {
      OpenTrace.init({ endpoint: "", apiKey: "", service: "" });
      expect(OpenTrace.enabled()).toBe(false);
    });
  });

  describe("log", () => {
    it("sends a log entry to the server", async () => {
      init();
      OpenTrace.info("Hello from test", { user_id: 42 });
      await OpenTrace.flush();

      expect(server.received).toHaveLength(1);
      const entry = server.received[0] as Record<string, unknown>;
      expect(entry.level).toBe("INFO");
      expect(entry.message).toBe("Hello from test");
      expect(entry.service).toBe("test-app");
      expect((entry.metadata as Record<string, unknown>).user_id).toBe(42);
    });

    it("filters by minLevel", async () => {
      init({ minLevel: "warn" });

      OpenTrace.debug("dropped");
      OpenTrace.info("dropped");
      OpenTrace.warn("kept");
      OpenTrace.error(new Error("kept"));

      await OpenTrace.flush();

      expect(server.received).toHaveLength(2);
    });

    it("does nothing when disabled", async () => {
      init();
      OpenTrace.disable();
      OpenTrace.info("should not send");
      await OpenTrace.flush();

      expect(server.received).toHaveLength(0);
    });

    it("resumes after re-enable", async () => {
      init();
      OpenTrace.disable();
      OpenTrace.info("dropped");
      OpenTrace.enable();
      OpenTrace.info("sent");
      await OpenTrace.flush();

      expect(server.received).toHaveLength(1);
      expect((server.received[0] as Record<string, unknown>).message).toBe("sent");
    });
  });

  describe("error", () => {
    it("captures Error objects with fingerprint and cause chain", async () => {
      init();
      const cause = new Error("root cause");
      const err = new Error("top error", { cause });
      OpenTrace.error(err);
      await OpenTrace.flush();

      expect(server.received).toHaveLength(1);
      const entry = server.received[0] as Record<string, unknown>;
      expect(entry.level).toBe("ERROR");
      expect(entry.exception_class).toBe("Error");
      expect(entry.error_fingerprint).toMatch(/^[0-9a-f]{12}$/);
      const meta = entry.metadata as Record<string, unknown>;
      expect(meta.stack_trace).toBeTruthy();
      expect(meta.exception_causes).toHaveLength(1);
    });

    it("handles string errors", async () => {
      init();
      OpenTrace.error("something went wrong");
      await OpenTrace.flush();

      const entry = server.received[0] as Record<string, unknown>;
      expect(entry.message).toBe("something went wrong");
      expect(entry.exception_class).toBe("Error");
    });
  });

  describe("event", () => {
    it("sends events with event_type", async () => {
      init();
      OpenTrace.event("deploy", "Deployed v2.0", { version: "2.0" });
      await OpenTrace.flush();

      const entry = server.received[0] as Record<string, unknown>;
      expect(entry.event_type).toBe("deploy");
      expect(entry.message).toBe("Deployed v2.0");
    });
  });

  describe("setContext", () => {
    it("includes global context in all entries", async () => {
      init();
      OpenTrace.setContext({ tenant_id: "acme" });
      OpenTrace.info("with context");
      await OpenTrace.flush();

      const meta = (server.received[0] as Record<string, unknown>).metadata as Record<string, unknown>;
      expect(meta.tenant_id).toBe("acme");
    });

    it("merges context incrementally", async () => {
      init();
      OpenTrace.setContext({ a: 1 });
      OpenTrace.setContext({ b: 2 });
      OpenTrace.info("merged");
      await OpenTrace.flush();

      const meta = (server.received[0] as Record<string, unknown>).metadata as Record<string, unknown>;
      expect(meta.a).toBe(1);
      expect(meta.b).toBe(2);
    });
  });

  describe("stats", () => {
    it("returns null when not initialized", () => {
      expect(OpenTrace.stats()).toBeNull();
    });

    it("returns stats snapshot", () => {
      init();
      OpenTrace.info("test");
      const stats = OpenTrace.stats();
      expect(stats).not.toBeNull();
      expect(stats?.enqueued).toBe(1);
    });
  });

  describe("shutdown", () => {
    it("flushes pending entries", async () => {
      init();
      OpenTrace.info("before shutdown");
      await OpenTrace.shutdown();

      expect(server.received).toHaveLength(1);
    });

    it("marks as not enabled after shutdown", async () => {
      init();
      await OpenTrace.shutdown();
      expect(OpenTrace.enabled()).toBe(false);
    });
  });

  describe("never throws", () => {
    it("log does not throw even if not initialized", () => {
      expect(() => OpenTrace.info("test")).not.toThrow();
    });

    it("error does not throw even if not initialized", () => {
      expect(() => OpenTrace.error(new Error("test"))).not.toThrow();
    });

    it("event does not throw even if not initialized", () => {
      expect(() => OpenTrace.event("type", "msg")).not.toThrow();
    });

    it("flush does not throw even if not initialized", async () => {
      await expect(OpenTrace.flush()).resolves.toBeUndefined();
    });

    it("shutdown does not throw even if not initialized", async () => {
      await expect(OpenTrace.shutdown()).resolves.toBeUndefined();
    });
  });
});
