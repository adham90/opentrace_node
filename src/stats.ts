export interface StatsSnapshot {
  enqueued: number;
  delivered: number;
  droppedQueueFull: number;
  droppedCircuitOpen: number;
  droppedAuthSuspended: number;
  droppedError: number;
  droppedFiltered: number;
  retries: number;
  rateLimited: number;
  authFailures: number;
  batchesSent: number;
  bytesSent: number;
  sampledOut: number;
  uptimeSeconds: number;
}

export class Stats {
  enqueued = 0;
  delivered = 0;
  droppedQueueFull = 0;
  droppedCircuitOpen = 0;
  droppedAuthSuspended = 0;
  droppedError = 0;
  droppedFiltered = 0;
  retries = 0;
  rateLimited = 0;
  authFailures = 0;
  batchesSent = 0;
  bytesSent = 0;
  sampledOut = 0;

  private startedAt = Date.now();

  snapshot(): StatsSnapshot {
    return {
      enqueued: this.enqueued,
      delivered: this.delivered,
      droppedQueueFull: this.droppedQueueFull,
      droppedCircuitOpen: this.droppedCircuitOpen,
      droppedAuthSuspended: this.droppedAuthSuspended,
      droppedError: this.droppedError,
      droppedFiltered: this.droppedFiltered,
      retries: this.retries,
      rateLimited: this.rateLimited,
      authFailures: this.authFailures,
      batchesSent: this.batchesSent,
      bytesSent: this.bytesSent,
      sampledOut: this.sampledOut,
      uptimeSeconds: (Date.now() - this.startedAt) / 1000,
    };
  }

  reset(): void {
    this.enqueued = 0;
    this.delivered = 0;
    this.droppedQueueFull = 0;
    this.droppedCircuitOpen = 0;
    this.droppedAuthSuspended = 0;
    this.droppedError = 0;
    this.droppedFiltered = 0;
    this.retries = 0;
    this.rateLimited = 0;
    this.authFailures = 0;
    this.batchesSent = 0;
    this.bytesSent = 0;
    this.sampledOut = 0;
    this.startedAt = Date.now();
  }
}
