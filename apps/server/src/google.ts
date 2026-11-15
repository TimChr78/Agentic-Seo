import { AppError } from '@agentic-seo/core';
import type { Db } from '@agentic-seo/db';
import { accessTokenForConnection, type OAuthDeps } from '@agentic-seo/integrations';
import { createGoogleSearchConsoleAdapter, type ProviderAdapter } from '@agentic-seo/providers';
import type { KeyProvider } from '@agentic-seo/secrets';
import type { Config } from './config';

// The Google wiring shared by the API server and the worker. One OAuth client per installation
// (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET) and one adapter whose credential seam reads
// the connection's sealed tokens and refreshes them when they are about to expire. The adapter
// never touches the database; this file is the seam that does.

export const GOOGLE_SETUP_DOC = 'docs/setup/google-search-console.md';

/** The OAuth dependencies, or null when this install has no Google client configured yet. */
export function googleOAuthDeps(config: Config, db: Db, kp: KeyProvider): OAuthDeps | null {
  if (!config.googleOAuth) return null;
  return { db, kp, client: config.googleOAuth, publicUrl: config.publicUrl };
}

/**
 * The configured provider adapters. The GSC adapter is registered even without an OAuth client, so
 * a call to the port names the missing configuration instead of pretending no adapter exists.
 */
export function providerAdapters(config: Config, db: Db, kp: KeyProvider): ProviderAdapter[] {
  const oauth = googleOAuthDeps(config, db, kp);
  return [
    createGoogleSearchConsoleAdapter({
      accessToken: async ({ workspaceId, credentialKey }) => {
        if (!oauth)
          throw new AppError(
            'precondition_failed',
            `Google Search Console is not set up on this server. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, then restart (${GOOGLE_SETUP_DOC}).`,
          );
        return accessTokenForConnection(oauth, { workspaceId, connectionId: credentialKey });
      },
    }),
  ];
}
