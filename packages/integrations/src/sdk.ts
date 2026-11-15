import { AppError } from '@agentic-seo/core';
import type { z } from 'zod';

// The connector SDK (data-providers.md §5, ported from Agentic Marketing's packages/integrations
// `sdk.ts`). A connector declares its settings and secrets as schemas and, for OAuth 2.0, the
// provider's endpoints and scopes. It never touches the database or the network itself: the
// package stores the connection and performs the authorization; a connector only describes it.
//
// Inbound webhooks, deliveries and marketing connectors are not ported. A later task adds the
// GitHub connector by calling `registerConnector` at startup, so this list stays open.

/**
 * How a connector authenticates.
 * - `oauth2`: an authorization code flow with PKCE; the installation's OAuth client comes from
 *   server config for Google, a per-connection app for providers that require one.
 * - `api_key`: the secrets schema holds the key.
 * - `none`: nothing to authorize.
 */
export type ConnectorAuth = 'oauth2' | 'api_key' | 'none';

/**
 * Where an OAuth connector's client id and secret come from.
 * - `installation`: one OAuth client for the whole install (Google Search Console).
 * - `connection`: the person stores the app's credentials on the connection.
 */
export type OAuthClientSource = 'installation' | 'connection';

export interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  /** Some providers revoke at a different endpoint; Google's is /revoke. */
  revokeUrl?: string;
  scopes: string[];
  /** Extra authorize parameters, e.g. `access_type: offline` so Google returns a refresh token. */
  params?: Record<string, string>;
}

export interface Connector<S = Record<string, unknown>, K = Record<string, unknown>> {
  /** Stable id, stored on the connection and used in its unique key, e.g. "google-search-console". */
  id: string;
  label: string;
  /** One sentence for a person choosing a connection. */
  description: string;
  auth: ConnectorAuth;
  /** Only for `auth: 'oauth2'`; a connection cannot be authorized without it. */
  oauth?: (settings: S) => OAuthEndpoints;
  oauthClient?: OAuthClientSource;
  /** Settings the person chooses, such as the selected property. Shown by the UI, REST and MCP. */
  settings: z.ZodType<S>;
  /** What is sealed. OAuth tokens live under `__oauth` and are never returned by a command. */
  secrets: z.ZodType<K>;
}

export function defineConnector<S, K>(connector: Connector<S, K>): Connector<S, K> {
  return connector;
}

const registry = new Map<string, Connector>();

/**
 * Adds a connector to the installation's registry. Called once at package load for the connectors
 * this package ships, and by later packages (the GitHub connector) from their own startup. A
 * duplicate id is a programming error, not a request failure.
 */
export function registerConnector<S, K>(connector: Connector<S, K>): Connector<S, K> {
  if (registry.has(connector.id)) throw new Error(`Two connectors share the id "${connector.id}".`);
  // The concrete settings/secrets types are each connector's own; the registry only needs identity.
  registry.set(connector.id, connector as Connector);
  return connector;
}

export function connectorOf(id: string): Connector {
  const connector = registry.get(id);
  if (!connector) {
    const known = [...registry.keys()].sort().join(', ') || 'none';
    throw new AppError('invalid_input', `Unknown connector "${id}". Installed connectors: ${known}.`);
  }
  return connector;
}

export function hasConnector(id: string): boolean {
  return registry.has(id);
}

/** Every installed connector, in id order, for a settings screen or a future connectors.list. */
export function connectorList(): Connector[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}
