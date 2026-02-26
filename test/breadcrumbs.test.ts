import { describe, it, expect } from 'vitest';
import { BreadcrumbBuffer } from '../src/breadcrumbs.js';

describe('BreadcrumbBuffer', () => {
  it('starts empty', () => {
    const buf = new BreadcrumbBuffer();
    expect(buf.length).toBe(0);
    expect(buf.toArray()).toEqual([]);
  });

  it('adds breadcrumbs with timestamp', () => {
    const buf = new BreadcrumbBuffer();
    buf.add('http', 'GET /api/users');

    const crumbs = buf.toArray();
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0].category).toBe('http');
    expect(crumbs[0].message).toBe('GET /api/users');
    expect(crumbs[0].timestamp).toBeTruthy();
  });

  it('includes optional data and level', () => {
    const buf = new BreadcrumbBuffer();
    buf.add('db', 'SELECT * FROM users', { table: 'users' }, 'info');

    const crumbs = buf.toArray();
    expect(crumbs[0].data).toEqual({ table: 'users' });
    expect(crumbs[0].level).toBe('info');
  });

  it('omits data and level keys when not provided', () => {
    const buf = new BreadcrumbBuffer();
    buf.add('click', 'button#submit');

    const crumb = buf.toArray()[0];
    expect(crumb).not.toHaveProperty('data');
    expect(crumb).not.toHaveProperty('level');
  });

  it('caps at 25 breadcrumbs (FIFO)', () => {
    const buf = new BreadcrumbBuffer();
    for (let i = 0; i < 30; i++) {
      buf.add('nav', `page-${i}`);
    }

    expect(buf.length).toBe(25);
    // First 5 should be dropped
    const crumbs = buf.toArray();
    expect(crumbs[0].message).toBe('page-5');
    expect(crumbs[24].message).toBe('page-29');
  });

  it('toArray returns a copy', () => {
    const buf = new BreadcrumbBuffer();
    buf.add('test', 'one');

    const arr = buf.toArray();
    arr.push({ category: 'fake', message: 'injected', timestamp: '' });
    expect(buf.length).toBe(1);
  });

  it('clears all breadcrumbs', () => {
    const buf = new BreadcrumbBuffer();
    buf.add('a', 'one');
    buf.add('b', 'two');
    buf.clear();

    expect(buf.length).toBe(0);
    expect(buf.toArray()).toEqual([]);
  });
});
