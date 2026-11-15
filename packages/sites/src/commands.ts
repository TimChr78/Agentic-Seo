import { type CommandContext, defineCommand } from '@agentic-seo/commands';
import { AppError, newUuid } from '@agentic-seo/core';
import { schema } from '@agentic-seo/db';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isHostOfDomain, normalizeDomain, normalizeHost, siteHosts } from './domain';
import { checkDnsRecord, checkMetaTag, dnsRecordValue, newVerificationToken, VERIFICATION_NAME } from './verify';

// Sites, their markets and their competitors (docs/architecture/domain-model.md §1). Phase 0 owns
// server-side site management: create a site, verify ownership, and keep the lists a later UI and
// the MCP surface read. Site ids are uuids like workspace ids, because artifacts, learnings and
// provider_calls already store a uuid site_id and their composite foreign keys point here.

const SiteId = z.string().uuid().describe('Site id');
const MarketId = z.string().uuid().describe('Market id');
const CompetitorId = z.string().uuid().describe('Competitor id');

export const businessTypes = ['saas', 'local', 'ecommerce', 'publisher', 'agency', 'other'] as const;
export type BusinessType = (typeof businessTypes)[number];
export const BusinessTypeEnum = z.enum(businessTypes);
export type VerificationMethod = 'dns' | 'meta';

export const SiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The normalised primary domain: lower-case ASCII, without scheme, path, port or trailing dot. */
  domain: z.string(),
  /** Extra hosts the site answers on, such as www.example.com. The primary domain is not repeated. */
  hosts: z.array(z.string()),
  businessType: BusinessTypeEnum.nullable(),
  isLocalBusiness: z.boolean(),
  /** Ownership verified. A fact from the server, never inferred by a client. */
  verified: z.boolean(),
  verifiedAt: z.string().nullable(),
  verificationMethod: z.enum(['dns', 'meta']).nullable(),
  archived: z.boolean(),
  createdAt: z.string(),
});

const MarketSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  locationCode: z.number().int().describe('DataForSEO location code'),
  languageCode: z.string(),
  gscCountry: z.string().nullable().describe('ISO 3166-1 alpha-3 country for Search Console, when known'),
  name: z.string(),
  isDefault: z.boolean(),
});

const CompetitorSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  domain: z.string(),
  name: z.string().nullable(),
  source: z.enum(['manual', 'detected']),
  createdAt: z.string(),
});

type SiteRow = typeof schema.sites.$inferSelect;
type MarketRow = typeof schema.markets.$inferSelect;
type CompetitorRow = typeof schema.competitors.$inferSelect;

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

const siteView = (site: SiteRow) => ({
  id: site.id,
  name: site.name,
  domain: site.primaryDomain,
  hosts: site.hosts,
  businessType: site.businessType,
  isLocalBusiness: site.isLocalBusiness,
  verified: site.verifiedAt !== null,
  verifiedAt: iso(site.verifiedAt),
  verificationMethod: site.verificationMethod,
  archived: site.archived,
  createdAt: site.createdAt.toISOString(),
});

const marketView = (market: MarketRow) => ({
  id: market.id,
  siteId: market.siteId,
  locationCode: market.locationCode,
  languageCode: market.languageCode,
  gscCountry: market.gscCountry,
  name: market.name,
  isDefault: market.isDefault,
});

const competitorView = (competitor: CompetitorRow) => ({
  id: competitor.id,
  siteId: competitor.siteId,
  domain: competitor.domain,
  name: competitor.name,
  source: competitor.source,
  createdAt: competitor.createdAt.toISOString(),
});

/** Postgres unique-violation (SQLSTATE 23505), directly or as the cause of a query error. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (
    let e = error as { code?: unknown; constraint?: unknown; cause?: unknown } | undefined, depth = 0;
    e && depth < 5;
    e = e.cause as typeof e, depth++
  )
    if (e.code === '23505' && e.constraint === constraint) return true;
  return false;
}

async function loadSite(ctx: CommandContext, siteId: string, opts: { includeArchived?: boolean } = {}): Promise<SiteRow> {
  const [site] = await ctx.tx
    .select()
    .from(schema.sites)
    .where(and(eq(schema.sites.workspaceId, ctx.principal.workspaceId), eq(schema.sites.id, siteId)));
  if (!site) throw new AppError('not_found', `Site ${siteId} does not exist in this workspace.`);
  if (site.archived && !opts.includeArchived)
    throw new AppError(
      'conflict',
      `Site “${site.name}” (${site.primaryDomain}) is archived. Phase 0 has no restore; create a new site for it instead.`,
    );
  return site;
}

/**
 * Serialises changes to one site's markets and competitors. Two requests that both read "which
 * market is default" and then write must not interleave, or the partial unique index answers with a
 * raw 23505. The lock is transaction-scoped and taken after the executor's own locks.
 */
