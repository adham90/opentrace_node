import { describe, expect, it } from "vitest";
import { asyncLocalStorage, createRequestContext, getContext } from "../src/context.js";

describe("AsyncLocalStorage context", () => {
  it("returns undefined outside of a context", () => {
    expect(getContext()).toBeUndefined();
  });

  it("provides context within asyncLocalStorage.run", () => {
    const store = createRequestContext({ requestId: "req-1", traceId: "abc" });

    asyncLocalStorage.run(store, () => {
      const ctx = getContext();
      expect(ctx).toBeDefined();
      expect(ctx?.requestId).toBe("req-1");
      expect(ctx?.traceId).toBe("abc");
    });
  });

  it("isolates contexts between concurrent runs", async () => {
    const results: string[] = [];

    const run1 = asyncLocalStorage.run(createRequestContext({ requestId: "a" }), async () => {
      await new Promise((r) => setTimeout(r, 10));
      results.push(getContext()?.requestId);
    });

    const run2 = asyncLocalStorage.run(createRequestContext({ requestId: "b" }), async () => {
      results.push(getContext()?.requestId);
    });

    await Promise.all([run1, run2]);
    expect(results).toContain("a");
    expect(results).toContain("b");
  });

  it("propagates context across async boundaries", async () => {
    await asyncLocalStorage.run(createRequestContext({ requestId: "async-test" }), async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(getContext()?.requestId).toBe("async-test");

      await Promise.resolve().then(() => {
        expect(getContext()?.requestId).toBe("async-test");
      });
    });
  });

  it("creates context with sensible defaults", () => {
    const ctx = createRequestContext();
    expect(ctx.requestId).toBe("");
    expect(ctx.sqlCount).toBe(0);
    expect(ctx.sqlTotalMs).toBe(0);
    expect(ctx.breadcrumbs.length).toBe(0);
    expect(ctx.collector).toBeNull();
    expect(ctx.transactionName).toBeNull();
  });
});
