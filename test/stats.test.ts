import { describe, expect, it } from "vitest";
import { Stats } from "../src/stats.js";

describe("Stats", () => {
  it("starts with all counters at zero", () => {
    const stats = new Stats();
    const snap = stats.snapshot();
    expect(snap.enqueued).toBe(0);
    expect(snap.delivered).toBe(0);
    expect(snap.droppedQueueFull).toBe(0);
    expect(snap.batchesSent).toBe(0);
    expect(snap.bytesSent).toBe(0);
  });

  it("tracks uptime", async () => {
    const stats = new Stats();
    await new Promise((r) => setTimeout(r, 50));
    const snap = stats.snapshot();
    expect(snap.uptimeSeconds).toBeGreaterThan(0);
  });

  it("increments counters", () => {
    const stats = new Stats();
    stats.enqueued += 10;
    stats.delivered += 8;
    stats.droppedQueueFull += 2;

    const snap = stats.snapshot();
    expect(snap.enqueued).toBe(10);
    expect(snap.delivered).toBe(8);
    expect(snap.droppedQueueFull).toBe(2);
  });

  it("resets all counters", () => {
    const stats = new Stats();
    stats.enqueued += 100;
    stats.delivered += 50;
    stats.retries += 3;

    stats.reset();
    const snap = stats.snapshot();
    expect(snap.enqueued).toBe(0);
    expect(snap.delivered).toBe(0);
    expect(snap.retries).toBe(0);
  });

  it("snapshot returns a plain object (not the stats instance)", () => {
    const stats = new Stats();
    stats.enqueued = 5;
    const snap = stats.snapshot();

    // Mutating snapshot doesn't affect stats
    snap.enqueued = 999;
    expect(stats.enqueued).toBe(5);
  });
});