async function lockSiteLists(ctx: CommandContext, siteId: string) {
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sites:lists:${ctx.principal.workspaceId}:${siteId}`}, 0))`);
}

/** The site context artifact for a site: at most one active row, by the singleton index. */
export async function contextArtifactId(tx: CommandContext['tx'], workspaceId: string, siteId: string): Promise<string | null> {
  const [artifact] = await tx
    .select({ id: schema.artifacts.id })
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.workspaceId, workspaceId),
        eq(schema.artifacts.type, 'site_context'),
        eq(schema.artifacts.siteId, siteId),
        eq(schema.artifacts.archived, false),
      ),
    )
    .limit(1);
  return artifact?.id ?? null;
}

export const listSites = defineCommand({
  name: 'sites.list',
  title: 'List sites',
  description: 'List the workspace’s sites, newest first. Archived sites are left out unless asked for.',
  input: z.object({
    includeArchived: z.boolean().default(false).describe('Include archived sites'),
  }),
  output: z.object({ sites: z.array(SiteSchema) }),
  permission: 'sites:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select()
      .from(schema.sites)
      .where(
        and(eq(schema.sites.workspaceId, ctx.principal.workspaceId), input.includeArchived ? undefined : eq(schema.sites.archived, false)),
      )
      .orderBy(desc(schema.sites.createdAt), asc(schema.sites.id));
    return { sites: rows.map(siteView) };
  },
});

export const getSite = defineCommand({
  name: 'sites.get',
  title: 'Get a site',
  description: 'One site with its verification state, and the id of its active site context artifact when one exists.',
  input: z.object({ siteId: SiteId }),
  output: z.object({ site: SiteSchema.extend({ contextArtifactId: z.string().nullable() }) }),
  permission: 'sites:read',
  effect: 'read',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx, input.siteId, { includeArchived: true });
    return {
      site: {
        ...siteView(site),
        contextArtifactId: await contextArtifactId(ctx.tx, ctx.principal.workspaceId, site.id),
      },
    };
  },
});

export const createSite = defineCommand({
  name: 'sites.create',
  title: 'Create a site',
  description:
    'Add a website to the workspace. The domain is normalised (lower-case ASCII, no scheme, path, port or trailing dot). A site needs ownership verification before audits can change anything.',
  input: z.object({
    name: z.string().min(1).max(120).describe('A name a person recognises, e.g. "Acme store"'),
    domain: z.string().min(1).max(253).describe('The primary domain, e.g. example.com'),
  }),
  output: z.object({ site: SiteSchema }),
  permission: 'sites:write',
  effect: 'write',
  actionClass: 'settings',
  auditTarget: (output) => output.site.id,
  handler: async (input, ctx) => {
    const domain = normalizeDomain(input.domain);
    const ws = ctx.principal.workspaceId;
    const [existing] = await ctx.tx
      .select({ id: schema.sites.id, name: schema.sites.name })
      .from(schema.sites)
      .where(and(eq(schema.sites.workspaceId, ws), eq(schema.sites.primaryDomain, domain), eq(schema.sites.archived, false)));
    if (existing)
      throw new AppError(
        'conflict',
        `This workspace already tracks ${domain} as “${existing.name}” (${existing.id}). Edit that site instead of adding a second one.`,
      );

    const row = {
      workspaceId: ws,
      id: newUuid(),
      name: input.name.trim(),
      primaryDomain: domain,
      hosts: [] as string[],
      verificationToken: newVerificationToken(),
    };
    try {
      const [site] = await ctx.tx.insert(schema.sites).values(row).returning();
      return { site: siteView(site!) };
    } catch (error) {
      // The pre-check answers the common case with a readable message; the partial unique index is
      // what holds when two creations race, and its 23505 becomes the same conflict.
      if (isUniqueViolation(error, 'sites_active_domain'))
        throw new AppError('conflict', `This workspace already tracks ${domain}. Edit that site instead of adding a second one.`);
      throw error;
    }
  },
});

