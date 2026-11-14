import { RefreshCw, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api, errText, type VerifyResult } from '../app/api';
import { useCrumbs } from '../app/page';
import { useSession, useSite } from '../app/session';
import { useKeyedApi } from '../app/useApi';
import { Alert, Button, Card, CodeView, CopyButton, Meta, Mono, PageHeader, StatusPill } from '../ui';
import { pageWidth } from '../ui/layout';
import { formatDateTime } from '../ui/time';

/**
 * Settings → Site: ownership verification (DESIGN.md §3, Phase 0). One token, two ways to publish
 * it — a DNS TXT record on the primary domain or a meta tag in the home page's head. "Check now"
 * calls `sites.verify`, which reads the record first and the page second, and the screen shows
 * either the verification with its method and time, or the server's own reason it failed.
 */
export default function SitePage() {
  useCrumbs([{ label: 'Site' }]);
  const { site } = useSite();
  // Keyed by site: switching sites remounts the screen, so a finished or still-running check of the
  // previous site can never show (or later land) as this site's result.
  return <SiteVerification key={site.id} />;
}

function SiteVerification() {
  const { site, refresh } = useSite();
  const { can } = useSession();
  // Keyed by site: a check on another site's screen never shows this site's result.
  const verification = useKeyedApi(site.id, () => api.getVerification(site.id));
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const canCheck = can('sites:write');

  const checkNow = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const outcome = await api.verifySite(site.id);
      setResult(outcome);
      // Re-read the instructions so the last check's time and reason are the server's, not ours.
      await verification.reload();
      // A verified site changes the checklist and the switcher's badge, which read the session.
      if (outcome.verified) await refresh();
    } catch (error) {
      setCheckError(errText(error));
    } finally {
      setChecking(false);
    }
  };

  const data = verification.data;
  const verified = result?.verified ?? data?.verified ?? site.verified;
  const method = verified ? (result?.method ?? data?.verificationMethod ?? null) : null;
  const verifiedAt = data?.verifiedAt ?? null;
  const lastCheckAt = data?.lastCheckAt ?? null;
  const lastError = result && !result.verified ? result.error : (data?.lastCheckError ?? null);

  const header = (
    <PageHeader
      title="Site"
      description="How this site is identified, and who has proved they own it."
      meta={
        <>
          <span className="font-medium text-fg-2">{site.name}</span>
          <span aria-hidden>·</span>
          <span>{site.domain}</span>
          {verified ? <StatusPill tone="good">Verified</StatusPill> : <StatusPill tone="warn">Not verified</StatusPill>}
        </>
      }
    />
  );

  if (data === undefined) {
    return (
      <div className={pageWidth('default')}>
        {header}
        {verification.error ? (
          <Alert tone="bad" title="Couldn't load the verification details" onRetry={() => void verification.reload()}>
            {verification.error}
          </Alert>
        ) : (
          <Card>
            <div className="p-4 md:p-5" aria-busy="true">
              <p className="text-[13px] text-muted">Loading the verification details…</p>
            </div>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div>
      {header}

      <div className="space-y-4 lg:space-y-6">
        <Card
          title="Ownership verification"
          description="Add the DNS record or the meta tag below, then check. The check reads the TXT record first and the home page second."
          action={
            <Button
              variant="primary"
              icon={<RefreshCw size={14} />}
              loading={checking}
              // A write: the demo surface disables it with its own reason instead of faking a check.
              mutation
              disabled={!canCheck}
              title={canCheck ? undefined : 'Only editors and admins can check ownership.'}
              aria-description={canCheck ? undefined : 'Your role cannot check ownership.'}
              onClick={() => void checkNow()}
            >
              Check now
            </Button>
          }
        >
          <div className="p-4 md:p-5">
            <Meta
              items={[
                [
                  'State',
                  verified ? (
                    <span key="verified" className="inline-flex items-center gap-2">
                      <StatusPill tone="good">Verified</StatusPill>
                      {verifiedAt && <span className="text-muted">on {formatDateTime(verifiedAt, { zone: true })}</span>}
                    </span>
                  ) : (
                    <span key="unverified" className="inline-flex items-center gap-2">
                      <StatusPill tone="warn">Not verified</StatusPill>
                      <span className="text-muted">
                        {canCheck ? 'Add one of the records below, then check.' : 'An editor or admin adds the record.'}
                      </span>
                    </span>
                  ),
                ],
                ...(method ? ([['Method', method === 'dns' ? 'DNS TXT record' : 'Meta tag']] as [string, string][]) : []),
                ...(lastCheckAt ? ([['Last check', formatDateTime(lastCheckAt, { zone: true })]] as [string, string][]) : []),
              ]}
            />

            <div aria-live="polite" className="mt-4 empty:mt-0">
              {checkError && (
                <Alert tone="bad" title="The check did not run">
                  {checkError}
                </Alert>
              )}
              {!checkError && result?.verified && (
                <Alert tone="good" title={`Ownership verified with the ${result.method === 'meta' ? 'meta tag' : 'DNS TXT record'}`}>
                  Checked {formatDateTime(result.checkedAt, { zone: true })}. A verified site stays verified when the record is later
                  removed; the next check records the failure instead.
                </Alert>
              )}
              {!checkError && result && !result.verified && result.error && (
                <Alert tone="bad" title="Not verified yet">
                  {result.error}
                </Alert>
              )}
              {!checkError && !result && lastError && (
                <Alert tone="bad" title="The last check did not verify this site">
                  {lastError}
                </Alert>
              )}
            </div>
          </div>
        </Card>

        <Card title="DNS TXT record" description="The check reads this record first; it does not change the site.">
          <div className="space-y-4 p-4 md:p-5">
            <Meta
              items={[
                ['Type', <Mono key="type">TXT</Mono>],
                ['Name', <Mono key="name">{data.dns.name}</Mono>],
                [
                  'Value',
                  <span key="value" className="inline-flex min-w-0 items-start gap-2">
                    <Mono className="break-all">{data.dns.value}</Mono>
                    <CopyButton value={data.dns.value} label="Copy the TXT value" />
                  </span>,
                ],
              ]}
            />
            <p className="text-[13px] leading-5 text-fg-2">{data.dns.instructions}</p>
          </div>
        </Card>

        <Card title="Meta tag" description="The check falls back to the home page's head when the DNS record is missing.">
          <div className="space-y-4 p-4 md:p-5">
            <CodeView
              label="Add inside the <head> of the home page"
              value={`<meta name="${data.meta.name}" content="${data.meta.content}">`}
            />
            <p className="text-[13px] leading-5 text-fg-2">{data.meta.instructions}</p>
          </div>
        </Card>

        <Card>
          <p className="flex items-start gap-2 p-4 text-[13px] leading-5 text-fg-2 md:p-5">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
            <span>
              The check runs from the public internet, so it can see exactly what a search engine sees. {site.domain} has to answer on HTTPS
              for the meta tag to work; a TXT record does not need the site to be live.
            </span>
          </p>
        </Card>
      </div>
    </div>
  );
}
