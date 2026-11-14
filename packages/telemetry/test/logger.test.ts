import { afterEach, describe, expect, it, vi } from 'vitest';

// The logger is created at import time, so each case needs a fresh module registry. Compose and
// Kubernetes pass unset variables as empty strings; an empty string is not a pino level.
const original = process.env.LOG_LEVEL;

afterEach(() => {
  vi.resetModules();
  if (original === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = original;
});

async function levelFor(value: string | undefined): Promise<string> {
  vi.resetModules();
  if (value === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = value;
  const { logger } = await import('../src/index');
  return logger.level;
}

describe('telemetry log level', () => {
  it('falls back to info when LOG_LEVEL is unset, empty or whitespace', async () => {
    expect(await levelFor(undefined)).toBe('info');
    expect(await levelFor('')).toBe('info');
    expect(await levelFor('   ')).toBe('info');
  });

  it('keeps an explicit level', async () => {
    expect(await levelFor('debug')).toBe('debug');
  });
});

describe('endpointOrigin', () => {
  it('drops credentials, paths and query strings from the logged endpoint', async () => {
    const { endpointOrigin } = await import('../src/index');
    expect(endpointOrigin('https://user:secret@otel.example.com:4318/v1/traces?token=abc')).toBe('https://otel.example.com:4318');
    expect(endpointOrigin('not a url')).toBe('(invalid URL)');
    // `otel.example:4318` parses as a scheme with no host, whose origin is "null": never echo it.
    expect(endpointOrigin('otel.example:4318')).toBe('(invalid URL)');
  });
});

describe('endpointLocation', () => {
  it('keeps the origin and path, and drops the userinfo, query and fragment', async () => {
    const { endpointLocation } = await import('../src/index');
    expect(endpointLocation('https://user:pw@app.example.com/base?token=x#frag')).toBe('https://app.example.com/base');
    expect(endpointLocation('https://app.example.com')).toBe('https://app.example.com');
    expect(endpointLocation('http://localhost:3000/')).toBe('http://localhost:3000');
  });

  it('says plainly when the public URL is not a URL', async () => {
    const { endpointLocation } = await import('../src/index');
    expect(endpointLocation('app.example.com')).toBe('(invalid URL)');
  });
});

describe('splitUrlCredentials and endpointFailure', () => {
  it('moves userinfo into a Basic header and keeps the query', async () => {
    const { splitUrlCredentials } = await import('../src/index');
    expect(splitUrlCredentials('https://alice:p%40ss@otel.example:4318/v1/traces?token=abc')).toEqual({
      url: 'https://otel.example:4318/v1/traces?token=abc',
      headers: { authorization: `Basic ${Buffer.from('alice:p@ss').toString('base64')}` },
    });
    expect(splitUrlCredentials('https://otel.example:4318')).toEqual({ url: 'https://otel.example:4318/', headers: {} });
  });

  it('reports a failure as the endpoint origin and the cause code, never the message', async () => {
    const { endpointFailure } = await import('../src/index');
    const err = new Error('connect ECONNREFUSED https://alice:secret@otel.example:4318/?token=abc', {
      cause: { code: 'ECONNREFUSED' },
    });
    expect(endpointFailure(err, 'https://alice:secret@otel.example:4318/?token=abc')).toBe('https://otel.example:4318 (ECONNREFUSED)');
    expect(endpointFailure(new TypeError('fetch failed'), 'https://otel.example:4318')).toBe('https://otel.example:4318 (TypeError)');
  });
});
