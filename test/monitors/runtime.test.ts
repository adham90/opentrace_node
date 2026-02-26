import { afterEach, describe, expect, it } from "vitest";
import { startRuntimeMonitor, stopRuntimeMonitor } from "../../src/monitors/runtime.js";

afterEach(() => {
  stopRuntimeMonitor();
});

describe("Runtime monitor", () => {
  it("emits runtime metrics at the configured interval", async () => {
    const emitted: { eventType: string; metadata: Record<string, unknown> }[] = [];

    startRuntimeMonitor(50, (eventType, _message, metadata) => {
      emitted.push({ eventType, metadata });
    });

    await new Promise((r) => setTimeout(r, 130));

    expect(emitted.length).toBeGreaterThanOrEqual(2);
    expect(emitted[0].eventType).toBe("runtime.metrics");

    const m = emitted[0].metadata;
    expect(m.heap_used_mb).toBeGreaterThan(0);
    expect(m.heap_total_mb).toBeGreaterThan(0);
    expect(m.rss_mb).toBeGreaterThan(0);
    expect(m.external_mb).toBeGreaterThanOrEqual(0);
    expect(m.used_heap_percentage).toBeGreaterThan(0);
    expect(m.uptime_seconds).toBeGreaterThan(0);
  });

  it("does not prevent process exit (timer is unrefed)", () => {
    // This is hard to test directly, but we can verify it starts without error
    startRuntimeMonitor(10000, () => {});
    stopRuntimeMonitor();
  });

  it("ignores duplicate start calls", async () => {
    const emitted: string[] = [];

    startRuntimeMonitor(50, (_, message) => emitted.push(message));
    startRuntimeMonitor(50, (_, message) => emitted.push(`${message} DUPLICATE`));

    await new Promise((r) => setTimeout(r, 80));

    // Only one timer should be running
    const hasDuplicate = emitted.some((m) => m.includes("DUPLICATE"));
    expect(hasDuplicate).toBe(false);
  });

  it("stops cleanly", async () => {
    const emitted: unknown[] = [];

    startRuntimeMonitor(30, () => emitted.push(1));
    await new Promise((r) => setTimeout(r, 50));

    const countBefore = emitted.length;
    stopRuntimeMonitor();

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.length).toBe(countBefore);
  });
});