export const updateSite = defineCommand({
  name: 'sites.update',
  title: 'Update a site',
  description:
    'Change a site’s name, extra hosts, business type or local-business flag. A host has to be the primary domain or a subdomain of it.',
  input: z.object({
    siteId: SiteId,
    name: z.string().min(1).max(120).optional(),
    hosts: z
      .array(z.string().min(1).max(253))
      .max(50)
      .optional()
      .describe('Extra hosts the site answers on, e.g. www.example.com; the primary domain is implied'),
    businessType: BusinessTypeEnum.nullable().optional().describe('Confirmed business type; null clears it'),
    isLocalBusiness: z.boolean().optional(),
  }),
  output: z.object({ site: SiteSchema }),
  permission: 'sites:write',
  effect: 'write',
  actionClass: 'settings',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx, input.siteId);
    const changes: Partial<typeof schema.sites.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) changes.name = input.name.trim();
    if (input.hosts !== undefined) {
      const hosts = [...new Set(input.hosts.map(normalizeHost))].filter((host) => host !== site.primaryDomain);
      for (const host of hosts)
        if (!isHostOfDomain(host, site.primaryDomain))
          throw new AppError(
            'invalid_input',
            `${host} is not part of ${site.primaryDomain}. A host has to be the primary domain or a subdomain of it, such as www.${site.primaryDomain}.`,
          );
      changes.hosts = hosts;
    }
    if (input.businessType !== undefined) changes.businessType = input.businessType;
    if (input.isLocalBusiness !== undefined) changes.isLocalBusiness = input.isLocalBusiness;

    const [updated] = await ctx.tx
      .update(schema.sites)
      .set(changes)
      .where(and(eq(schema.sites.workspaceId, ctx.principal.workspaceId), eq(schema.sites.id, site.id)))
      .returning();
    return { site: siteView(updated!) };
  },
});

export const archiveSite = defineCommand({
  name: 'sites.archive',
  title: 'Archive a site',
  description:
    'Archive a site so it leaves the site list and stops accepting changes. Sites are archived, never deleted, because artifacts, learnings and provider calls point at them.',
  input: z.object({ siteId: SiteId }),
  output: z.object({ site: SiteSchema }),
  permission: 'sites:write',
  effect: 'write',
  actionClass: 'settings',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx, input.siteId, { includeArchived: true });
    if (site.archived) return { site: siteView(site) };
    const [updated] = await ctx.tx
      .update(schema.sites)
      .set({ archived: true, updatedAt: new Date() })
      .where(and(eq(schema.sites.workspaceId, ctx.principal.workspaceId), eq(schema.sites.id, site.id)))
      .returning();
    return { site: siteView(updated!) };
  },
});

export const siteVerification = defineCommand({
  name: 'sites.verification',
  title: 'Site verification instructions',
  description:
    'The site’s verification token and both ways to publish it: a DNS TXT record on the primary domain, and a meta tag in the home page head. The token never rotates silently; this reads it.',
  input: z.object({ siteId: SiteId }),
  output: z.object({
    siteId: z.string(),
    domain: z.string(),
    token: z.string(),
    dns: z.object({
      type: z.literal('TXT'),
      name: z.string(),
      value: z.string(),
      instructions: z.string(),
    }),
    meta: z.object({
      name: z.string(),
      content: z.string(),
      instructions: z.string(),
    }),
    verified: z.boolean(),
    verifiedAt: z.string().nullable(),
    verificationMethod: z.enum(['dns', 'meta']).nullable(),
    lastCheckAt: z.string().nullable(),
    lastCheckError: z.string().nullable(),
  }),
  permission: 'sites:read',
  effect: 'read',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx, input.siteId, { includeArchived: true });
    const value = dnsRecordValue(site.verificationToken);
    return {
      siteId: site.id,
      domain: site.primaryDomain,
      token: site.verificationToken,
      dns: {
        type: 'TXT' as const,
        name: site.primaryDomain,
        value,
        instructions: `Add a TXT record named “${site.primaryDomain}” (the root, often shown as @) with the value “${value}”. Keep any existing records apart from this one.`,
      },
      meta: {
        name: VERIFICATION_NAME,
        content: site.verificationToken,
        instructions: `Add <meta name="${VERIFICATION_NAME}" content="${site.verificationToken}"> inside the <head> of https://${site.primaryDomain}/, then deploy the page.`,
      },
      verified: site.verifiedAt !== null,
      verifiedAt: iso(site.verifiedAt),
      verificationMethod: site.verificationMethod,
      lastCheckAt: iso(site.lastCheckAt),
      lastCheckError: site.lastCheckError,
    };
  },
});

