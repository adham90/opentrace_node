import { describe, it, expect } from 'vitest';
import { scrub } from '../src/pii-scrubber.js';

describe('scrub', () => {
  it('returns null/undefined as-is', () => {
    expect(scrub(null)).toBeNull();
    expect(scrub(undefined)).toBeUndefined();
  });

  it('returns numbers and booleans as-is', () => {
    expect(scrub(42)).toBe(42);
    expect(scrub(true)).toBe(true);
  });

  describe('string patterns', () => {
    it('redacts email addresses', () => {
      expect(scrub('contact user@example.com for info')).toBe('contact [REDACTED] for info');
    });

    it('redacts credit card numbers', () => {
      expect(scrub('card: 4111 1111 1111 1111')).toBe('card: [REDACTED]');
    });

    it('redacts SSNs', () => {
      expect(scrub('SSN: 123-45-6789')).toBe('SSN: [REDACTED]');
    });

    it('redacts phone numbers', () => {
      expect(scrub('call (555) 123-4567')).toBe('call [REDACTED]');
    });

    it('redacts bearer tokens', () => {
      expect(scrub('Authorization: Bearer eyJhbGciOiJI')).toBe('Authorization: [REDACTED]');
    });

    it('redacts API keys', () => {
      expect(scrub('key is sk_live_abcdefghijklmnopqrst')).toBe('key is [REDACTED]');
    });
  });

  describe('object keys', () => {
    it('redacts sensitive keys', () => {
      const result = scrub({ password: 'secret123', username: 'alice' });
      expect(result).toEqual({ password: '[REDACTED]', username: 'alice' });
    });

    it('redacts nested sensitive keys', () => {
      const result = scrub({
        user: {
          name: 'Alice',
          auth_token: 'tok_abc',
        },
      });
      expect(result).toEqual({
        user: {
          name: 'Alice',
          auth_token: '[REDACTED]',
        },
      });
    });

    it('handles key matching case-insensitively', () => {
      const result = scrub({ PASSWORD: 'secret', ApiKey: 'key' });
      // Our implementation lowercases for comparison
      expect(result).toEqual({ PASSWORD: '[REDACTED]', ApiKey: '[REDACTED]' });
    });
  });

  describe('arrays', () => {
    it('scrubs each element', () => {
      const result = scrub(['user@example.com', 'normal text']);
      expect(result).toEqual(['[REDACTED]', 'normal text']);
    });
  });

  describe('extra patterns', () => {
    it('applies custom regex patterns', () => {
      const result = scrub('order ORD-12345 placed', [/ORD-\d+/g]);
      expect(result).toBe('order [REDACTED] placed');
    });
  });

  it('handles deeply nested structures', () => {
    const result = scrub({
      level1: {
        level2: {
          email: 'test@test.com',
          data: [{ password: 'abc' }],
        },
      },
    });
    expect(result).toEqual({
      level1: {
        level2: {
          email: '[REDACTED]',
          data: [{ password: '[REDACTED]' }],
        },
      },
    });
  });
});
