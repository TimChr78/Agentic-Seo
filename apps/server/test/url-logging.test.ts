import { type Dirent, mkdtempSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@agentic-seo/telemetry';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { staticSite } from '../src/http/static';
import { startTestServer, testPort } from './harness';

// #931: a configured URL can carry basic-auth userinfo or a token in its query, and neither may
// reach the logs. The OTLP endpoint was fixed in 0.14.11; the MCP-disabled warning at boot was still
// printing PUBLIC_URL verbatim.

const PORT = testPort(3478);
const PUBLIC_URL_WITH_SECRETS = 'http://user:secret@192.168.1.10:3000/?token=abc';

let t: Awaited<ReturnType<typeof startTestServer>> | undefined;
const captured: string[] = [];

beforeAll(async () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(((first: unknown, second?: unknown) => {
    const head = typeof first === 'string' ? first : JSON.stringify(first);
    captured.push(second === undefined ? head : `${head} ${typeof second === 'string' ? second : JSON.stringify(second)}`);
  }) as typeof logger.warn);
  try {
    t = await startTestServer('test_url_logging', PORT, { PUBLIC_URL: PUBLIC_URL_WITH_SECRETS });
  } finally {
    warn.mockRestore();
  }
}, 90_000);

afterAll(async () => {
  await t?.close();
});

describe('the MCP-disabled startup warning (#931)', () => {
  it('keeps the origin and path but drops userinfo and the query', () => {
    const output = captured.join('\n');
    expect(output).not.toContain('secret');
    expect(output).not.toContain('abc');
    const warned = captured.filter((line) => line.includes('MCP/OAuth client endpoints are disabled'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"publicUrl":"http://192.168.1.10:3000"');
  });
});

// #751: /oauth was missing from staticSite's API prefix list, so an unmatched /oauth/authorize or a
// typo'd callback fell through to the admin SPA with 200 HTML. The API roots answer JSON 404 now.
describe('unknown OAuth paths answer JSON, never the admin shell (#751)', () => {
  it('answers an unmatched OAuth path with a JSON 404 instead of the SPA shell', async () => {
    for (const path of ['/oauth/authorize', '/oauth/token-typo', '/oauth/unknown', '/oauth']) {
      const res = await fetch(`${t!.base}${path}`, { headers: { accept: 'application/json' } });
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type') ?? '', path).toContain('application/json');
      expect(await res.json(), path).toMatchObject({ error: 'not_found' });
    }
  });

  it('leaves the OAuth prefix to the API even when a built UI is served', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aseo-static-'));
    writeFileSync(join(root, 'index.html'), '<html>live admin</html>');
    const { Hono } = await import('hono');
    const app = new Hono();
    app.use('*', staticSite({ root }));
    app.get('*', (c) => c.text('fell through to the app'));

    const oauth = await app.request('/oauth/authorize');
    expect(await oauth.text()).toBe('fell through to the app');
    // A client-side route of the admin UI still gets the shell.
    const ui = await app.request('/sites/one');
    expect(await ui.text()).toContain('live admin');
  });
});

/**
 * Every `logger.<level>( ... )` call in the server and package sources, with its argument text.
 * Parentheses inside strings are skipped so the call is cut at its own closing brace.
 *
 * The scanner below is a cheap tripwire for the obvious spelling only (a `…Url`, `…endpoint`,
 * `…dsn`, `…addr` or `…uri` identifier passed to a logger without endpointOrigin/Location). It
 * cannot see aliases, errors that already carry a URL, or a logger called through another helper.
 */
function loggerCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = /\blogger\.(?:info|warn|error|debug|trace|fatal)\s*\(/g;
  for (let match = marker.exec(source); match; match = marker.exec(source)) {
    let depth = 1;
    let i = marker.lastIndex;
    while (i < source.length && depth > 0) {
      const char = source[i];
      if (char === '"' || char === "'" || char === '`') {
        const quote = char;
        i += 1;
        while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1;
      } else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      i += 1;
    }
    calls.push(source.slice(marker.lastIndex, i - 1));
    marker.lastIndex = i;
  }
  return calls;
}

/** Drops `endpointOrigin(...)`/`endpointLocation(...)` calls and literal text, keeping expressions. */
function withoutSafeForms(argument: string): string {
  let out = argument;
  for (const helper of ['endpointOrigin', 'endpointLocation']) {
    for (let at = out.indexOf(`${helper}(`); at >= 0; at = out.indexOf(`${helper}(`)) {
      let depth = 0;
      let i = at + helper.length;
      for (; i < out.length; i += 1) {
        if (out[i] === '(') depth += 1;
        else if (out[i] === ')') {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
      }
      out = out.slice(0, at) + out.slice(i);
    }
  }
  // Template literals keep only their ${…} expressions; plain strings become empty.
  out = out.replace(/`[^`]*`/g, (literal) => (literal.match(/\$\{[^}]*\}/g) ?? []).join(' '));
  out = out.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  // Comments may mention PUBLIC_URL; only the live expressions matter.
  return out.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

describe('configured URLs in logger calls (#931)', () => {
  it('routes every URL field through endpointOrigin or endpointLocation', async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const files = [...(await sourceFiles(join(root, 'apps/server/src')))];
    for (const space of await readdir(join(root, 'packages'), { withFileTypes: true })) {
      if (space.isDirectory() && space.name !== 'node_modules')
        files.push(...(await sourceFiles(join(root, 'packages', space.name, 'src'))));
    }

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const call of loggerCalls(source)) {
        const unsafe = withoutSafeForms(call);
        // An identifier that names a URL, unless it is an object key (`publicUrl:`), already
        // unwrapped by one of the helpers above.
        const match = unsafe.match(
          /(?:config\.|process\.env\.)?\b[A-Za-z_][A-Za-z0-9_]*(?:[Uu][Rr][Ll]|[Ee]ndpoint|[Dd][Ss][Nn]|[Aa][Dd][Dd][Rr]|[Uu][Rr][Ii])\b(?!\s*:(?!:))/,
        );
        if (match) offenders.push(`${file.replace(`${root}/`, '')}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