export const verifySite = defineCommand({
  name: 'sites.verify',
  title: 'Check site ownership',
  description:
    'Check the DNS TXT record first, then the home page meta tag. Records the verification or the reason it failed; a site that was verified stays verified when the record later disappears in Phase 0.',
  input: z.object({ siteId: SiteId }),
  output: z.object({
    siteId: z.string(),
    verified: z.boolean(),
    method: z.enum(['dns', 'meta']).nullable(),
    checkedAt: z.string(),
    error: z.string().nullable(),
  }),
  permission: 'sites:write',
  effect: 'write',
  actionClass: 'settings',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx, input.siteId);
    const token = site.verificationToken;
    const checkedAt = new Date();

    // Phase 0 keeps a verified site verified when a re-check fails: a DNS record a provider drops,
    // or a deploy that removes the meta tag, is evidence about the record, not proof the owner
    // changed. The failure is recorded in last_check_error for a person to act on (a later phase
    // can alert on it); silently un-verifying would hide the site's data and stop agents mid-loop.
    const dns = await checkDnsRecord(site.primaryDomain, token);
    let method: VerificationMethod | null = dns.ok ? 'dns' : null;
    let error: string | null = null;
    if (!dns.ok) {
      const meta = await checkMetaTag(site.primaryDomain, siteHosts(site), token);
      if (meta.ok) method = 'meta';
      else error = `Ownership of ${site.primaryDomain} is not verified yet. DNS: ${dns.error} Meta tag: ${meta.error}`;
    }

    const [updated] = await ctx.tx
      .update(schema.sites)
      .set(
        method
          ? {
              verifiedAt: site.verifiedAt ?? checkedAt,
              verifiedBy: site.verifiedBy ?? ctx.principal.userId,
              verificationMethod: method,
              lastCheckAt: checkedAt,
              lastCheckError: null,
              updatedAt: checkedAt,
            }
          : { lastCheckAt: checkedAt, lastCheckError: error, updatedAt: checkedAt },
      )
      .where(and(eq(schema.sites.workspaceId, ctx.principal.workspaceId), eq(schema.sites.id, site.id)))
      .returning();

    return {
      siteId: site.id,
      verified: updated!.verifiedAt !== null,
      method,
      checkedAt: checkedAt.toISOString(),
      error,
    };
  },
});

export const siteChecklist = defineCommand({
  name: 'sites.checklist',
  title: 'Site setup checklist',
  description:
    'The facts behind the setup checklist: whether the site is verified, how many competitors it has, whether Search Console and a site connector are connected, how many audits ran, and whether a DataForSEO key is stored.',
  input: z.object({ siteId: SiteId }),
  output: z.object({
    siteVerified: z.boolean(),
    searchConsole: z.boolean(),
    competitors: z.number().int(),
    audits: z.number().int(),
    dataForSeoKey: z.boolean(),
    siteConnector: z.boolean(),
  }),
  permission: 'sites:read',
  effect: 'read',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx, input.siteId, { includeArchived: true });
    const ws = ctx.principal.workspaceId;
    const [competitors] = await ctx.tx
      .select({ value: count() })
      .from(schema.competitors)
      .where(and(eq(schema.competitors.workspaceId, ws), eq(schema.competitors.siteId, site.id)));
    // The credential name is the one the provider ports unlock with (`dataforseo.login`), so the
    // checklist answers for the same key the gateway would spend. Values stay unreadable.
    const [key] = await ctx.tx
      .select({ name: schema.secrets.name })
      .from(schema.secrets)
      .where(and(eq(schema.secrets.workspaceId, ws), eq(schema.secrets.name, 'dataforseo.login')))
      .limit(1);
    // Search Console counts as connected only when the authorization is active *and* a property is
    // selected: without a property the sync has nothing to read. `google-search-console` is the
    // connector id packages/integrations registers (GSC_CONNECTOR_ID); sites does not depend on it
    // just for this one fact.
    const [gsc] = await ctx.tx
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.workspaceId, ws),
          eq(schema.connections.siteId, site.id),
          eq(schema.connections.connector, 'google-search-console'),
          eq(schema.connections.state, 'active'),
          sql`${schema.connections.settings} ->> 'property' IS NOT NULL`,
        ),
      )
      .limit(1);
    // A site connector is the change set's way in (ADR-0007): 'github' is the only one Phase 1
    // ships, registered by packages/change-sets. Active only: a revoked connection applies nothing.
    const [siteConnector] = await ctx.tx
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.workspaceId, ws),
          eq(schema.connections.siteId, site.id),
          eq(schema.connections.connector, 'github'),
          eq(schema.connections.state, 'active'),
        ),
      )
      .limit(1);
    return {
      siteVerified: site.verifiedAt !== null,
      searchConsole: gsc !== undefined,
      competitors: competitors?.value ?? 0,
      // Audits arrive with the crawler, so the count is honestly zero.
      audits: 0,
      dataForSeoKey: key !== undefined,
      siteConnector: siteConnector !== undefined,
    };
  },
});

