import { fingerprint as sqlFingerprint } from "./sql-normalizer.js";
import type { RequestSummary, TimelineEvent } from "./types.js";

const MAX_FINGERPRINTS = 100;
const N_PLUS_ONE_THRESHOLD = 20;
const DUPLICATE_THRESHOLD = 5;

export class RequestCollector {
  sqlCount = 0;
  sqlTotalMs = 0;
  sqlSlowestMs = 0;
  sqlSlowestName = "";

  httpCount = 0;
  httpTotalMs = 0;
  httpSlowestMs = 0;
  httpSlowestHost = "";

  private sqlFingerprints = new Map<string, number>();
  private timeline: TimelineEvent[] = [];
  private requestStart: number;
  private timelineEnabled: boolean;
  private timelineMaxEvents: number;

  constructor(requestStart: number, timelineEnabled = false, timelineMaxEvents = 200) {
    this.requestStart = requestStart;
    this.timelineEnabled = timelineEnabled;
    this.timelineMaxEvents = timelineMaxEvents;
  }

  recordSql(name: string, durationMs: number, sql?: string): void {
    this.sqlCount++;
    this.sqlTotalMs += durationMs;

    if (durationMs > this.sqlSlowestMs) {
      this.sqlSlowestMs = durationMs;
      this.sqlSlowestName = name;
    }

    if (sql && this.sqlFingerprints.size < MAX_FINGERPRINTS) {
      const fp = sqlFingerprint(sql);
      this.sqlFingerprints.set(fp, (this.sqlFingerprints.get(fp) ?? 0) + 1);
    }

    if (this.timelineEnabled && this.timeline.length < this.timelineMaxEvents) {
      this.timeline.push({
        t: "sql",
        n: name,
        ms: Math.round(durationMs * 100) / 100,
        at: Math.round((performance.now() - this.requestStart) * 100) / 100,
      });
    }
  }

  recordHttp(method: string, host: string, status: number, durationMs: number): void {
    this.httpCount++;
    this.httpTotalMs += durationMs;

    if (durationMs > this.httpSlowestMs) {
      this.httpSlowestMs = durationMs;
      this.httpSlowestHost = host;
    }

    if (this.timelineEnabled && this.timeline.length < this.timelineMaxEvents) {
      this.timeline.push({
        t: "http",
        n: `${method} ${host}`,
        ms: Math.round(durationMs * 100) / 100,
        s: status,
        at: Math.round((performance.now() - this.requestStart) * 100) / 100,
      });
    }
  }

  recordSpan(name: string, durationMs: number): void {
    if (this.timelineEnabled && this.timeline.length < this.timelineMaxEvents) {
      this.timeline.push({
        t: "span",
        n: name,
        ms: Math.round(durationMs * 100) / 100,
        at: Math.round((performance.now() - this.requestStart) * 100) / 100,
      });
    }
  }

  summary(): RequestSummary {
    let duplicateQueries = 0;
    let worstDuplicateCount = 0;

    for (const count of this.sqlFingerprints.values()) {
      if (count > 1) {
        duplicateQueries++;
        if (count > worstDuplicateCount) {
          worstDuplicateCount = count;
        }
      }
    }

    const result: RequestSummary = {
      sqlQueryCount: this.sqlCount,
      sqlTotalMs: Math.round(this.sqlTotalMs * 100) / 100,
      sqlSlowestMs: Math.round(this.sqlSlowestMs * 100) / 100,
      sqlSlowestName: this.sqlSlowestName,
      nPlusOneWarning: this.sqlCount > N_PLUS_ONE_THRESHOLD || worstDuplicateCount > DUPLICATE_THRESHOLD,
      duplicateQueries,
      worstDuplicateCount,
      httpCount: this.httpCount,
      httpTotalMs: Math.round(this.httpTotalMs * 100) / 100,
      httpSlowestMs: Math.round(this.httpSlowestMs * 100) / 100,
      httpSlowestHost: this.httpSlowestHost,
    };

    if (this.timelineEnabled && this.timeline.length > 0) {
      result.timeline = [...this.timeline];
    }

    return result;
  }
}
