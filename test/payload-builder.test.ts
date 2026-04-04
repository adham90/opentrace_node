import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { fitPayload, materialize } from "../src/payload-builder.js";
import type { DeferredError, DeferredEvent, DeferredLog, DeferredRequest, Payload } from "../src/types.js";

const config = resolveConfig({
  endpoint: "http://localhost:8080",
  apiKey: "test-key",
  service: "test-svc",
  environment: "test",
  gitSha: "abc123",
});

describe("materialize", () => {
  it("materializes a log entry", () => {
    const entry: DeferredLog = {
      kind: "log",
      ts: new Date("2026-01-15T12:00:00Z").getTime(),
      level: "info",
      message: "Hello world",
      metadata: { user_id: 42 },
      context: null,
      requestId: "req-1",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      parentSpanId: null,
    };

    const payload = materialize(entry, config);

    expect(payload.ts).toBe("2026-01-15T12:00:00.000Z");
    expect(payload.level).toBe("info");
    expect(payload.service).toBe("test-svc");
    expect(payload.env).toBe("test");
    expect(payload.message).toBe("Hello world");
    expect(payload.version).toBe("abc123");
    expect(payload.request_id).toBe("req-1");
    expect(payload.trace_id).toBe("a".repeat(32));
    expect(payload.span_id).toBe("b".repeat(16));
    expect(payload.user_id).toBe("42");
    expect(payload.body?.context).toBeDefined();
    expect((payload.body?.context as Record<string, unknown>).hostname).toBeTruthy();
    expect((payload.body?.context as Record<string, unknown>).pid).toBe(process.pid);
  });

  it("materializes an error entry", () => {
    const entry: DeferredError = {
      kind: "error",
      ts: Date.now(),
      message: "Something broke",
      exceptionClass: "TypeError",
      stack: "TypeError: Something broke\n    at foo.js:10:5",
      fingerprint: "abc123def456",
      causes: [{ className: "ReferenceError", message: "x is not defined", stack: "" }],
      metadata: {},
      context: null,
      requestId: null,
      traceId: null,
      spanId: null,
      parentSpanId: null,
    };

    const payload = materialize(entry, config);

    expect(payload.level).toBe("error");
    expect(payload.exception_class).toBe("TypeError");
    expect(payload.error_fingerprint).toBe("abc123def456");
    const exception = payload.body?.exception as Record<string, unknown>;
    expect(exception).toBeDefined();
    expect(exception.stack).toContain("TypeError");
    expect(exception.causes).toHaveLength(1);
  });

  it("materializes an event entry", () => {
    const entry: DeferredEvent = {
      kind: "event",
      ts: Date.now(),
      eventType: "deploy",
      message: "Deployed v1.2.3",
      metadata: { version: "1.2.3" },
      context: null,
      requestId: null,
      traceId: null,
      spanId: null,
      parentSpanId: null,
    };

    const payload = materialize(entry, config);

    expect(payload.event_type).toBe("deploy");
    expect(payload.message).toBe("Deployed v1.2.3");
    expect((payload.body?.context as Record<string, unknown>).version).toBe("1.2.3");
  });

  it("materializes a request entry", () => {
    const started = Date.now();
    const entry: DeferredRequest = {
      kind: "request",
      started,
      finished: started + 150,
      method: "GET",
      path: "/api/users",
      status: 200,
      controller: "UsersController",
      action: "index",
      requestId: "req-1",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      parentSpanId: null,
      context: null,
      summary: {
        sqlQueryCount: 3,
        sqlTotalMs: 12.5,
        sqlSlowestMs: 8.0,
        sqlSlowestName: "SELECT * FROM users",
        nPlusOneWarning: false,
        duplicateQueries: 0,
        worstDuplicateCount: 0,
        httpCount: 0,
        httpTotalMs: 0,
        httpSlowestMs: 0,
        httpSlowestHost: "",
      },
      error: null,
      extra: {},
    };

    const payload = materialize(entry, config);

    expect(payload.level).toBe("info");
    expect(payload.message).toContain("GET /api/users 200");
    expect(payload.event_type).toBe("http.request");
    expect(payload.method).toBe("GET");
    expect(payload.path).toBe("/api/users");
    expect(payload.status).toBe(200);
    expect(payload.duration_ms).toBe(150);
    expect(payload.controller).toBe("UsersController");
    expect(payload.action).toBe("index");
    expect(payload.db_count).toBe(3);
    expect(payload.db_ms).toBe(12.5);
    expect(payload.n_plus_one).toBe(false);
    expect(payload.dup_queries).toBe(0);
    expect(payload.body?.performance).toBeDefined();
  });

  it("sets error level for 5xx requests", () => {
    const started = Date.now();
    const entry: DeferredRequest = {
      kind: "request",
      started,
      finished: started + 50,
      method: "POST",
      path: "/api/orders",
      status: 500,
      controller: null,
      action: null,
      requestId: null,
      traceId: null,
      spanId: null,
      parentSpanId: null,
      context: null,
      summary: null,
      error: null,
      extra: {},
    };

    const payload = materialize(entry, config);
    expect(payload.level).toBe("error");
  });

  it("sets warn level for 4xx requests", () => {
    const started = Date.now();
    const entry: DeferredRequest = {
      kind: "request",
      started,
      finished: started + 20,
      method: "GET",
      path: "/api/missing",
      status: 404,
      controller: null,
      action: null,
      requestId: null,
      traceId: null,
      spanId: null,
      parentSpanId: null,
      context: null,
      summary: null,
      error: null,
      extra: {},
    };

    const payload = materialize(entry, config);
    expect(payload.level).toBe("warn");
  });

  it("merges context with correct priority", () => {
    const configWithContext = resolveConfig({
      endpoint: "http://localhost",
      apiKey: "key",
      service: "svc",
      context: { tenant: "acme", source: "config" },
    });

    const entry: DeferredLog = {
      kind: "log",
      ts: Date.now(),
      level: "info",
      message: "test",
      metadata: { source: "metadata" },
      context: { tenant: "override", from_request: true },
      requestId: null,
      traceId: null,
      spanId: null,
      parentSpanId: null,
    };

    const payload = materialize(entry, configWithContext);

    // metadata wins over request context, request context wins over config context
    const ctx = payload.body?.context as Record<string, unknown>;
    expect(ctx.source).toBe("metadata");
    expect(ctx.tenant).toBe("override");
    expect(ctx.from_request).toBe(true);
  });
});

describe("fitPayload", () => {
  it("returns payload as-is if within size limit", () => {
    const payload: Payload = {
      ts: new Date().toISOString(),
      level: "info",
      service: "svc",
      message: "small",
    };

    expect(fitPayload(payload, 10000)).toEqual(payload);
  });

  it("removes exception stack first", () => {
    const payload: Payload = {
      ts: new Date().toISOString(),
      level: "error",
      service: "svc",
      message: "err",
      body: {
        exception: { class: "Error", stack: "x".repeat(5000) },
        context: { important: true },
      },
    };

    const fitted = fitPayload(payload, 200);
    // If removing stack alone isn't enough, further truncation happens
    // But the exception stack should be gone
    if (fitted) {
      const ex = fitted.body?.exception as Record<string, unknown> | undefined;
      expect(ex?.stack).toBeUndefined();
    }
  });

  it("returns null if payload cannot fit after all truncations", () => {
    const payload: Payload = {
      ts: new Date().toISOString(),
      level: "error",
      service: "svc",
      message: "x".repeat(10000),
    };

    // Very small limit that can't fit even the minimal payload
    const fitted = fitPayload(payload, 10);
    expect(fitted).toBeNull();
  });
});