export const listMarkets = defineCommand({
  name: 'markets.list',
  title: 'List markets',
  description: 'The location and language pairs a site targets, default market first.',
  input: z.object({ siteId: SiteId }),
  output: z.object({ markets: z.array(MarketSchema) }),
  permission: 'sites:read',
  effect: 'read',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    await loadSite(ctx, input.siteId, { includeArchived: true });
    const rows = await ctx.tx
      .select()
      .from(schema.markets)
      .where(and(eq(schema.markets.workspaceId, ctx.principal.workspaceId), eq(schema.markets.siteId, input.siteId)))
      .orderBy(desc(schema.markets.isDefault), asc(schema.markets.createdAt), asc(schema.markets.id));
    return { markets: rows.map(marketView) };
  },
});

const countryCode = z
  .string()
  .regex(/^[A-Z]{3}$/, 'a three-letter country code, e.g. USA')
  .describe('ISO 3166-1 alpha-3 country code for Search Console');

export const addMarket = defineCommand({
  name: 'markets.add',
  title: 'Add a market',
  description:
    'Add a location and language pair to a site. The first market of a site becomes its default; pass isDefault to replace the current default.',
  input: z.object({
    siteId: SiteId,
    locationCode: z.number().int().positive().describe('DataForSEO location code, e.g. 2840 for the United States'),
    languageCode: z.string().min(2).max(16).describe('Language code, e.g. en'),
    gscCountry: countryCode.nullable().optional(),
    name: z.string().min(1).max(120).describe('A name a person recognises, e.g. "United States — English"'),
    isDefault: z.boolean().optional(),
  }),
  output: z.object({ market: MarketSchema }),
  permission: 'sites:write',
  effect: 'write',
  actionClass: 'settings',
  auditTarget: (output) => output.market.id,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx, input.siteId);
    await lockSiteLists(ctx, site.id);
    const ws = ctx.principal.workspaceId;
    const [duplicate] = await ctx.tx
      .select({ id: schema.markets.id })
      .from(schema.markets)
      .where(
        and(
          eq(schema.markets.workspaceId, ws),
          eq(schema.markets.siteId, site.id),
          eq(schema.markets.locationCode, input.locationCode),
          eq(schema.markets.languageCode, input.languageCode),
        ),
      );
    if (duplicate)
      throw new AppError(
        'conflict',
        `This site already has a market for location ${input.locationCode} in language "${input.languageCode}" (${duplicate.id}). Edit it instead.`,
      );

    const [existing] = await ctx.tx
      .select({ value: count() })
      .from(schema.markets)
      .where(and(eq(schema.markets.workspaceId, ws), eq(schema.markets.siteId, site.id)));
    const isDefault = input.isDefault ?? (existing?.value ?? 0) === 0;
    if (isDefault) await clearDefaultMarket(ctx, site.id);

    const [market] = await ctx.tx
      .insert(schema.markets)
      .values({
        workspaceId: ws,
        id: newUuid(),
        siteId: site.id,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        gscCountry: input.gscCountry ?? null,
        name: input.name.trim(),
        isDefault,
      })
      .returning();
    return { market: marketView(market!) };
  },
});

