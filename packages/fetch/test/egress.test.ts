import { describe, expect, it } from 'vitest';
import { checkEgressUrl, egressFetch, resolveEgressHost } from '../src';

// The egress guard for a configured API endpoint (the LLM provider's base URL): a workspace must
// not be able to point a provider at a private, loopback or metadata address.

describe('checkEgressUrl', () => {
  it('accepts a public https API origin', () => {
    expect(checkEgressUrl('https://api.openai.com/v1')).toBeNull();
    expect(checkEgressUrl('https://api.anthropic.com/v1')).toBeNull();
    expect(checkEgressUrl('https://api.openai.com:443/v1')).toBeNull();
  });

  it('refuses plain http, embedded credentials, another port and internal targets', () => {
    expect(checkEgressUrl('http://api.openai.com/v1')).toContain('https');
    expect(checkEgressUrl('https://user:pass@api.openai.com/v1')).toContain('credentials');
    expect(checkEgressUrl('https://api.openai.com:8443/v1')).toContain('port');
    expect(checkEgressUrl('https://localhost/v1')).toContain('internal');
    expect(checkEgressUrl('https://llm.internal/v1')).toContain('internal');
    expect(checkEgressUrl('https://10.0.0.5/v1')).toContain('private');
    expect(checkEgressUrl('https://[::1]/v1')).toContain('private');
    expect(checkEgressUrl('https://169.254.169.254/latest/meta-data')).toContain('private');
    expect(checkEgressUrl('not a url')).toBe('not a valid URL');
  });
});

describe('resolveEgressHost', () => {
  it('refuses a name that resolves to a private address', async () => {
    await expect(
      resolveEgressHost(new URL('https://llm.example.com/v1'), async () => [{ address: '10.1.2.3', family: 4 }]),
    ).rejects.toThrow(/private/);
  });

  it('refuses a mixed public/private answer, not just the first address', async () => {
    await expect(
      resolveEgressHost(new URL('https://llm.example.com/v1'), async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.2', family: 4 },
      ]),
    ).rejects.toThrow(/192\.168\.1\.2/);
  });

  it('accepts a public answer', async () => {
    await expect(
      resolveEgressHost(new URL('https://llm.example.com/v1'), async () => [{ address: '93.184.216.34', family: 4 }]),
    ).resolves.toBeUndefined();
  });
});

describe('egressFetch', () => {
  it('refuses a loopback endpoint before any socket is opened', async () => {
    await expect(egressFetch('http://127.0.0.1:1234/v1/chat/completions', { method: 'POST', body: '{}' })).rejects.toThrow(/https/);
    await expect(egressFetch('https://127.0.0.1/v1/chat/completions', { method: 'POST', body: '{}' })).rejects.toThrow(/private/);
  });
});
