import { defineCheck } from '../check';
import { isOkHtml } from '../indexability';
import { fail, notApplicable, pass } from '../outcome';

// Security: whether the page and its subresources travel encrypted
// (crawler-and-audits.md §5 "Security").

const HTTPS = 'https://developers.google.com/search/docs/crawling-indexing/https';
const MIXED_CONTENT = 'https://www.w3.org/TR/mixed-content/';
const MDN_MIXED = 'https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content';
const HSTS = 'https://www.rfc-editor.org/rfc/rfc6797';

export const httpsNotUsed = defineCheck({
  id: 'https.not_used',
  title: 'The page is served over http',
  category: 'security',
  severity: 'high',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  explain:
    'The page was served over http. Traffic is readable and modifiable in transit, and browsers mark the page as not secure. Serve every page over https and redirect http to it.',
  references: [HTTPS, HSTS],
  run: (page) => {
    if (page.finalUrl.startsWith('https://')) return pass();
    return fail({ subject: page.url, value: page.finalUrl, expected: 'the same page served over https' });
  },
});

export const httpsMixedContent = defineCheck({
  id: 'https.mixed_content',
  title: 'The page loads a subresource over http',
  category: 'security',
  severity: 'medium',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'An https page loads a subresource over http. Browsers may block it or warn about it, and the page loses its secure context. Load the resource over https.',
  references: [MIXED_CONTENT, MDN_MIXED],
  run: (page) => {
    const resources = page.html?.mixedContent ?? [];
    if (!resources.length) return pass();
    return fail(
      resources.map((resource) => ({
        subject: page.finalUrl,
        value: resource,
        expected: 'the resource loaded over https',
        detail: 'Loaded over http on an https page.',
      })),
    );
  },
});

export const httpsInsecureForm = defineCheck({
  id: 'https.insecure_form',
  title: 'A form submits to an http URL',
  category: 'security',
  severity: 'high',
  scope: 'page',
  kind: 'deterministic',
  evaluator: 'page',
  appliesTo: isOkHtml,
  explain:
    'A form submits to an http URL. The submitted data travels unencrypted and browsers warn before sending it. Post the form to an https URL.',
  references: [MIXED_CONTENT, HTTPS],
  run: (page) => {
    const actions = page.html?.insecureForms ?? [];
    if (!actions.length) return pass();
    return fail(
      actions.map((action) => ({
        subject: page.finalUrl,
        value: action,
        expected: 'a form action on https',
      })),
    );
  },
});

export const httpsNoHsts = defineCheck({
  id: 'https.no_hsts',
  title: 'The home page does not send HSTS',
  category: 'security',
  severity: 'low',
  scope: 'site',
  kind: 'deterministic',
  evaluator: 'site',
  explain:
    'The home page does not send a Strict-Transport-Security header. Without it a browser may still try http first, which leaves room for an interception. Send HSTS with a long max-age once https works everywhere.',
  references: [HSTS, HTTPS],
  run: (site) => {
    const home = site.home;
    if (!home) return notApplicable('The home page was not fetched, so its headers are unknown.');
    if (!home.finalUrl.startsWith('https://')) return notApplicable('The home page is not served over https; https.not_used covers that.');
    const header = home.headers.strictTransportSecurity;
    if (header !== null && header.trim() !== '') return pass();
    return fail({
      subject: home.finalUrl,
      value: 'no Strict-Transport-Security header',
      expected: 'Strict-Transport-Security with a long max-age',
    });
  },
});

export const securityChecks = [httpsNotUsed, httpsMixedContent, httpsInsecureForm, httpsNoHsts] as const;
