import { describe, expect, it } from "vitest";
import { RequestCollector } from "../src/request-collector.js";

describe("RequestCollector", () => {
  it("starts with zero counts", () => {
    const rc = new RequestCollector(performance.now());
    const summary = rc.summary();
    expect(summary.sqlQueryCount).toBe(0);
    expect(summary.sqlTotalMs).toBe(0);
    expect(summary.httpCount).toBe(0);
    expect(summary.nPlusOneWarning).toBe(false);
  });

  describe("SQL tracking", () => {
    it("records SQL queries", () => {
      const rc = new RequestCollector(performance.now());
      rc.recordSql("SELECT users", 5.2, "SELECT * FROM users WHERE id = 1");
      rc.recordSql("SELECT orders", 12.8, "SELECT * FROM orders WHERE user_id = 1");

      const summary = rc.summary();
      expect(summary.sqlQueryCount).toBe(2);
      expect(summary.sqlTotalMs).toBeCloseTo(18.0, 0);
      expect(summary.sqlSlowestMs).toBeCloseTo(12.8, 0);
      expect(summary.sqlSlowestName).toBe("SELECT orders");
    });

    it("detects N+1 queries (> 20 queries)", () => {
      const rc = new RequestCollector(performance.now());
      for (let i = 0; i < 25; i++) {
        rc.recordSql(`query-${i}`, 1, `SELECT * FROM items WHERE id = ${i}`);
      }

      expect(rc.summary().nPlusOneWarning).toBe(true);
    });

    it("detects duplicate queries", () => {
      const rc = new RequestCollector(performance.now());
      // Same structure, different literals — same fingerprint
      for (let i = 0; i < 8; i++) {
        rc.recordSql("find_user", 1, `SELECT * FROM users WHERE id = ${i}`);
      }
      rc.recordSql("find_order", 1, "SELECT * FROM orders WHERE id = 1");

      const summary = rc.summary();
      expect(summary.duplicateQueries).toBe(1); // users query is duplicated
      expect(summary.worstDuplicateCount).toBe(8);
      expect(summary.nPlusOneWarning).toBe(true); // > 5 duplicates
    });
  });

  describe("HTTP tracking", () => {
    it("records outbound HTTP calls", () => {
      const rc = new RequestCollector(performance.now());
      rc.recordHttp("GET", "api.stripe.com", 200, 250.5);
      rc.recordHttp("POST", "api.sendgrid.com", 202, 180.3);

      const summary = rc.summary();
      expect(summary.httpCount).toBe(2);
      expect(summary.httpTotalMs).toBeCloseTo(430.8, 0);
      expect(summary.httpSlowestMs).toBeCloseTo(250.5, 0);
      expect(summary.httpSlowestHost).toBe("api.stripe.com");
    });
  });

  describe("timeline", () => {
    it("does not include timeline when disabled", () => {
      const rc = new RequestCollector(performance.now(), false);
      rc.recordSql("query", 5, "SELECT 1");
      expect(rc.summary().timeline).toBeUndefined();
    });

    it("includes timeline events when enabled", () => {
      const rc = new RequestCollector(performance.now(), true);
      rc.recordSql("query", 5.2, "SELECT 1");
      rc.recordHttp("GET", "api.example.com", 200, 150);
      rc.recordSpan("pdf.generate", 500);

      const summary = rc.summary();
      expect(summary.timeline).toHaveLength(3);
      expect(summary.timeline?.[0].t).toBe("sql");
      expect(summary.timeline?.[1].t).toBe("http");
      expect(summary.timeline?.[2].t).toBe("span");
    });

    it("caps timeline at maxEvents", () => {
      const rc = new RequestCollector(performance.now(), true, 5);
      for (let i = 0; i < 10; i++) {
        rc.recordSql(`query-${i}`, 1, `SELECT ${i}`);
      }
      expect(rc.summary().timeline).toHaveLength(5);
    });
  });
});
