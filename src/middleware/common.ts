import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { type TraceInfo, extractTraceContext } from "../trace-context.js";

export interface RequestInfo {
  method: string;
  path: string;
  requestId: string;
}

export function extractRequestInfo(req: IncomingMessage): RequestInfo {
  const url = req.url ?? "/";
  const queryIndex = url.indexOf("?");
  const path = queryIndex >= 0 ? url.slice(0, queryIndex) : url;

  const requestId =
    headerValue(req.headers, "x-request-id") ?? headerValue(req.headers, "x-request-id") ?? randomUUID();

  return {
    method: req.method ?? "GET",
    path,
    requestId,
  };
}

export function extractTraceInfo(req: IncomingMessage): TraceInfo {
  return extractTraceContext(req.headers as Record<string, string | string[] | undefined>);
}

export function isIgnoredPath(path: string, ignorePaths: string[]): boolean {
  return ignorePaths.some((p) => path === p || path.startsWith(`${p}/`));
}

function headerValue(headers: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const val = headers[key];
  if (Array.isArray(val)) return val[0];
  return val;
}
