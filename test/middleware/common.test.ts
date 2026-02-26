import { describe, it, expect } from 'vitest';
import { extractRequestInfo, isIgnoredPath } from '../../src/middleware/common.js';
import type { IncomingMessage } from 'node:http';

function fakeReq(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    url: '/api/users?page=1',
    method: 'GET',
    headers: {},
    ...overrides,
  } as IncomingMessage;
}

describe('extractRequestInfo', () => {
  it('extracts method and path (strips query)', () => {
    const info = extractRequestInfo(fakeReq());
    expect(info.method).toBe('GET');
    expect(info.path).toBe('/api/users');
  });

  it('uses x-request-id header when present', () => {
    const info = extractRequestInfo(fakeReq({ headers: { 'x-request-id': 'req-abc' } }));
    expect(info.requestId).toBe('req-abc');
  });

  it('generates a UUID when no request-id header', () => {
    const info = extractRequestInfo(fakeReq());
    // UUID format
    expect(info.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('handles missing url', () => {
    const info = extractRequestInfo(fakeReq({ url: undefined }));
    expect(info.path).toBe('/');
  });
});

describe('isIgnoredPath', () => {
  const ignorePaths = ['/health', '/ready', '/live'];

  it('matches exact paths', () => {
    expect(isIgnoredPath('/health', ignorePaths)).toBe(true);
    expect(isIgnoredPath('/ready', ignorePaths)).toBe(true);
  });

  it('matches subpaths', () => {
    expect(isIgnoredPath('/health/check', ignorePaths)).toBe(true);
  });

  it('does not match other paths', () => {
    expect(isIgnoredPath('/api/users', ignorePaths)).toBe(false);
    expect(isIgnoredPath('/healthy', ignorePaths)).toBe(false);
  });

  it('handles empty ignore list', () => {
    expect(isIgnoredPath('/health', [])).toBe(false);
  });
});
