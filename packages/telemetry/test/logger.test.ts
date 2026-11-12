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
  });
});
