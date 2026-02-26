const DEFAULT_PATTERNS: [string, RegExp][] = [
  ['credit_card', /\b(?:\d[ -]*?){13,16}\b/g],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['ssn', /\b\d{3}-\d{2}-\d{4}\b/g],
  ['phone', /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g],
  ['bearer_token', /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g],
  ['api_key', /(?:sk|pk|api[_-]?key)[_-][A-Za-z0-9_]{20,}/gi],
];

const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'authorization',
  'auth_token',
  'access_token',
  'refresh_token',
  'credit_card',
  'card_number',
  'cvv',
  'ssn',
]);

const REDACTED = '[REDACTED]';

export function scrub(obj: unknown, extraPatterns: RegExp[] = []): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return scrubString(obj, extraPatterns);
  if (Array.isArray(obj)) return obj.map((item) => scrub(item, extraPatterns));
  if (typeof obj === 'object') return scrubObject(obj as Record<string, unknown>, extraPatterns);
  return obj;
}

function scrubString(value: string, extraPatterns: RegExp[]): string {
  let result = value;
  for (const [, pattern] of DEFAULT_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  for (const pattern of extraPatterns) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

function scrubObject(obj: Record<string, unknown>, extraPatterns: RegExp[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = REDACTED;
    } else {
      result[key] = scrub(obj[key], extraPatterns);
    }
  }
  return result;
}
