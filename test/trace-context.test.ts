import { describe, it, expect } from 'vitest';
import {
  generateTraceId,
  generateSpanId,
  normalizeTraceId,
  parseTraceparent,
  buildTraceparent,
  extractTraceContext,
} from '../src/trace-context.js';

describe('generateTraceId', () => {
  it('returns a 32-char hex string', () => {
    const id = generateTraceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
    expect(ids.size).toBe(100);
  });
});

describe('generateSpanId', () => {
  it('returns a 16-char hex string', () => {
    const id = generateSpanId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('normalizeTraceId', () => {
  it('passes through valid 32-char hex', () => {
    const id = 'a'.repeat(32);
    expect(normalizeTraceId(id)).toBe(id);
  });

  it('strips hyphens from UUIDs', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const expected = '550e8400e29b41d4a716446655440000';
    expect(normalizeTraceId(uuid)).toBe(expected);
  });

  it('pads short IDs with zeros', () => {
    expect(normalizeTraceId('abc')).toBe('abc' + '0'.repeat(29));
  });

  it('truncates long IDs', () => {
    const long = 'a'.repeat(64);
    expect(normalizeTraceId(long)).toBe('a'.repeat(32));
  });

  it('generates new ID for non-hex input', () => {
    const result = normalizeTraceId('not-hex-$$$');
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('parseTraceparent', () => {
  it('parses valid traceparent', () => {
    const traceId = 'a'.repeat(32);
    const parentId = 'b'.repeat(16);
    const result = parseTraceparent(`00-${traceId}-${parentId}-01`);
    expect(result).toEqual({
      traceId,
      parentSpanId: parentId,
      sampled: true,
    });
  });

  it('detects unsampled flag', () => {
    const traceId = 'a'.repeat(32);
    const parentId = 'b'.repeat(16);
    const result = parseTraceparent(`00-${traceId}-${parentId}-00`);
    expect(result?.sampled).toBe(false);
  });

  it('returns null for invalid format', () => {
    expect(parseTraceparent('garbage')).toBeNull();
    expect(parseTraceparent('')).toBeNull();
    expect(parseTraceparent('01-abc-def-00')).toBeNull();
  });
});

describe('buildTraceparent', () => {
  it('builds valid traceparent string', () => {
    const traceId = 'a'.repeat(32);
    const spanId = 'b'.repeat(16);
    expect(buildTraceparent(traceId, spanId)).toBe(`00-${traceId}-${spanId}-01`);
  });

  it('sets flags to 00 when not sampled', () => {
    const traceId = 'a'.repeat(32);
    const spanId = 'b'.repeat(16);
    expect(buildTraceparent(traceId, spanId, false)).toBe(`00-${traceId}-${spanId}-00`);
  });
});

describe('extractTraceContext', () => {
  it('extracts from W3C traceparent header', () => {
    const traceId = 'a'.repeat(32);
    const parentId = 'b'.repeat(16);
    const result = extractTraceContext({
      traceparent: `00-${traceId}-${parentId}-01`,
    });
    expect(result.traceId).toBe(traceId);
    expect(result.parentSpanId).toBe(parentId);
    expect(result.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('falls back to X-Trace-ID', () => {
    const result = extractTraceContext({
      'x-trace-id': 'abc123',
    });
    expect(result.traceId).toBe('abc123' + '0'.repeat(26));
    expect(result.parentSpanId).toBeNull();
  });

  it('falls back to X-Request-ID', () => {
    const result = extractTraceContext({
      'x-request-id': 'req-123',
    });
    expect(result.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.parentSpanId).toBeNull();
  });

  it('generates new context when no headers', () => {
    const result = extractTraceContext({});
    expect(result.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(result.parentSpanId).toBeNull();
  });

  it('prioritizes traceparent over X-Trace-ID', () => {
    const traceId = 'a'.repeat(32);
    const parentId = 'b'.repeat(16);
    const result = extractTraceContext({
      traceparent: `00-${traceId}-${parentId}-01`,
      'x-trace-id': 'c'.repeat(32),
    });
    expect(result.traceId).toBe(traceId);
  });
});
