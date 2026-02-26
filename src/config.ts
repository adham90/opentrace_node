import { hostname } from "node:os";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface OpenTraceConfig {
  // Required
  endpoint: string;
  apiKey: string;
  service: string;

  // Identity
  environment?: string;
  hostname?: string;
  gitSha?: string;

  // Batching & Transport
  batchSize?: number;
  flushInterval?: number;
  maxPayloadBytes?: number;
  compression?: boolean;
  compressionThreshold?: number;
  timeout?: number;
  transport?: "http" | "unix_socket";
  socketPath?: string;

  // Retry & Resilience
  maxRetries?: number;
  retryBaseDelay?: number;
  retryMaxDelay?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerTimeout?: number;

  // Filtering & Sampling
  minLevel?: LogLevel;
  allowedLevels?: LogLevel[] | null;
  sampleRate?: number;
  sampler?: (req: unknown) => number;
  ignorePaths?: string[];

  // Instrumentation (all opt-in)
  requestSummary?: boolean;
  sqlLogging?: boolean;
  httpTracking?: boolean;
  consoleCapture?: boolean;
  timeline?: boolean;
  timelineMaxEvents?: number;
  memoryTracking?: boolean;

  // Data Protection
  piiScrubbing?: boolean;
  piiPatterns?: RegExp[];
  beforeSend?: (payload: Record<string, unknown>) => Record<string, unknown> | null;
  onError?: (err: Error, meta: Record<string, unknown>) => void;
  afterSend?: (batchSize: number, bytes: number) => void;
  onDrop?: (count: number, reason: string) => void;

  // Context
  context?: (() => Record<string, unknown>) | Record<string, unknown>;

  // Monitors
  runtimeMetrics?: boolean;
  runtimeMetricsInterval?: number;

  // Debug
  debug?: boolean;
}

export interface ResolvedConfig {
  endpoint: string;
  apiKey: string;
  service: string;
  environment: string;
  hostname: string;
  pid: number;
  gitSha: string;
  batchSize: number;
  flushInterval: number;
  maxPayloadBytes: number;
  compression: boolean;
  compressionThreshold: number;
  timeout: number;
  transport: "http" | "unix_socket";
  socketPath: string;
  maxRetries: number;
  retryBaseDelay: number;
  retryMaxDelay: number;
  circuitBreakerThreshold: number;
  circuitBreakerTimeout: number;
  minLevel: LogLevel;
  allowedLevels: LogLevel[] | null;
  sampleRate: number;
  sampler: ((req: unknown) => number) | null;
  ignorePaths: string[];
  requestSummary: boolean;
  sqlLogging: boolean;
  httpTracking: boolean;
  consoleCapture: boolean;
  timeline: boolean;
  timelineMaxEvents: number;
  memoryTracking: boolean;
  piiScrubbing: boolean;
  piiPatterns: RegExp[];
  beforeSend: ((payload: Record<string, unknown>) => Record<string, unknown> | null) | null;
  onError: ((err: Error, meta: Record<string, unknown>) => void) | null;
  afterSend: ((batchSize: number, bytes: number) => void) | null;
  onDrop: ((count: number, reason: string) => void) | null;
  context: (() => Record<string, unknown>) | Record<string, unknown> | null;
  runtimeMetrics: boolean;
  runtimeMetricsInterval: number;
  debug: boolean;
}

export function resolveConfig(input: OpenTraceConfig): ResolvedConfig {
  return {
    endpoint: input.endpoint.replace(/\/+$/, ""),
    apiKey: input.apiKey,
    service: input.service,
    environment: input.environment ?? "",
    hostname: input.hostname ?? hostname(),
    pid: process.pid,
    gitSha: input.gitSha ?? process.env.REVISION ?? process.env.GIT_SHA ?? process.env.HEROKU_SLUG_COMMIT ?? "",
    batchSize: input.batchSize ?? 50,
    flushInterval: input.flushInterval ?? 5000,
    maxPayloadBytes: input.maxPayloadBytes ?? 256 * 1024,
    compression: input.compression ?? true,
    compressionThreshold: input.compressionThreshold ?? 1024,
    timeout: input.timeout ?? 5000,
    transport: input.transport ?? "http",
    socketPath: input.socketPath ?? "/tmp/opentrace.sock",
    maxRetries: input.maxRetries ?? 2,
    retryBaseDelay: input.retryBaseDelay ?? 100,
    retryMaxDelay: input.retryMaxDelay ?? 2000,
    circuitBreakerThreshold: input.circuitBreakerThreshold ?? 5,
    circuitBreakerTimeout: input.circuitBreakerTimeout ?? 30000,
    minLevel: input.minLevel ?? "info",
    allowedLevels: input.allowedLevels ?? null,
    sampleRate: input.sampleRate ?? 1.0,
    sampler: input.sampler ?? null,
    ignorePaths: input.ignorePaths ?? ["/health", "/ready", "/live"],
    requestSummary: input.requestSummary ?? true,
    sqlLogging: input.sqlLogging ?? false,
    httpTracking: input.httpTracking ?? false,
    consoleCapture: input.consoleCapture ?? false,
    timeline: input.timeline ?? false,
    timelineMaxEvents: input.timelineMaxEvents ?? 200,
    memoryTracking: input.memoryTracking ?? false,
    piiScrubbing: input.piiScrubbing ?? false,
    piiPatterns: input.piiPatterns ?? [],
    beforeSend: input.beforeSend ?? null,
    onError: input.onError ?? null,
    afterSend: input.afterSend ?? null,
    onDrop: input.onDrop ?? null,
    context: input.context ?? null,
    runtimeMetrics: input.runtimeMetrics ?? false,
    runtimeMetricsInterval: input.runtimeMetricsInterval ?? 30000,
    debug: input.debug ?? false,
  };
}

export function validateConfig(config: OpenTraceConfig): string | null {
  if (!config.endpoint) return "endpoint is required";
  if (!config.apiKey) return "apiKey is required";
  if (!config.service) return "service is required";
  return null;
}

const levelCache = new Map<string, boolean>();

export function isLevelEnabled(level: string, config: ResolvedConfig): boolean {
  const cacheKey = `${level}:${config.minLevel}:${config.allowedLevels?.join(",")}`;
  const cached = levelCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const normalized = level.toLowerCase() as LogLevel;
  let enabled: boolean;

  if (config.allowedLevels) {
    enabled = config.allowedLevels.includes(normalized);
  } else {
    const levelValue = LEVEL_VALUES[normalized];
    const minValue = LEVEL_VALUES[config.minLevel];
    enabled = levelValue !== undefined && levelValue >= minValue;
  }

  levelCache.set(cacheKey, enabled);
  return enabled;
}

export function clearLevelCache(): void {
  levelCache.clear();
}
