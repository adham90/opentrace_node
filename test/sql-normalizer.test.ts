import { describe, it, expect } from 'vitest';
import { normalize, fingerprint } from '../src/sql-normalizer.js';

describe('normalize', () => {
  it('replaces integer literals', () => {
    expect(normalize('SELECT * FROM users WHERE id = 42')).toBe('SELECT * FROM users WHERE id = ?');
  });

  it('replaces string literals', () => {
    expect(normalize("SELECT * FROM users WHERE name = 'Alice'")).toBe(
      'SELECT * FROM users WHERE name = ?',
    );
  });

  it('replaces double-quoted strings', () => {
    expect(normalize('SELECT * FROM users WHERE name = "Bob"')).toBe(
      'SELECT * FROM users WHERE name = ?',
    );
  });

  it('handles escaped quotes in strings', () => {
    expect(normalize("WHERE name = 'O\\'Brien'")).toBe('WHERE name = ?');
  });

  it('replaces float literals', () => {
    expect(normalize('WHERE price > 19.99')).toBe('WHERE price > ?');
  });

  it('replaces hex literals', () => {
    expect(normalize('WHERE flags = 0xFF')).toBe('WHERE flags = ?');
  });

  it('replaces booleans', () => {
    expect(normalize('WHERE active = TRUE AND deleted = FALSE')).toBe(
      'WHERE active = ? AND deleted = ?',
    );
  });

  it('replaces NULL', () => {
    expect(normalize('WHERE deleted_at IS NULL')).toBe('WHERE deleted_at IS ?');
  });

  it('collapses IN lists', () => {
    expect(normalize('WHERE id IN (1, 2, 3, 4, 5)')).toBe('WHERE id IN (?)');
  });

  it('collapses whitespace', () => {
    expect(normalize('SELECT   *\n  FROM   users')).toBe('SELECT * FROM users');
  });

  it('handles complex queries', () => {
    const sql = "INSERT INTO logs (user_id, message, created_at) VALUES (42, 'hello world', '2026-01-01')";
    const result = normalize(sql);
    expect(result).toBe('INSERT INTO logs (user_id, message, created_at) VALUES (?)');
  });
});

describe('fingerprint', () => {
  it('returns a 12-char hex string', () => {
    const fp = fingerprint('SELECT * FROM users WHERE id = 1');
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  it('same fingerprint for queries differing only in literals', () => {
    const fp1 = fingerprint('SELECT * FROM users WHERE id = 1');
    const fp2 = fingerprint('SELECT * FROM users WHERE id = 999');
    expect(fp1).toBe(fp2);
  });

  it('different fingerprint for structurally different queries', () => {
    const fp1 = fingerprint('SELECT * FROM users WHERE id = 1');
    const fp2 = fingerprint('SELECT * FROM orders WHERE id = 1');
    expect(fp1).not.toBe(fp2);
  });
});
