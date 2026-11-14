import { type AnyCommand, createExecutor, userPrincipal } from '@agentic-seo/commands';
import { newUuid } from '@agentic-seo/core';
import { createDb, type Db, schema } from '@agentic-seo/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { APP_ROLE, createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import {
  addCompetitor,
  addMarket,
  archiveSite,
  createSite,
  getSite,
  listCompetitors,
  listMarkets,
  listSites,
  removeCompetitor,
  removeMarket,
  setSiteFetcher,
  setSiteFetchSeams,
  setTxtResolver,
  siteChecklist,
  siteVerification,
  updateSite,
  verifySite,
} from '../src';

// The site commands against a real Postgres: normalisation and refusals, one active site per domain,
// tenancy through row-level security, the role's permissions, both verification methods, the
// default-market rule and the checklist facts. Every test calls a command, because that is the only
// surface a person, the UI or an agent reaches (ADR-0006).

const appUrl = (url: URL) => {
  const u = new URL(url.toString());
  u.username = APP_ROLE.appRole;
  u.password = APP_ROLE.appRolePassword;
  return u.toString();
};

const services = { serverVersion: 'test', strictInputs: false };

describe.skipIf(!hasTestDatabase())('site commands', () => {
  let disposable: DisposableDb;
  let db: Db;
  let executor: ReturnType<typeof createExecutor>;
  let otherWorkspace = '';

  beforeAll(async () => {
    disposable = await createDisposableDb('sites_cmd');
    db = createDb({ adminUrl: disposable.url.toString(), appUrl: appUrl(disposable.url), poolSize: 4 });
    executor = createExecutor(db, services);
    otherWorkspace = newUuid();
    await disposable.db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [
      otherWorkspace,
      'Another workspace',
      'none',
    ]);
  });

  afterAll(async () => {
    await db?.close();
    await disposable?.close();
  });

  afterEach(() => {
    setTxtResolver(null);
    setSiteFetcher(null);
    setSiteFetchSeams(null);
  });

  const owner = (workspace = disposable.workspace) => userPrincipal('user_owner', workspace, 'owner');
  const run = <C extends AnyCommand>(cmd: C, input: unknown, principal = owner()): Promise<z.output<C['output']>> =>
    executor.execute(cmd, input, principal, { surface: 'rest' });

  const create = async (domain: string, name = 'Acme store') => (await run(createSite, { name, domain })).site;

  it('creates a normalised site with a 192-bit token and no verification yet', async () => {
    const site = await create('Example.COM.');
    expect(site).toMatchObject({
      name: 'Acme store',
      domain: 'example.com',
      hosts: [],
      businessType: null,
      isLocalBusiness: false,
      verified: false,
      verificationMethod: null,
      archived: false,
    });
    expect(site.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const instructions = await run(siteVerification, { siteId: site.id });
    // 24 random bytes as base64url: 32 characters, and the token ships in both published values.
    expect(instructions.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(instructions.dns).toMatchObject({ type: 'TXT', name: 'example.com', value: `aseo-site-verification=${instructions.token}` });
    expect(instructions.meta.content).toBe(instructions.token);
    expect(instructions.verified).toBe(false);
  });

  it('refuses a URL, an IP literal and an internal name when creating a site', async () => {
    for (const domain of ['https://example.org', '127.0.0.1', 'localhost'])
      await expect(run(createSite, { name: 'Refused', domain })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('keeps one active site per domain in the workspace, and allows the domain again after archiving', async () => {
    await create('unique.example');
    await expect(run(createSite, { name: 'Second', domain: 'UNIQUE.example' })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('already tracks unique.example'),
    });
    const first = (await run(listSites, {})).sites.find((s) => s.domain === 'unique.example')!;
    await run(archiveSite, { siteId: first.id });
    const replacement = await create('unique.example', 'A new start');
    expect(replacement.id).not.toBe(first.id);
    expect(replacement.archived).toBe(false);
  });

  it('archives instead of deleting, and refuses changes to an archived site', async () => {
    const site = await create('archived.example');
    const archived = await run(archiveSite, { siteId: site.id });
    expect(archived.site.archived).toBe(true);
    // Reads keep working; writes stop with a message about what to do.
    expect((await run(getSite, { siteId: site.id })).site.archived).toBe(true);
    await expect(run(updateSite, { siteId: site.id, name: 'Renamed' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await run(listSites, {})).sites.some((s) => s.id === site.id)).toBe(false);
    expect((await run(listSites, { includeArchived: true })).sites.some((s) => s.id === site.id)).toBe(true);
  });

  it('keeps workspaces apart through row-level security', async () => {
    const site = await create('isolation.example');
    expect((await run(listSites, {}, owner(otherWorkspace))).sites).toHaveLength(0);
    await expect(run(getSite, { siteId: site.id }, owner(otherWorkspace))).rejects.toMatchObject({ code: 'not_found' });
    // The same answer from the database, not only from the command's own query.
    const rows = await db.withWorkspace(otherWorkspace, (tx) => tx.select({ id: schema.sites.id }).from(schema.sites));
    expect(rows).toHaveLength(0);
  });

  it('refuses a viewer a write, and lets a viewer read', async () => {
    const viewer = userPrincipal('user_viewer', disposable.workspace, 'viewer');
    await expect(run(createSite, { name: 'Nope', domain: 'viewer.example' }, viewer)).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('sites:write'),
    });
    expect(Array.isArray((await run(listSites, {}, viewer)).sites)).toBe(true);
  });

  it('accepts extra hosts only under the primary domain and stores the business facts', async () => {
    const site = await create('hosts.example');
    await expect(run(updateSite, { siteId: site.id, hosts: ['evil.example.net'] })).rejects.toMatchObject({ code: 'invalid_input' });
    const updated = await run(updateSite, {
      siteId: site.id,
      hosts: ['WWW.Hosts.example', 'www.hosts.example'],
      businessType: 'local',
      isLocalBusiness: true,
    });
    expect(updated.site).toMatchObject({
      hosts: ['www.hosts.example'],
      businessType: 'local',
      isLocalBusiness: true,
    });
  });

  it('keeps exactly one default market per site and promotes the oldest after a removal', async () => {
    const site = await create('markets.example');
    const us = (
      await run(addMarket, {
        siteId: site.id,
        locationCode: 2840,
        languageCode: 'en',
        gscCountry: 'USA',
        name: 'United States — English',
      })
    ).market;
    expect(us.isDefault).toBe(true);
    const uk = (
      await run(addMarket, {
        siteId: site.id,
        locationCode: 2826,
        languageCode: 'en',
        gscCountry: 'GBR',
        name: 'United Kingdom — English',
        isDefault: true,
      })
    ).market;
    let markets = (await run(listMarkets, { siteId: site.id })).markets;
    expect(markets.filter((m) => m.isDefault).map((m) => m.id)).toEqual([uk.id]);

    await expect(run(addMarket, { siteId: site.id, locationCode: 2840, languageCode: 'en', name: 'Duplicate' })).rejects.toMatchObject({
      code: 'conflict',
    });

    await run(removeMarket, { siteId: site.id, marketId: uk.id });
    markets = (await run(listMarkets, { siteId: site.id })).markets;
    expect(markets).toHaveLength(1);
    expect(markets[0]).toMatchObject({ id: us.id, isDefault: true });
  });

  it('normalises a competitor, refuses the site itself and a duplicate', async () => {
    const site = await create('own.example');
    const competitor = (await run(addCompetitor, { siteId: site.id, domain: 'Rival.Example', name: 'Rival' })).competitor;
    expect(competitor).toMatchObject({ domain: 'rival.example', source: 'manual' });
    await expect(run(addCompetitor, { siteId: site.id, domain: 'OWN.example' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(run(addCompetitor, { siteId: site.id, domain: 'rival.example' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await run(listCompetitors, { siteId: site.id })).competitors.map((c) => c.domain)).toEqual(['rival.example']);
    await run(removeCompetitor, { siteId: site.id, competitorId: competitor.id });
    expect((await run(listCompetitors, { siteId: site.id })).competitors).toHaveLength(0);
  });

  it('verifies through a TXT record split into chunks and keeps the site verified when a re-check fails', async () => {
    const site = await create('dns.example');
    const { token } = await run(siteVerification, { siteId: site.id });
    setTxtResolver(async () => [[`aseo-site-verification=${token.slice(0, 12)}`, token.slice(12)]]);

    const verified = await run(verifySite, { siteId: site.id });
    expect(verified).toMatchObject({ verified: true, method: 'dns', error: null });
    expect((await run(getSite, { siteId: site.id })).site).toMatchObject({ verified: true, verificationMethod: 'dns' });

    // The record disappears. Phase 0 records the failure and does not un-verify silently.
    setTxtResolver(async () => {
      throw Object.assign(new Error('queryTxt ENODATA'), { code: 'ENODATA' });
    });
    setSiteFetcher(async () => {
      throw new Error('no route to host');
    });
    const recheck = await run(verifySite, { siteId: site.id });
    expect(recheck.verified).toBe(true);
    expect(recheck.method).toBeNull();
    expect(recheck.error).toContain('No DNS TXT records were found on dns.example');
    const read = await run(siteVerification, { siteId: site.id });
    expect(read).toMatchObject({ verified: true, verifiedAt: expect.any(String) });
    expect(read.lastCheckError).toContain('No DNS TXT records were found');
  });

  it('verifies through the meta tag when DNS has no record', async () => {
    const site = await create('meta.example');
    const { token } = await run(siteVerification, { siteId: site.id });
    setTxtResolver(async () => {
      throw Object.assign(new Error('queryTxt ENODATA'), { code: 'ENODATA' });
    });
    setSiteFetcher(async () => ({
      requestUrl: 'https://meta.example/',
      url: 'https://meta.example/',
      status: 200,
      headers: {},
      contentType: 'text/html',
      charset: 'utf-8',
      body: Buffer.alloc(0),
      text: `<html><head><meta name="aseo-site-verification" content="${token}"></head></html>`,
      truncated: false,
      redirects: [],
      timings: { dnsMs: 0, connectMs: 0, ttfbMs: 0, totalMs: 0 },
    }));
    expect(await run(verifySite, { siteId: site.id })).toMatchObject({ verified: true, method: 'meta' });
  });

  it('reports the guard’s refusal when the domain resolves to a private address', async () => {
    const site = await create('ssrf.example');
    setTxtResolver(async () => {
      throw Object.assign(new Error('queryTxt ENODATA'), { code: 'ENODATA' });
    });
    // The production adapter, with only its resolver seam replaced: it must refuse before a socket opens.
    setSiteFetchSeams({ resolver: async () => [{ address: '127.0.0.1', family: 4 }] });
    const result = await run(verifySite, { siteId: site.id });
    expect(result.verified).toBe(false);
    expect(result.error).toContain('private, loopback or metadata');
  });

  it('refuses a public suffix as a competitor domain', async () => {
    const site = await create('suffix.example');
    await expect(run(addCompetitor, { siteId: site.id, domain: 'co.uk' })).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('public suffix'),
    });
    await expect(run(addCompetitor, { siteId: site.id, domain: 'github.io' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('reports the checklist facts from what exists, not from a guess', async () => {
    const site = await create('checklist.example');
    await run(addCompetitor, { siteId: site.id, domain: 'one.example' });
    await run(addCompetitor, { siteId: site.id, domain: 'two.example' });
    expect(await run(siteChecklist, { siteId: site.id })).toEqual({
      siteVerified: false,
      searchConsole: false,
      competitors: 2,
      audits: 0,
      dataForSeoKey: false,
      siteConnector: false,
    });
  });
});
