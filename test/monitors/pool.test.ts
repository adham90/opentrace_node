import { describe, it, expect, afterEach } from 'vitest';
import { startPoolMonitor, stopPoolMonitor } from '../../src/monitors/pool.js';

afterEach(() => {
  stopPoolMonitor();
});

describe('Pool monitor', () => {
  it('emits pool stats from the provider', async () => {
    const emitted: { eventType: string; metadata: Record<string, unknown> }[] = [];

    const provider = () => ({ totalCount: 10, idleCount: 7, waitingCount: 0 });

    startPoolMonitor(50, provider, (eventType, _message, metadata) => {
      emitted.push({ eventType, metadata });
    });

    await new Promise((r) => setTimeout(r, 80));

    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted[0].eventType).toBe('pool.stats');
    expect(emitted[0].metadata.pool_total).toBe(10);
    expect(emitted[0].metadata.pool_idle).toBe(7);
    expect(emitted[0].metadata.pool_busy).toBe(3);
    expect(emitted[0].metadata.pool_waiting).toBe(0);
    expect(emitted[0].metadata.level).toBe('debug');
  });

  it('reports warn level when threads are waiting', async () => {
    const emitted: { metadata: Record<string, unknown> }[] = [];

    const provider = () => ({ totalCount: 5, idleCount: 0, waitingCount: 3 });

    startPoolMonitor(50, provider, (_eventType, _message, metadata) => {
      emitted.push({ metadata });
    });

    await new Promise((r) => setTimeout(r, 80));

    expect(emitted[0].metadata.level).toBe('warn');
    expect(emitted[0].metadata.pool_waiting).toBe(3);
  });

  it('skips emission when provider returns null', async () => {
    const emitted: unknown[] = [];

    startPoolMonitor(50, () => null, () => emitted.push(1));

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted).toHaveLength(0);
  });

  it('stops cleanly', async () => {
    const emitted: unknown[] = [];

    startPoolMonitor(30, () => ({ totalCount: 1, idleCount: 1, waitingCount: 0 }), () => emitted.push(1));
    await new Promise((r) => setTimeout(r, 50));

    const countBefore = emitted.length;
    stopPoolMonitor();

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.length).toBe(countBefore);
  });
});
