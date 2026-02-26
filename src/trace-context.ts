import { randomBytes } from 'node:crypto';

const HEX_RE = /^[0-9a-f]+$/;
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

export function normalizeTraceId(id: string): string {
  const cleaned = id.replace(/-/g, '').toLowerCase();
  if (!HEX_RE.test(cleaned)) return generateTraceId();
  if (cleaned.length >= 32) return cleaned.slice(0, 32);
  return cleaned.padEnd(32, '0');
}

export interface TraceparentInfo {
  traceId: string;
  parentSpanId: string;
  sampled: boolean;
}

export function parseTraceparent(header: string): TraceparentInfo | null {
  const match = header.trim().match(TRACEPARENT_RE);
  if (!match) return null;
  return {
    traceId: match[1],
    parentSpanId: match[2],
    sampled: (Number.parseInt(match[3], 16) & 0x01) === 1,
  };
}

export function buildTraceparent(traceId: string, spanId: string, sampled = true): string {
  const flags = sampled ? '01' : '00';
  return `00-${traceId}-${spanId}-${flags}`;
}

export interface TraceInfo {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
}

export function extractTraceContext(headers: Record<string, string | string[] | undefined>): TraceInfo {
  const spanId = generateSpanId();

  // Priority 1: W3C traceparent
  const traceparent = headerValue(headers, 'traceparent');
  if (traceparent) {
    const parsed = parseTraceparent(traceparent);
    if (parsed) {
      return { traceId: parsed.traceId, spanId, parentSpanId: parsed.parentSpanId };
    }
  }

  // Priority 2: X-Trace-ID
  const xTraceId = headerValue(headers, 'x-trace-id');
  if (xTraceId) {
    return { traceId: normalizeTraceId(xTraceId), spanId, parentSpanId: null };
  }

  // Priority 3: X-Request-ID (normalize to 32-char hex)
  const xRequestId = headerValue(headers, 'x-request-id');
  if (xRequestId) {
    return { traceId: normalizeTraceId(xRequestId), spanId, parentSpanId: null };
  }

  // Fallback: generate new
  return { traceId: generateTraceId(), spanId, parentSpanId: null };
}

function headerValue(headers: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const val = headers[key];
  if (Array.isArray(val)) return val[0];
  return val;
}