async function clearDefaultMarket(ctx: CommandContext, siteId: string) {
  await ctx.tx
    .update(schema.markets)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(
      and(eq(schema.markets.workspaceId, ctx.principal.workspaceId), eq(schema.markets.siteId, siteId), eq(schema.markets.isDefault, true)),
    );
}

export const updateMarket = defineCommand({
  name: 'markets.update',
  title: 'Update a market',
  description:
    'Change a market’s location, language, Search Console country, name or default flag. Only one market per site is the default.',
  input: z.object({
    siteId: SiteId,
    marketId: MarketId,
    locationCode: z.number().int().positive().optional(),
    languageCode: z.string().min(2).max(16).optional(),
    gscCountry: countryCode.nullable().optional(),
    name: z.string().min(1).max(120).optional(),
    isDefault: z.boolean().optional(),
  }),
  output: z.object({ market: MarketSchema }),
  permission: 'sites:write',
  effect: 'write',
  actionClass: 'settings',
  target: (input) => input.marketId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx, input.siteId);
    await lockSiteLists(ctx, site.id);
    const ws = ctx.principal.workspaceId;
    const [market] = await ctx.tx
      .select()
      .from(schema.markets)
      .where(and(eq(schema.markets.workspaceId, ws), eq(schema.markets.siteId, site.id), eq(schema.markets.id, input.marketId)));
    if (!market) throw new AppError('not_found', `Market ${input.marketId} does not exist on this site.`);

    const locationCode = input.locationCode ?? market.locationCode;
    const languageCode = input.languageCode ?? market.languageCode;
    if (locationCode !== market.locationCode || languageCode !== market.languageCode) {
      const [duplicate] = await ctx.tx
        .select({ id: schema.markets.id })
        .from(schema.markets)
        .where(
          and(
            eq(schema.markets.workspaceId, ws),
            eq(schema.markets.siteId, site.id),
            eq(schema.markets.locationCode, locationCode),
            eq(schema.markets.languageCode, languageCode),
          ),
        );
      if (duplicate && duplicate.id !== market.id)
        throw new AppError(
          'conflict',
          `This site already has a market for location ${locationCode} in language "${languageCode}" (${duplicate.id}).`,
        );
    }
    if (input.isDefault === true && !market.isDefault) await clearDefaultMarket(ctx, site.id);

    const [updated] = await ctx.tx
      .update(schema.markets)
      .set({
        locationCode,
        languageCode,
        gscCountry: input.gscCountry === undefined ? market.gscCountry : input.gscCountry,
        name: input.name?.trim() ?? market.name,
        isDefault: input.isDefault ?? market.isDefault,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.markets.workspaceId, ws), eq(schema.markets.id, market.id)))
      .returning();
    return { market: marketView(updated!) };
  },
});

export const removeMarket = defineCommand({
  name: 'markets.remove',
  title: 'Remove a market',
  description: 'Remove a market from a site. When it was the default, the oldest remaining market becomes the default.',
  input: z.object({ siteId: SiteId, marketId: MarketId }),
  output: z.object({ marketId: z.string(), removed: z.boolean() }),
  permission: 'sites:write',
  effect: 'write',
  actionClass: 'settings',
  target: (input) => input.marketId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx, input.siteId);
    await lockSiteLists(ctx, site.id);
    const ws = ctx.principal.workspaceId;
    const [market] = await ctx.tx
      .select()
      .from(schema.markets)
      .where(and(eq(schema.markets.workspaceId, ws), eq(schema.markets.siteId, site.id), eq(schema.markets.id, input.marketId)));
    if (!market) throw new AppError('not_found', `Market ${input.marketId} does not exist on this site.`);

    await ctx.tx.delete(schema.markets).where(and(eq(schema.markets.workspaceId, ws), eq(schema.markets.id, market.id)));
    if (market.isDefault) {
      const [next] = await ctx.tx
        .select({ id: schema.markets.id })
        .from(schema.markets)
        .where(and(eq(schema.markets.workspaceId, ws), eq(schema.markets.siteId, site.id)))
        .orderBy(asc(schema.markets.createdAt), asc(schema.markets.id))
        .limit(1);
      if (next) await ctx.tx.update(schema.markets).set({ isDefault: true, updatedAt: new Date() }).where(eq(schema.markets.id, next.id));
    }
    return { marketId: market.id, removed: true };
  },
});

