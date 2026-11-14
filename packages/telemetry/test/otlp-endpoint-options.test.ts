import { afterEach, describe, expect, it, vi } from 'vitest';

// #931: when an effective OTLP endpoint carries userinfo, the exporter is built from the
// credential-free URL with the credentials in an Authorization header. The exporter is mocked so the
// test sees exactly what initTelemetry passes; the real exporter is exercised end to end in
// ./otlp-credentials.test.ts.

const captured = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    constructor(options?: unknown) {
      captured.options.push(options);
    }
    export(_spans: unknown, callback: (result: { code: number }) => void) {
      callback({ code: 0 });
    }
    shutdown() {
      return Promise.resolve();
    }
    forceFlush() {
      return Promise.resolve();
    }
  },
}));

const ENV_KEYS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  captured.options.length = 0;
});

async function optionsFor(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): Promise<unknown[]> {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const { initTelemetry } = await import('../src/index');
  initTelemetry('test');
  return captured.options;
}

const basic = (value: string) => `Basic ${Buffer.from(value).toString('base64')}`;

describe('the exporter options when the endpoint carries credentials (#931)', () => {
  it('passes no options at all when there is nothing to strip, so the SDK reads the environment', async () => {
    expect(await optionsFor({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.example:4318' })).toEqual([undefined]);
  });

  it('passes the credential-free URL and the URL credentials as a Basic header', async () => {
    const [options] = await optionsFor({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://alice:p%40ss@otel.example:4318' });
    expect(options).toEqual({
      url: 'http://otel.example:4318/v1/traces',
      headers: { authorization: basic('alice:p@ss') },
    });
    expect(JSON.stringify(options)).not.toContain('alice');
    expect(JSON.stringify(options)).not.toContain('p%40ss');
  });

  it('keeps the trace-specific endpoint as it is, credentials removed', async () => {
    const [options] = await optionsFor({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.example:4318',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://alice:p%40ss@otel.example:4318/custom',
    });
    expect(options).toEqual({ url: 'http://otel.example:4318/custom', headers: { authorization: basic('alice:p@ss') } });
  });

  it('lets an Authorization the SDK really sends win over the URL credentials', async () => {
    const [options] = await optionsFor({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://alice:p%40ss@otel.example:4318',
      OTEL_EXPORTER_OTLP_HEADERS: '%61uthorization=Bearer%20env-token',
    });
    // The URL is still credential-free, but the URL's Basic header is not added over the env one.
    expect(options).toEqual({ url: 'http://otel.example:4318/v1/traces' });
  });

  it('keeps the URL credentials when the env entry is one the SDK drops', async () => {
    const [options] = await optionsFor({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://alice:p%40ss@otel.example:4318',
      OTEL_EXPORTER_OTLP_HEADERS: '%ZZauthorization=Bearer%20x',
    });
    expect(options).toEqual({ url: 'http://otel.example:4318/v1/traces', headers: { authorization: basic('alice:p@ss') } });
  });
});
