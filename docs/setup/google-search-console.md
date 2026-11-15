# Connect Google Search Console

Search Console is free and needs one OAuth client per installation. The client belongs to the
person who runs Agentic SEO; sites are then connected individually, and each connection gets its
own tokens.

## 1. Create the OAuth client

1. Open the [Google Cloud console](https://console.cloud.google.com/) and pick (or create) a project.
2. Under **APIs & services → Library**, enable **Google Search Console API**.
3. Under **APIs & services → OAuth consent screen**, configure an external app with the scope
   `https://www.googleapis.com/auth/webmasters.readonly` (Google calls it `webmasters.readonly`).
4. Under **APIs & services → Credentials → Create credentials → OAuth client ID**, choose
   **Web application** and add this authorised redirect URI:

   ```
   <PUBLIC_URL>/oauth/callback
   ```

   `PUBLIC_URL` is the address in your `.env`, for example `https://seo.example.com`. Google
   matches it exactly: no trailing slash after `callback`, and the same scheme.

5. Copy the client id and client secret into `.env`:

   ```
   GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=...
   ```

6. Restart the server. `aseo doctor` reports `google.oauth` as configured. Without these two
   settings the rest of the product works; connecting a site answers with the two names that are
   missing.

## 2. Connect a site

1. `search.gsc.connect` returns a Google URL. Open it, sign in with the account that can read the
   site's Search Console property, and allow read-only access. Google returns you to
   `/oauth/callback`, which seals the tokens on the site's connection.
2. `search.gsc.properties` lists the properties that account can read and marks the ones that match
   the site's domain.
3. `search.gsc.select` stores the chosen property. `search.gsc.sync` queues the first sync, which
   backfills 16 months; the daily job refreshes the last few provisional days afterwards.
4. `sites.checklist` shows Search Console as connected once an active connection has a property.

Only a person can connect, select a property or disconnect: these are `settings` changes, which an
agent can never make ([agents-and-autonomy.md](../architecture/agents-and-autonomy.md) §3).

## What is stored, and what is not

The OAuth tokens are sealed with the workspace's secrets key and are never returned by any command,
logged or passed to a model. Disconnecting revokes the token at Google and drops the sealed copy;
the search data already synced is kept. Access tokens are refreshed automatically a few minutes
before they expire. A refused refresh marks the connection `error` and
`search.gsc.status` shows “Google refused the refresh token; reconnect Search Console”.
