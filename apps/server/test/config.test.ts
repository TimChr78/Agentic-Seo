import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

// Configuration is validated once, at start-up, and the message names the setting without echoing a
// credential. These cases need no database: loadConfig only parses and normalises the environment.

const base = {
  DATABASE_URL: 'postgres://aseo:aseo@localhost:5432/aseo',
  APP_DB_PASSWORD: 'aseo_app_password',
  AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
  MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('configuration', () => {
  it('fails fast with the setting that is wrong', () => {
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'not a url' })).toThrow('PUBLIC_URL');
  });

  // #902: wildcard entries are matched by a bounded glob, so an entry that would cost too much to
  // match is refused at start-up with its own name in the message.
  it('refuses a TRUSTED_ORIGINS wildcard entry that would be too expensive to match (#902)', () => {
    expect(() => loadConfig({ ...base, TRUSTED_ORIGINS: 'https://*a*a*a*a*a.example.com' })).toThrow(
      /TRUSTED_ORIGINS entry "https:\/\/\*a\*a\*a\*a\*a\.example\.com" has more than 4 wildcards/,
    );
    expect(() => loadConfig({ ...base, TRUSTED_ORIGINS: `https://${'a'.repeat(600)}.example.com` })).toThrow(/longer than 512 characters/);
    expect(() => loadConfig({ ...base, TRUSTED_ORIGINS: 'https://*.example.com,http://localhost:5173' })).not.toThrow();
    // A trailing comma or a blank element is ignored, as it always was.
    expect(() => loadConfig({ ...base, TRUSTED_ORIGINS: 'https://*.example.com, ,' })).not.toThrow();
    expect(loadConfig({ ...base, TRUSTED_ORIGINS: 'https://*.example.com, ,' }).trustedOrigins).toEqual(['https://*.example.com']);
  });

  // AWS KMS signs with SigV4 and cannot use basic-auth userinfo; reject it by variable name
  // without echoing the credential (#931 review A4).
  it('rejects credentials in AWS_KMS_ENDPOINT without printing them', () => {
    let error: unknown;
    try {
      loadConfig({ ...base, AWS_KMS_ENDPOINT: 'https://user:secret@kms.example.com' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('AWS_KMS_ENDPOINT');
    expect((error as Error).message).not.toContain('secret');
    expect((error as Error).message).not.toContain('user');
  });
});
