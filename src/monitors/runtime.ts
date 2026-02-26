import v8 from 'node:v8';

interface RuntimeMetricsEmitter {
  (eventType: string, message: string, metadata: Record<string, unknown>): void;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startRuntimeMonitor(intervalMs: number, emit: RuntimeMetricsEmitter): void {
  if (timer) return;

  timer = setInterval(() => {
    try {
      const mem = process.memoryUsage();
      const heap = v8.getHeapStatistics();

      const metrics: Record<string, unknown> = {
        heap_used_mb: round(mem.heapUsed / 1024 / 1024),
        heap_total_mb: round(mem.heapTotal / 1024 / 1024),
        rss_mb: round(mem.rss / 1024 / 1024),
        external_mb: round(mem.external / 1024 / 1024),
        array_buffers_mb: round(mem.arrayBuffers / 1024 / 1024),
        heap_size_limit_mb: round(heap.heap_size_limit / 1024 / 1024),
        used_heap_percentage: round((heap.used_heap_size / heap.heap_size_limit) * 100),
        uptime_seconds: round(process.uptime()),
      };

      // Active handles/requests (useful for leak detection)
      // biome-ignore lint/suspicious/noExplicitAny: accessing undocumented Node.js process internals
      const proc = process as any;
      if (typeof proc._getActiveHandles === 'function') {
        metrics.active_handles = proc._getActiveHandles().length;
      }
      if (typeof proc._getActiveRequests === 'function') {
        metrics.active_requests = proc._getActiveRequests().length;
      }

      emit('runtime.metrics', 'Runtime metrics', metrics);
    } catch {
      // Never throw from monitor
    }
  }, intervalMs);

  timer.unref();
}

export function stopRuntimeMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
