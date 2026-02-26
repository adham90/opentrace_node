import { beforeEach, describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker(3, 1000);
  });

  it("starts in closed state", () => {
    expect(cb.currentState).toBe("closed");
    expect(cb.allowRequest()).toBe(true);
  });

  it("stays closed when failures are below threshold", () => {
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe("closed");
    expect(cb.allowRequest()).toBe(true);
  });

  it("opens after reaching failure threshold", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe("open");
    expect(cb.allowRequest()).toBe(false);
  });

  it("transitions from open to half_open after timeout", () => {
    const cb = new CircuitBreaker(1, 50);
    cb.recordFailure();
    expect(cb.currentState).toBe("open");

    // Wait for timeout
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cb.currentState).toBe("half_open");
        expect(cb.allowRequest()).toBe(true);
        resolve();
      }, 60);
    });
  });

  it("closes on success after half_open", async () => {
    const cb = new CircuitBreaker(1, 50);
    cb.recordFailure();

    await new Promise((r) => setTimeout(r, 60));
    expect(cb.currentState).toBe("half_open");

    cb.recordSuccess();
    expect(cb.currentState).toBe("closed");
    expect(cb.allowRequest()).toBe(true);
  });

  it("reopens on failure in half_open state", async () => {
    const cb = new CircuitBreaker(1, 50);
    cb.recordFailure();

    await new Promise((r) => setTimeout(r, 60));
    expect(cb.currentState).toBe("half_open");

    cb.recordFailure();
    expect(cb.currentState).toBe("open");
  });

  it("resets failure count on success", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    // After success, count resets — so one more failure shouldn't open
    cb.recordFailure();
    expect(cb.currentState).toBe("closed");
  });

  it("reset() returns to initial state", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe("open");

    cb.reset();
    expect(cb.currentState).toBe("closed");
    expect(cb.allowRequest()).toBe(true);
  });
});