export const listCompetitors = defineCommand({
  name: 'competitors.list',
  title: 'List competitors',
  description: 'The domains a site tracks as competitors, newest first.',
  input: z.object({ siteId: SiteId }),
  output: z.object({ competitors: z.array(CompetitorSchema) }),
  permission: 'sites:read',
  effect: 'read',
  target: (input) => input.siteId,
  handler: async (input, ctx) => {
    await loadSite(ctx, input.siteId, { includeArchived: true });
    const rows = await ctx.tx
      .select()
      .from(schema.competitors)
      .where(and(eq(schema.competitors.workspaceId, ctx.principal.workspaceId), eq(schema.competitors.siteId, input.siteId)))
      .orderBy(desc(schema.competitors.createdAt), asc(schema.competitors.id));
    return { competitors: rows.map(competitorView) };
  },
});

export const addCompetitor = defineCommand({
  name: 'competitors.add',
  title: 'Add a competitor',
  description: 'Track another domain as a competitor of this site. The domain is normalised the same way as a site’s.',
  input: z.object({
    siteId: SiteId,
    domain: z.string().min(1).max(253).describe('The competitor’s domain, e.g. competitor.com'),
    name: z.string().min(1).max(120).nullable().optional(),
    source: z.enum(['manual', 'detected']).default('manual').describe('How the competitor was found'),
  }),
  output: z.object({ competitor: CompetitorSchema }),
  permission: 'sites:write',
  effect: 'write',
  actionClass: 'settings',
  auditTarget: (output) => output.competitor.id,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx, input.siteId);
    const domain = normalizeDomain(input.domain);
    if (domain === site.primaryDomain)
      throw new AppError('invalid_input', `${domain} is this site’s own domain; a competitor has to be a different one.`);
    await lockSiteLists(ctx, site.id);
    const ws = ctx.principal.workspaceId;
    const [duplicate] = await ctx.tx
      .select({ id: schema.competitors.id })
      .from(schema.competitors)
      .where(and(eq(schema.competitors.workspaceId, ws), eq(schema.competitors.siteId, site.id), eq(schema.competitors.domain, domain)));
    if (duplicate) throw new AppError('conflict', `${domain} is already a competitor of this site (${duplicate.id}).`);

    const [competitor] = await ctx.tx
      .insert(schema.competitors)
      .values({
        workspaceId: ws,
        id: newUuid(),
        siteId: site.id,
        domain,
        name: input.name ?? null,
        source: input.source,
      })
      .returning();
    return { competitor: competitorView(competitor!) };
  },
});

export const removeCompetitor = defineCommand({
  name: 'competitors.remove',
  title: 'Remove a competitor',
  description: 'Stop tracking a competitor on this site.',
  input: z.object({ siteId: SiteId, competitorId: CompetitorId }),
  output: z.object({ competitorId: z.string(), removed: z.boolean() }),
  permission: 'sites:write',
  effect: 'write',
  actionClass: 'settings',
  target: (input) => input.competitorId,
  handler: async (input, ctx) => {
    const site = await loadSite(ctx, input.siteId);
    const ws = ctx.principal.workspaceId;
    const [competitor] = await ctx.tx
      .select()
      .from(schema.competitors)
      .where(
        and(eq(schema.competitors.workspaceId, ws), eq(schema.competitors.siteId, site.id), eq(schema.competitors.id, input.competitorId)),
      );
    if (!competitor) throw new AppError('not_found', `Competitor ${input.competitorId} does not exist on this site.`);
    await ctx.tx.delete(schema.competitors).where(and(eq(schema.competitors.workspaceId, ws), eq(schema.competitors.id, competitor.id)));
    return { competitorId: competitor.id, removed: true };
  },
});

/** Every command this package adds to the registry, in the order they are listed. */
export const siteCommands = [
  listSites,
  getSite,
  createSite,
  updateSite,
  archiveSite,
  siteVerification,
  verifySite,
  siteChecklist,
  listMarkets,
  addMarket,
  updateMarket,
  removeMarket,
  listCompetitors,
  addCompetitor,
  removeCompetitor,
] as const;

export const sitesCommands = siteCommands;
