import { createHash } from 'node:crypto';
import { type OpenTraceConfig, type ResolvedConfig, clearLevelCache, isLevelEnabled, resolveConfig, validateConfig } from './config.js';
import { Client } from './client.js';
import type { DeferredError, DeferredEvent, DeferredLog, ErrorCause } from './types.js';
import type { StatsSnapshot } from './stats.js';

export type { OpenTraceConfig } from './config.js';
export type { LogLevel } from './config.js';
export type { Payload, DeferredEntry, RequestSummary } from './types.js';
export type { StatsSnapshot } from './stats.js';

let initialized = false;
let config: ResolvedConfig | null = null;
let client: Client | null = null;
let enabled = true;
let globalContext: Record<string, unknown> = {};
let beforeExitHandler: (() => void) | null = null;

function debugLog(...args: unknown[]): void {
  if (config?.debug) {
    console.debug('[OpenTrace]', ...args);
  }
}

const OpenTrace = {
  init(options: OpenTraceConfig): void {
    if (initialized) {
      debugLog('Already initialized, ignoring duplicate init()');
      return;
    }

    const error = validateConfig(options);
    if (error) {
      debugLog(`Configuration error: ${error}, OpenTrace disabled`);
      return;
    }

    config = resolveConfig(options);
    client = new Client(config);
    client.start();
    initialized = true;
    enabled = true;

    // Flush on process exit
    beforeExitHandler = () => { client?.flush(); };
    process.on('beforeExit', beforeExitHandler);

    debugLog('Initialized', { endpoint: config.endpoint, service: config.service });
  },

  async shutdown(timeoutMs = 5000): Promise<void> {
    if (!initialized || !client) return;
    if (beforeExitHandler) {
      process.removeListener('beforeExit', beforeExitHandler);
      beforeExitHandler = null;
    }
    await client.shutdown(timeoutMs);
    initialized = false;
    config = null;
    client = null;
    enabled = true;
    globalContext = {};
    clearLevelCache();
    debugLog('Shut down');
  },

  enabled(): boolean {
    return initialized && enabled;
  },

  enable(): void {
    enabled = true;
  },

  disable(): void {
    enabled = false;
  },

  log(level: string, message: string, metadata: Record<string, unknown> = {}): void {
    try {
      if (!initialized || !enabled || !config || !client) return;
      if (!isLevelEnabled(level, config)) return;

      const entry: DeferredLog = {
        kind: 'log',
        ts: Date.now(),
        level,
        message,
        metadata,
        context: resolveContext(),
        requestId: null,
        traceId: null,
        spanId: null,
        parentSpanId: null,
      };

      client.enqueue(entry);
    } catch {
      // Never throw
    }
  },

  debug(message: string, metadata: Record<string, unknown> = {}): void {
    this.log('debug', message, metadata);
  },

  info(message: string, metadata: Record<string, unknown> = {}): void {
    this.log('info', message, metadata);
  },

  warn(message: string, metadata: Record<string, unknown> = {}): void {
    this.log('warn', message, metadata);
  },

  error(err: Error | string, metadata: Record<string, unknown> = {}): void {
    try {
      if (!initialized || !enabled || !config || !client) return;

      const isError = err instanceof Error;
      const message = isError ? err.message : String(err);
      const exceptionClass = isError ? err.name : 'Error';
      const stack = isError ? cleanStack(err.stack ?? '') : '';
      const origin = extractOrigin(stack);
      const fingerprint = computeFingerprint(exceptionClass, origin);
      const causes = isError ? walkCauses(err) : [];

      const entry: DeferredError = {
        kind: 'error',
        ts: Date.now(),
        message,
        exceptionClass,
        stack,
        fingerprint,
        causes,
        metadata,
        context: resolveContext(),
        requestId: null,
        traceId: null,
        spanId: null,
        parentSpanId: null,
      };

      client.enqueue(entry);
    } catch {
      // Never throw
    }
  },

  event(eventType: string, message: string, metadata: Record<string, unknown> = {}): void {
    try {
      if (!initialized || !enabled || !config || !client) return;

      const entry: DeferredEvent = {
        kind: 'event',
        ts: Date.now(),
        eventType,
        message,
        metadata,
        context: resolveContext(),
        requestId: null,
        traceId: null,
        spanId: null,
        parentSpanId: null,
      };

      client.enqueue(entry);
    } catch {
      // Never throw
    }
  },

  setContext(ctx: Record<string, unknown>): void {
    globalContext = { ...globalContext, ...ctx };
  },

  stats(): StatsSnapshot | null {
    return client?.stats.snapshot() ?? null;
  },

  healthy(): boolean {
    return client?.isHealthy ?? false;
  },

  async flush(): Promise<void> {
    await client?.flush();
  },

  /** @internal — exposed for testing */
  _client(): Client | null {
    return client;
  },

  /** @internal — reset for testing */
  _reset(): void {
    initialized = false;
    config = null;
    client = null;
    enabled = true;
    globalContext = {};
    clearLevelCache();
  },
};

function resolveContext(): Record<string, unknown> | null {
  if (Object.keys(globalContext).length === 0) return null;
  return { ...globalContext };
}

function cleanStack(stack: string): string {
  return stack
    .split('\n')
    .filter((line) => !line.includes('node_modules') && !line.includes('node:internal'))
    .join('\n');
}

function extractOrigin(stack: string): string {
  if (!stack) return '';
  const lines = stack.split('\n');
  for (const line of lines) {
    const match = line.match(/at\s+.*?\((.+?):\d+:\d+\)/) ?? line.match(/at\s+(.+?):\d+:\d+/);
    if (match) return match[1];
  }
  return '';
}

function computeFingerprint(exceptionClass: string, origin: string): string {
  return createHash('md5').update(`${exceptionClass}||${origin}`).digest('hex').slice(0, 12);
}

const MAX_CAUSE_DEPTH = 5;

function walkCauses(err: Error): ErrorCause[] {
  const causes: ErrorCause[] = [];
  let current = err.cause;
  let depth = 0;

  while (current instanceof Error && depth < MAX_CAUSE_DEPTH) {
    causes.push({
      className: current.name,
      message: current.message,
      stack: cleanStack(current.stack ?? ''),
    });
    current = current.cause;
    depth++;
  }

  return causes;
}

export default OpenTrace;
