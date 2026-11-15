import { completeAuthorization, type OAuthDeps } from '@agentic-seo/integrations';
import type { Context, Handler } from 'hono';
import { oauthCallbackPage, pageNonce, pagesCsp } from './pages';

// GET /oauth/callback: the Google authorization returns here with a code and the state this server
// issued. The state is verified and consumed in the OAuth package; this route only renders the
// result. The URL carries a one-time code and the state, so the shell sets no-referrer for it.

export function oauthCallbackRoute(deps: OAuthDeps): Handler {
  return async (c: Context) => {
    const nonce = pageNonce();
    c.header('Content-Security-Policy', pagesCsp(nonce));
    const state = c.req.query('state') ?? '';
    if (!state) {
      return c.html(
        oauthCallbackPage(
          nonce,
          'Not connected',
          'Google sent no authorization state. Start connecting again from the site’s Search Console settings.',
        ),
        400,
      );
    }
    const result = await completeAuthorization(deps, {
      state,
      code: c.req.query('code'),
      error: c.req.query('error'),
      errorDescription: c.req.query('error_description'),
    });
    return c.html(oauthCallbackPage(nonce, result.ok ? 'Connected' : 'Not connected', result.text), result.ok ? 200 : 400);
  };
}
