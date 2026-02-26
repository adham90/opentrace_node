import { AsyncLocalStorage } from "node:async_hooks";
import { BreadcrumbBuffer } from "./breadcrumbs.js";
import type { RequestCollector } from "./request-collector.js";

export interface RequestContext {
  requestId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  transactionName: string | null;
  sqlCount: number;
  sqlTotalMs: number;
  breadcrumbs: BreadcrumbBuffer;
  collector: RequestCollector | null;
  cachedContext: Record<string, unknown> | null;
  sessionId: string | null;
  memoryBefore: number | null;
}

export const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}

export function createRequestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: "",
    traceId: "",
    spanId: "",
    parentSpanId: null,
    transactionName: null,
    sqlCount: 0,
    sqlTotalMs: 0,
    breadcrumbs: new BreadcrumbBuffer(),
    collector: null,
    cachedContext: null,
    sessionId: null,
    memoryBefore: null,
    ...overrides,
  };
}
