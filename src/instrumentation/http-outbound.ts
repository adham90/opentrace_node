import http from 'node:http';
import https from 'node:https';
import { getContext } from '../context.js';
import { buildTraceparent } from '../trace-context.js';

let installed = false;
let originalHttpRequest: typeof http.request | null = null;
let originalHttpsRequest: typeof https.request | null = null;
let ownEndpoint = '';

export function installHttpTracking(endpoint: string): void {
  if (installed) return;
  installed = true;
  ownEndpoint = endpoint;

  originalHttpRequest = http.request;
  originalHttpsRequest = https.request;

  // biome-ignore lint/suspicious/noExplicitAny: must match Node.js overloaded http.request signature
  http.request = function patchedHttpRequest(...args: any[]) {
    return wrapRequest(originalHttpRequest!, args);
  } as typeof http.request;

  // biome-ignore lint/suspicious/noExplicitAny: must match Node.js overloaded https.request signature
  https.request = function patchedHttpsRequest(...args: any[]) {
    return wrapRequest(originalHttpsRequest!, args);
  } as typeof https.request;
}

export function uninstallHttpTracking(): void {
  if (!installed) return;
  installed = false;
  if (originalHttpRequest) http.request = originalHttpRequest;
  if (originalHttpsRequest) https.request = originalHttpsRequest;
  originalHttpRequest = null;
  originalHttpsRequest = null;
}

// biome-ignore lint/suspicious/noExplicitAny: wrapping native overloaded function
function wrapRequest(original: (...args: any[]) => http.ClientRequest, args: any[]): http.ClientRequest {
  const ctx = getContext();

  // Parse the first argument to figure out host/path
  const options = parseOptions(args[0]);

  // Skip tracking OpenTrace's own requests
  if (isOwnRequest(options)) {
    return original.apply(null, args);
  }

  // Inject trace headers if we have context
  if (ctx) {
    const headers = options.headers ?? {};
    if (ctx.traceId) headers['x-trace-id'] = ctx.traceId;
    if (ctx.requestId) headers['x-request-id'] = ctx.requestId;
    if (ctx.traceId && ctx.spanId) {
      headers.traceparent = buildTraceparent(ctx.traceId, ctx.spanId);
    }

    // Mutate options if it's an object
    if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof URL)) {
      args[0].headers = { ...args[0].headers, ...headers };
    }
  }

  const start = performance.now();
  const method = options.method ?? 'GET';
  const host = options.hostname ?? options.host ?? 'unknown';

  const req = original.apply(null, args);

  req.on('response', (res: http.IncomingMessage) => {
    const durationMs = performance.now() - start;
    if (ctx?.collector) {
      ctx.collector.recordHttp(method, host, res.statusCode ?? 0, durationMs);
    }
  });

  req.on('error', () => {
    const durationMs = performance.now() - start;
    if (ctx?.collector) {
      ctx.collector.recordHttp(method, host, 0, durationMs);
    }
  });

  return req;
}

interface ParsedOptions {
  hostname?: string;
  host?: string;
  method?: string;
  headers?: Record<string, string>;
}

// biome-ignore lint/suspicious/noExplicitAny: parsing flexible Node.js http.request arguments
function parseOptions(first: any): ParsedOptions {
  if (typeof first === 'string') {
    try {
      const url = new URL(first);
      return { hostname: url.hostname, method: 'GET' };
    } catch {
      return {};
    }
  }
  if (first instanceof URL) {
    return { hostname: first.hostname, method: 'GET' };
  }
  return first ?? {};
}

function isOwnRequest(options: ParsedOptions): boolean {
  if (!ownEndpoint) return false;
  try {
    const url = new URL(ownEndpoint);
    const host = options.hostname ?? options.host ?? '';
    return host === url.hostname;
  } catch {
    return false;
  }
}
