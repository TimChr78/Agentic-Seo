import type { Db } from '@agentic-seo/db';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { metricsHandler } from '../src/http/metrics';
import { consentPage, loginPage } from '../src/http/pages';
import { createMetricsRegistry } from '../src/metrics';

// `/metrics` is off unless METRICS_TOKEN is set, and the server-rendered pages carry the product
// mark. Both are small enough to test without a database.

const stubDb = { ping: async () => undefined } as unknown as Db;

describe('GET /metrics', () => {
  it('answers 404 when no token is configured, so it does not advertise itself', async () => {
    const app = new Hono();
    app.get('/metrics', metricsHandler({ registry: createMetricsRegistry(), db: stubDb }));
    const res = await app.request('/metrics');
    expect(res.status).toBe(404);
  });

  it('needs the bearer token and then renders Prometheus text', async () => {
    const registry = createMetricsRegistry();
    registry.recordCommand({ command: 'workspace.get', effect: 'read', outcome: 'ok', durationMs: 3 });
    registry.recordHttp('v1', '2xx', 0.004);
    const app = new Hono();
    app.get('/metrics', metricsHandler({ token: 'metrics-token-1234', registry, db: stubDb }));

    expect((await app.request('/metrics')).status).toBe(401);
    expect((await app.request('/metrics', { headers: { authorization: 'Bearer wrong-token-12345' } })).status).toBe(401);

    const res = await app.request('/metrics', { headers: { authorization: 'Bearer metrics-token-1234' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('aseo_http_requests_total{route="v1",status="2xx"} 1');
    expect(body).toContain('aseo_commands_total{command="workspace.get",effect="read",outcome="ok"} 1');
    expect(body).toContain('aseo_dependency_up{name="postgres"} 1');
  });
});

describe('the sign-in and consent pages', () => {
  it('carry the Agentic SEO mark and never the marketing product name', () => {
    for (const page of [loginPage('nonce'), consentPage('nonce')]) {
      expect(page).toContain('Agentic SEO');
      expect(page).not.toContain('Agentic Marketing');
      expect(page).toContain('nonce="nonce"');
    }
  });

  it('asks which workspace an OAuth connection acts in', () => {
    expect(consentPage('nonce')).toContain('Workspace this connection acts in');
  });
});
