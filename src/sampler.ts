const MAX_BACKPRESSURE = 10; // 2^10 = 1024x reduction

export class Sampler {
  private backpressure = 0;

  constructor(
    private readonly baseSampleRate: number,
    private readonly customSampler?: (req: unknown) => number,
  ) {}

  sample(req?: unknown): boolean {
    const rate = this.effectiveRate(req);
    if (rate >= 1.0) return true;
    if (rate <= 0) return false;
    return Math.random() < rate;
  }

  effectiveRate(req?: unknown): number {
    const base = this.customSampler && req != null ? this.customSampler(req) : this.baseSampleRate;
    if (this.backpressure === 0) return base;
    return base / (1 << this.backpressure);
  }

  adjustBackpressure(queueSize: number, maxQueueSize: number): void {
    const ratio = queueSize / maxQueueSize;
    if (ratio > 0.75) {
      this.increaseBackpressure();
    } else if (ratio < 0.25) {
      this.decreaseBackpressure();
    }
  }

  private increaseBackpressure(): void {
    if (this.backpressure < MAX_BACKPRESSURE) {
      this.backpressure++;
    }
  }

  private decreaseBackpressure(): void {
    if (this.backpressure > 0) {
      this.backpressure--;
    }
  }

  get currentBackpressure(): number {
    return this.backpressure;
  }

  reset(): void {
    this.backpressure = 0;
  }
}
