import { describe, it, expect } from 'vitest';
import { Sampler } from '../src/sampler.js';

describe('Sampler', () => {
  it('always samples when rate is 1.0', () => {
    const sampler = new Sampler(1.0);
    for (let i = 0; i < 100; i++) {
      expect(sampler.sample()).toBe(true);
    }
  });

  it('never samples when rate is 0', () => {
    const sampler = new Sampler(0);
    for (let i = 0; i < 100; i++) {
      expect(sampler.sample()).toBe(false);
    }
  });

  it('samples approximately at the configured rate', () => {
    const sampler = new Sampler(0.5);
    let sampled = 0;
    const iterations = 10000;

    for (let i = 0; i < iterations; i++) {
      if (sampler.sample()) sampled++;
    }

    const rate = sampled / iterations;
    // Allow 5% tolerance
    expect(rate).toBeGreaterThan(0.45);
    expect(rate).toBeLessThan(0.55);
  });

  it('uses custom sampler function when provided', () => {
    const custom = (req: unknown) => (req as { path: string }).path === '/health' ? 0 : 1.0;
    const sampler = new Sampler(1.0, custom);

    expect(sampler.sample({ path: '/health' })).toBe(false);
    expect(sampler.sample({ path: '/api/users' })).toBe(true);
  });

  it('falls back to base rate when no request given to custom sampler', () => {
    const custom = () => 0;
    const sampler = new Sampler(1.0, custom);
    // Without req argument, custom sampler is not called
    expect(sampler.sample()).toBe(true);
  });

  describe('backpressure', () => {
    it('starts with zero backpressure', () => {
      const sampler = new Sampler(1.0);
      expect(sampler.currentBackpressure).toBe(0);
    });

    it('increases backpressure when queue is > 75% full', () => {
      const sampler = new Sampler(1.0);
      sampler.adjustBackpressure(800, 1000);
      expect(sampler.currentBackpressure).toBe(1);
    });

    it('decreases backpressure when queue is < 25% full', () => {
      const sampler = new Sampler(1.0);
      // Increase first
      sampler.adjustBackpressure(800, 1000);
      sampler.adjustBackpressure(800, 1000);
      expect(sampler.currentBackpressure).toBe(2);

      // Decrease
      sampler.adjustBackpressure(100, 1000);
      expect(sampler.currentBackpressure).toBe(1);
    });

    it('does not change backpressure when queue is between 25-75%', () => {
      const sampler = new Sampler(1.0);
      sampler.adjustBackpressure(800, 1000); // increase to 1
      sampler.adjustBackpressure(500, 1000); // no change
      expect(sampler.currentBackpressure).toBe(1);
    });

    it('caps backpressure at 10', () => {
      const sampler = new Sampler(1.0);
      for (let i = 0; i < 20; i++) {
        sampler.adjustBackpressure(900, 1000);
      }
      expect(sampler.currentBackpressure).toBe(10);
    });

    it('reduces effective rate exponentially with backpressure', () => {
      const sampler = new Sampler(1.0);
      expect(sampler.effectiveRate()).toBe(1.0);

      sampler.adjustBackpressure(800, 1000); // backpressure = 1
      expect(sampler.effectiveRate()).toBe(0.5);

      sampler.adjustBackpressure(800, 1000); // backpressure = 2
      expect(sampler.effectiveRate()).toBe(0.25);
    });

    it('reset clears backpressure', () => {
      const sampler = new Sampler(1.0);
      sampler.adjustBackpressure(800, 1000);
      sampler.adjustBackpressure(800, 1000);
      sampler.reset();
      expect(sampler.currentBackpressure).toBe(0);
      expect(sampler.effectiveRate()).toBe(1.0);
    });
  });
});
