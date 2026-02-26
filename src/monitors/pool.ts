export interface PoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

export type PoolStatsProvider = () => PoolStats | null;

type PoolMetricsEmitter = (eventType: string, message: string, metadata: Record<string, unknown>) => void;

let timer: ReturnType<typeof setInterval> | null = null;

export function startPoolMonitor(intervalMs: number, provider: PoolStatsProvider, emit: PoolMetricsEmitter): void {
  if (timer) return;

  timer = setInterval(() => {
    try {
      const stats = provider();
      if (!stats) return;

      const level = stats.waitingCount > 0 ? "warn" : "debug";
      const metadata: Record<string, unknown> = {
        pool_total: stats.totalCount,
        pool_idle: stats.idleCount,
        pool_waiting: stats.waitingCount,
        pool_busy: stats.totalCount - stats.idleCount,
        level,
      };

      emit("pool.stats", "Connection pool stats", metadata);
    } catch {
      // Never throw from monitor
    }
  }, intervalMs);

  timer.unref();
}

export function stopPoolMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
