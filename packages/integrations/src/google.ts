import { z } from 'zod';
import { defineConnector, registerConnector } from './sdk';

// Google Search Console (data-providers.md §5). One OAuth client per installation, one read-only
// scope, and per-site tokens. The selected property is a setting, because the person chooses it
// after the authorization (search.gsc.select) and a token may see several properties.

/** The only scope this task requests. `analytics.readonly` and `indexing` arrive with their phases. */
export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

export const googleSearchConsoleSettings = z.object({
  property: z
    .string()
    .min(1)
    .nullable()
    .default(null)
    .describe('The Search Console property the site reads, e.g. "sc-domain:example.com"; null until a person selects one'),
});
export type GoogleSearchConsoleSettings = z.infer<typeof googleSearchConsoleSettings>;

export const googleOAuthEndpoints = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  scopes: [GSC_SCOPE],
  // `offline` is what makes Google return a refresh token; `consent` forces one again when a person
  // reconnects after a revoke (Google otherwise remembers the earlier grant).
  params: { access_type: 'offline', prompt: 'consent' },
};

export const googleSearchConsole = defineConnector({
  id: 'google-search-console',
  label: 'Google Search Console',
  description: 'Read clicks, impressions, click-through rate and position for one property of this site.',
  auth: 'oauth2',
  oauthClient: 'installation',
  oauth: () => googleOAuthEndpoints,
  settings: googleSearchConsoleSettings,
  // OAuth tokens are sealed under `__oauth`; future connectors may store other keys here.
  secrets: z.record(z.string(), z.unknown()),
});

registerConnector(googleSearchConsole);

/** The connector id stored on every GSC connection; a later GA4 connection is a different id. */
export const GSC_CONNECTOR_ID = googleSearchConsole.id;
