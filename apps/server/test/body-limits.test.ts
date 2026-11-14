import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, startTestServer, testPort, type User } from './harness';
import { findUnboundedRoutes } from './route-sweep';

// #932: Better Auth's catch-all forwards sign-in, sign-up, OAuth token and registration bodies to
// `auth.handler`, which reads the whole body before its own checks. The catch-all needs a guard as
// much as the consent and invitation routes above it: a chunked body has no Content-Length, so the
// limit has to be enforced on the stream.

const PORT = testPort(3459);

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

/** POST a chunked body without Content-Length, writing slowly so an early answer is observable. */
function postChunked(
  path: string,
  opts: { total: number; headers?: Record<string, string> },
): Promise<{ status: number; body: string; writtenAtResponse: number }> {
  return new Promise((resolve, reject) => {
    const chunkSize = 64 * 1024;
    const payload = Buffer.alloc(chunkSize, 'a');
    const total = opts.total;
    let written = 0;
    let settled = false;
    let responding = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: { status: number; body: string; writtenAtResponse: number }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      req.destroy();
      resolve(r);
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      },
      (res) => {
        responding = true;
        if (timer) clearTimeout(timer);
        const writtenAtResponse = written;
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => finish({ status: res.statusCode ?? 0, body, writtenAtResponse }));
        res.on('close', () => finish({ status: res.statusCode ?? 0, body, writtenAtResponse }));
      },
    );
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
    const pump = () => {
      if (settled || responding) return;
      if (written >= total) {
        req.end();
        return;
      }
      const n = Math.min(chunkSize, total - written);
      written += n;
      req.write(payload.subarray(0, n));
      timer = setTimeout(pump, 1);
    };
    pump();
  });
}

const oversize = (bytes: number) => 'a'.repeat(bytes);

/** POST a small chunked body without Content-Length, all in one go. */
function postChunkedText(path: string, text: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    const bytes = Buffer.from(text);
    req.write(bytes.subarray(0, 10));
    req.write(bytes.subarray(10));
    req.end();
  });
}

beforeAll(async () => {
  t = await startTestServer('body_limits', PORT);
  owner = await t.signUp(`limits-${Date.now()}@example.com`);
});

afterAll(async () => {
  await t?.close();
});

describe('Better Auth catch-all (#932)', () => {
  it('refuses an oversized sign-in body with a correct Content-Length', async () => {
    const res = await fetch(`${t.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: t.base },
      body: JSON.stringify({ email: owner.email, password: PASSWORD, pad: oversize(512 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'payload_too_large' });
  });

  it('refuses an oversized chunked sign-up body without Content-Length while it is still arriving', async () => {
    const total = 8 * 1024 * 1024;
    const res = await postChunked('/api/auth/sign-up/email', { total, headers: { origin: t.base } });
    expect(res.status).toBe(413);
    expect(res.writtenAtResponse).toBeLessThan(total);
  });

  it('still signs in normally, including a chunked body without Content-Length', async () => {
    const res = await fetch(`${t.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: t.base },
      body: JSON.stringify({ email: owner.email, password: PASSWORD }),
    });
    expect(res.status).toBe(200);

    const chunked = await postChunkedText('/api/auth/sign-in/email', JSON.stringify({ email: owner.email, password: PASSWORD }), {
      origin: t.base,
    });
    expect(chunked.status).toBe(200);
  });
});

// #932: the sweep. Every route that can read a request body has a bodyLimit, either on the route
// itself or on a matching `app.use` registered before it. The allow-list and its reasons live with
// the sweep in ./route-sweep.ts.
describe('body-limit route sweep (#932)', () => {
  it('gives every body-accepting route its own limit', () => {
    expect(findUnboundedRoutes(t.srv.app)).toEqual([]);
  });
});
