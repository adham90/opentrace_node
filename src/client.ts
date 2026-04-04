import { randomUUID } from "node:crypto";
import { type RequestOptions, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { gzipSync } from "node:zlib";
import { CircuitBreaker } from "./circuit-breaker.js";
import type { ResolvedConfig } from "./config.js";
import { fitPayload, materialize } from "./payload-builder.js";
import { scrub } from "./pii-scrubber.js";
import { Sampler } from "./sampler.js";
import { Stats } from "./stats.js";
import type { DeferredEntry, Payload } from "./types.js";

const MAX_QUEUE_SIZE = 1000;
const MAX_SPLIT_DEPTH = 5;

export class Client {
  readonly stats = new Stats();
  readonly sampler: Sampler;

  private queue: DeferredEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private circuitBreaker: CircuitBreaker;
  private rateLimitUntil = 0;
  private authSuspended = false;
  private running = false;
  private pid = process.pid;

  constructor(private config: ResolvedConfig) {
    this.circuitBreaker = new CircuitBreaker(config.circuitBreakerThreshold, config.circuitBreakerTimeout);
    this.sampler = new Sampler(config.sampleRate, config.sampler ?? undefined);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.flush(), this.config.flushInterval);
    this.timer.unref();
  }

  enqueue(entry: DeferredEntry): void {
    if (!this.running) return;
    this.checkFork();

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.stats.droppedQueueFull++;
      this.config.onDrop?.(1, "queue_full");
      return;
    }

    this.queue.push(entry);
    this.stats.enqueued++;
    this.sampler.adjustBackpressure(this.queue.length, MAX_QUEUE_SIZE);
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.config.batchSize);
    if (batch.length === 0) return;

    const payloads = this.materializeBatch(batch);
    if (payloads.length === 0) return;

    await this.sendBatch(payloads, 0);
  }

  async shutdown(timeoutMs = 5000): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Flush remaining in batches with a deadline
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length > 0 && Date.now() < deadline) {
      await this.flush();
    }

    if (this.queue.length > 0) {
      const dropped = this.queue.length;
      this.stats.droppedError += dropped;
      this.config.onDrop?.(dropped, "shutdown_timeout");
      this.queue = [];
    }
  }

  get queueSize(): number {
    return this.queue.length;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isHealthy(): boolean {
    return this.circuitBreaker.allowRequest() && !this.authSuspended;
  }

  private materializeBatch(entries: DeferredEntry[]): Payload[] {
    const payloads: Payload[] = [];
    for (const entry of entries) {
      try {
        let payload = materialize(entry, this.config);

        if (this.config.piiScrubbing) {
          payload = scrub(payload, this.config.piiPatterns) as Payload;
        }

        if (this.config.beforeSend) {
          const filtered = this.config.beforeSend(payload as unknown as Record<string, unknown>);
          if (!filtered) {
            this.stats.droppedFiltered++;
            continue;
          }
          payload = filtered as unknown as Payload;
        }

        const fitted = fitPayload(payload, this.config.maxPayloadBytes);
        if (fitted) {
          payloads.push(fitted);
        } else {
          this.stats.droppedError++;
        }
      } catch {
        this.stats.droppedError++;
      }
    }
    return payloads;
  }

  private async sendBatch(payloads: Payload[], depth: number): Promise<void> {
    if (payloads.length === 0) return;

    if (this.authSuspended) {
      this.stats.droppedAuthSuspended += payloads.length;
      return;
    }

    if (!this.circuitBreaker.allowRequest()) {
      this.stats.droppedCircuitOpen += payloads.length;
      return;
    }

    if (Date.now() < this.rateLimitUntil) {
      this.stats.rateLimited++;
      // Re-enqueue if space
      for (const p of payloads) {
        if (this.queue.length < MAX_QUEUE_SIZE) {
          this.queue.push({
            kind: "log",
            ts: Date.now(),
            level: "info",
            message: "",
            metadata: p as unknown as Record<string, unknown>,
            context: null,
            requestId: null,
            traceId: null,
            spanId: null,
            parentSpanId: null,
          });
        }
      }
      return;
    }

    const json = JSON.stringify(payloads);
    const bytes = Buffer.byteLength(json, "utf8");

    // Split if too large
    if (bytes > this.config.maxPayloadBytes && payloads.length > 1 && depth < MAX_SPLIT_DEPTH) {
      const mid = Math.floor(payloads.length / 2);
      await this.sendBatch(payloads.slice(0, mid), depth + 1);
      await this.sendBatch(payloads.slice(mid), depth + 1);
      return;
    }

    await this.sendWithRetry(json, bytes, payloads.length);
  }

  private async sendWithRetry(json: string, bytes: number, count: number): Promise<void> {
    let body: Buffer | string = json;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
      "User-Agent": "@opentrace-sdk/node 0.1.0",
      "X-Batch-ID": randomUUID(),
    };

    if (this.config.compression && bytes > this.config.compressionThreshold) {
      body = gzipSync(json);
      headers["Content-Encoding"] = "gzip";
    }

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        this.stats.retries++;
        const delay = Math.min(
          this.config.retryBaseDelay * 2 ** (attempt - 1) + Math.random() * 50,
          this.config.retryMaxDelay,
        );
        await sleep(delay);
      }

      try {
        const status = await this.httpPost(body, headers);
        if (status >= 200 && status < 300) {
          this.circuitBreaker.recordSuccess();
          this.stats.delivered += count;
          this.stats.batchesSent++;
          this.stats.bytesSent += typeof body === "string" ? Buffer.byteLength(body) : body.length;
          this.config.afterSend?.(count, bytes);
          return;
        }

        if (status === 401 || status === 403) {
          this.authSuspended = true;
          this.stats.authFailures++;
          this.stats.droppedAuthSuspended += count;
          return;
        }

        if (status === 429) {
          this.rateLimitUntil = Date.now() + 5000;
          this.stats.rateLimited++;
          // Don't retry on rate limit, will be picked up next flush
          return;
        }

        // Server error — retry
        if (status >= 500) {
          this.circuitBreaker.recordFailure();
          continue;
        }

        // 4xx other than 401/403/429 — drop
        this.stats.droppedError += count;
        return;
      } catch {
        this.circuitBreaker.recordFailure();
      }
    }

    // All retries exhausted
    this.stats.droppedError += count;
  }

  private httpPost(body: Buffer | string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.config.endpoint}/api/v2/logs`);
      const isHttps = url.protocol === "https:";
      const reqFn = isHttps ? httpsRequest : httpRequest;

      const options: RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": typeof body === "string" ? Buffer.byteLength(body) : body.length,
        },
        timeout: this.config.timeout,
      };

      if (this.config.transport === "unix_socket") {
        options.socketPath = this.config.socketPath;
      }

      const req = reqFn(options, (res) => {
        // Consume response body to free socket
        res.resume();
        resolve(res.statusCode ?? 0);
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });

      req.end(body);
    });
  }

  private checkFork(): void {
    if (process.pid !== this.pid) {
      this.pid = process.pid;
      this.queue = [];
      this.circuitBreaker.reset();
      this.stats.reset();
      this.rateLimitUntil = 0;
      this.authSuspended = false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
