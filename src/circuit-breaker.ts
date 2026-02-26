export type CircuitState = "closed" | "open" | "half_open";

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureTime = 0;

  constructor(
    private readonly threshold: number,
    private readonly timeoutMs: number,
  ) {}

  get currentState(): CircuitState {
    if (this.state === "open" && Date.now() - this.lastFailureTime >= this.timeoutMs) {
      this.state = "half_open";
    }
    return this.state;
  }

  allowRequest(): boolean {
    const state = this.currentState;
    return state === "closed" || state === "half_open";
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.threshold) {
      this.state = "open";
    }
  }

  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }
}
