import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFetchError, safeFetch } from '../src';
import { closeSites, loopback, startSite } from './support';

// A response may be encoded more than once (`Content-Encoding: gzip, deflate` means the body is
// deflate(gzip(content))). Every encoding must be undone, in reverse, with a cap at each stage.

afterEach(closeSites);

const HTML = '<html><head><title>nested</title></head><body>done</body></html>';

async function failure(promise: Promise<unknown>): Promise<SafeFetchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SafeFetchError) return error;
    throw error;
  }
  throw new Error('expected the fetch to fail');
}

function options(port: number, maxBytes?: number) {
  return {
    resolver: async () => loopback,
    allow: { privateHosts: ['site.test'], ports: [port] },
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

async function siteWithBody(body: Buffer, contentEncoding: string, contentType = 'text/html; charset=utf-8') {
  return startSite((_req, res) => {
    res.writeHead(200, { 'content-type': contentType, 'content-encoding': contentEncoding, 'content-length': body.length });
    res.end(body);
  });
}

describe('content-encoding chains', () => {
  it('decodes gzip, deflate in reverse order', async () => {
    const body = deflateSync(gzipSync(Buffer.from(HTML)));
    const site = await siteWithBody(body, 'gzip, deflate');

    const result = await safeFetch(`http://site.test:${site.port}/`, options(site.port));

    expect(result.text).toBe(HTML);
    expect(result.truncated).toBe(false);
  });

  it('decodes brotli', async () => {
    const site = await siteWithBody(brotliCompressSync(Buffer.from(HTML)), 'br');

    const result = await safeFetch(`http://site.test:${site.port}/`, options(site.port));

    expect(result.text).toBe(HTML);
  });

  it('rejects an encoding it cannot decode instead of returning the raw bytes as text', async () => {
    const site = await siteWithBody(Buffer.from('not really zstd'), 'zstd');

    const error = await failure(safeFetch(`http://site.test:${site.port}/`, options(site.port)));

    expect(error.kind).toBe('unsupported_encoding');
  });

  it('stops a bomb nested in two encodings at every stage', async () => {
    const bomb = deflateSync(gzipSync(Buffer.alloc(40 * 1024 * 1024)));
    const site = await siteWithBody(bomb, 'gzip, deflate');

    const result = await safeFetch(`http://site.test:${site.port}/`, options(site.port, 4096));

    expect(result.truncated).toBe(true);
    expect(result.body.length).toBe(4096);
  });

  it('fails a nested bomb in a non-HTML body instead of returning a partial encoding', async () => {
    const bomb = deflateSync(gzipSync(Buffer.alloc(40 * 1024 * 1024)));
    const site = await siteWithBody(bomb, 'gzip, deflate', 'application/octet-stream');

    const error = await failure(safeFetch(`http://site.test:${site.port}/`, options(site.port, 4096)));

    expect(error.kind).toBe('too_large');
  });
});
