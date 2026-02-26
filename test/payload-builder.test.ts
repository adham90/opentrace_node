import { describe, it, expect } from 'vitest';
import { materialize, fitPayload } from '../src/payload-builder.js';
import { resolveConfig } from '../src/config.js';
import type { DeferredLog, DeferredError, DeferredEvent, DeferredRequest, Payload } from '../src/types.js';

const config = resolveConfig({
  endpoint: 'http://localhost:8080',
  apiKey: 'test-key',
  service: 'test-svc',
  environment: 'test',
  gitSha: 'abc123',
});

describe('materialize', () => {
  it('materializes a log entry', () => {
    const entry: DeferredLog = {
      kind: 'log',
      ts: new Date('2026-01-15T12:00:00Z').getTime(),
      level: 'info',
      message: 'Hello world',
      metadata: { user_id: 42 },
      context: null,
      requestId: 'req-1',
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      parentSpanId: null,
    };

    const payload = materialize(entry, config);

    expect(payload.timestamp).toBe('2026-01-15T12:00:00.000Z');
    expect(payload.level).toBe('INFO');
    expect(payload.service).toBe('test-svc');
    expect(payload.environment).toBe('test');
    expect(payload.message).toBe('Hello world');
    expect(payload.commit_hash).toBe('abc123');
    expect(payload.request_id).toBe('req-1');
    expect(payload.trace_id).toBe('a'.repeat(32));
    expect(payload.span_id).toBe('b'.repeat(16));
    expect(payload.metadata.user_id).toBe(42);
    expect(payload.metadata.hostname).toBeTruthy();
    expect(payload.metadata.pid).toBe(process.pid);
  });

  it('materializes an error entry', () => {
    const entry: DeferredError = {
      kind: 'error',
      ts: Date.now(),
      message: 'Something broke',
      exceptionClass: 'TypeError',
      stack: 'TypeError: Something broke\n    at foo.js:10:5',
      fingerprint: 'abc123def456',
      causes: [{ className: 'ReferenceError', message: 'x is not defined', stack: '' }],
      metadata: {},
      context: null,
      requestId: null,
      traceId: null,
      spanId: null,
      parentSpanId: null,
    };

    const payload = materialize(entry, config);

    expect(payload.level).toBe('ERROR');
    expect(payload.exception_class).toBe('TypeError');
    expect(payload.error_fingerprint).toBe('abc123def456');
    expect(payload.metadata.stack_trace).toContain('TypeError');
    expect(payload.metadata.exception_causes).toHaveLength(1);
  });

  it('materializes an event entry', () => {
    const entry: DeferredEvent = {
      kind: 'event',
      ts: Date.now(),
      eventType: 'deploy',
      message: 'Deployed v1.2.3',
      metadata: { version: '1.2.3' },
      context: null,
      requestId: null,
      traceId: null,
      spanId: null,
      parentSpanId: null,
    };

    const payload = materialize(entry, config);

    expect(payload.event_type).toBe('deploy');
    expect(payload.message).toBe('Deployed v1.2.3');
    expect(payload.metadata.version).toBe('1.2.3');
  });

  it('materializes a request entry', () => {
    const started = Date.now();
    const entry: DeferredRequest = {
      kind: 'request',
      started,
      finished: started + 150,
      method: 'GET',
      path: '/api/users',
      status: 200,
      controller: 'UsersController',
      action: 'index',
      requestId: 'req-1',
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      parentSpanId: null,
      context: null,
      summary: {
        sqlQueryCount: 3,
        sqlTotalMs: 12.5,
        sqlSlowestMs: 8.0,
        sqlSlowestName: 'SELECT * FROM users',
        nPlusOneWarning: false,
        duplicateQueries: 0,
        worstDuplicateCount: 0,
        httpCount: 0,
        httpTotalMs: 0,
        httpSlowestMs: 0,
        httpSlowestHost: '',
      },
      error: null,
      extra: {},
    };

    const payload = materialize(entry, config);

    expect(payload.level).toBe('INFO');
    expect(payload.message).toContain('GET /api/users 200');
    expect(payload.request_summary?.sqlQueryCount).toBe(3);
    expect(payload.metadata.controller).toBe('UsersController');
    expect(payload.metadata.duration_ms).toBe(150);
  });

  it('sets ERROR level for 5xx requests', () => {
    const started = Date.now();
    const entry: DeferredRequest = {
      kind: 'request',
      started,
      finished: started + 50,
      method: 'POST',
      path: '/api/orders',
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
    expect(payload.level).toBe('ERROR');
  });

  it('sets WARN level for 4xx requests', () => {
    const started = Date.now();
    const entry: DeferredRequest = {
      kind: 'request',
      started,
      finished: started + 20,
      method: 'GET',
      path: '/api/missing',
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
    expect(payload.level).toBe('WARN');
  });

  it('merges context with correct priority', () => {
    const configWithContext = resolveConfig({
      endpoint: 'http://localhost',
      apiKey: 'key',
      service: 'svc',
      context: { tenant: 'acme', source: 'config' },
    });

    const entry: DeferredLog = {
      kind: 'log',
      ts: Date.now(),
      level: 'info',
      message: 'test',
      metadata: { source: 'metadata' },
      context: { tenant: 'override', from_request: true },
      requestId: null,
      traceId: null,
      spanId: null,
      parentSpanId: null,
    };

    const payload = materialize(entry, configWithContext);

    // metadata wins over request context, request context wins over config context
    expect(payload.metadata.source).toBe('metadata');
    expect(payload.metadata.tenant).toBe('override');
    expect(payload.metadata.from_request).toBe(true);
  });
});

describe('fitPayload', () => {
  it('returns payload as-is if within size limit', () => {
    const payload: Payload = {
      timestamp: new Date().toISOString(),
      level: 'INFO',
      service: 'svc',
      message: 'small',
      metadata: {},
    };

    expect(fitPayload(payload, 10000)).toEqual(payload);
  });

  it('removes stack_trace first', () => {
    const payload: Payload = {
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      service: 'svc',
      message: 'err',
      metadata: { stack_trace: 'x'.repeat(5000), important: true },
    };

    const fitted = fitPayload(payload, 200);
    // If removing stack_trace alone isn't enough, further truncation happens
    // But stack_trace should be gone
    if (fitted) {
      expect(fitted.metadata.stack_trace).toBeUndefined();
    }
  });

  it('returns null if payload cannot fit after all truncations', () => {
    const payload: Payload = {
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      service: 'svc',
      message: 'x'.repeat(10000),
      metadata: {},
    };

    // Very small limit that can't fit even the minimal payload
    const fitted = fitPayload(payload, 10);
    expect(fitted).toBeNull();
  });
});
