import { ExternalLink, Link2, RefreshCw, Unplug } from 'lucide-react';
import { useState } from 'react';
import { api, errText, type GithubStatus } from '../app/api';
import { useCrumbs } from '../app/page';
import { useSession, useSite } from '../app/session';
import { useApi } from '../app/useApi';
import { Alert, Button, Card, Field, Input, Meta, Mono, Select, StatusPill, Textarea } from '../ui';
import { useConfirm } from '../ui/overlay';
import { formatDateTime, timeAgo } from '../ui/time';
import { useToast } from '../ui/toast';

// Settings → Connections (DESIGN.md §3, Phase 1): the two connections the thin loop needs. Search
// Console supplies clicks and the pages' traffic; GitHub carries a change set to a pull request. A
// connection is a person's decision, so every action here needs sites:write and an actual person:
// an agent sees what is connected and why it cannot change it.

const EXAMPLE_MAPPING = `{
  "rules": [
    { "routes": "/", "source": "index.html", "editor": "html" },
    { "routes": "/:slug/", "source": "content/:slug/index.html", "editor": "html" }
  ],
  "redirects": { "file": "_redirects", "format": "netlify" }
}`;

export default function ConnectionsPage() {
  useCrumbs([{ label: 'Connections' }]);
  const { site } = useSite();
  const { can, agent } = useSession();
  const peopleOnly = can('sites:write') && !agent;
  const reason = agent ? 'An agent cannot change a connection; a person does this.' : 'Only editors and admins can change a connection.';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.02em]">Connections</h1>
        <p className="mt-1 max-w-[760px] text-[14px] leading-[22px] text-muted">
          The two outside services this site talks to. Search Console supplies the clicks a finding is worth; GitHub turns an approved
          change set into a pull request. Credentials are sealed on the server and never shown again.
        </p>
      </div>
      <SearchConsoleCard siteId={site.id} allowed={peopleOnly} reason={reason} />
      <GithubCard siteId={site.id} allowed={peopleOnly} reason={reason} />
    </div>
  );
}

function SearchConsoleCard({ siteId, allowed, reason }: { siteId: string; allowed: boolean; reason: string }) {
  const toast = useToast();
  const status = useApi(() => api.getSearchConsoleStatus(siteId), [siteId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [property, setProperty] = useState<string>('');
  const connection = status.data?.connection ?? null;
  const active = connection?.state === 'active';
  // The property list is a live Google read, so it is fetched only when there is an active connection.
  const properties = useApi(() => api.getSearchConsoleProperties(siteId), [siteId], { skip: !active });

  const act = async (label: string, run: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await run();
      await status.reload();
      if (active) await properties.reload();
    } catch (caught) {
      setError(errText(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="Google Search Console"
      description="Clicks, impressions, CTR and position per page and per query, read with the property you choose."
      action={
        connection && active ? (
          <>
            <Button
              size="sm"
              icon={<RefreshCw size={14} />}
              loading={busy === 'sync'}
              disabled={!allowed}
              title={!allowed ? reason : undefined}
              onClick={() =>
                void act('sync', async () => {
                  await api.syncSearchConsole(siteId);
                  toast.success('Sync queued. The first run backfills 16 months; later runs refresh the last few days.');
                })
              }
            >
              Sync now
            </Button>
            <Button
              size="sm"
              icon={<Unplug size={14} />}
              loading={busy === 'disconnect'}
              disabled={!allowed}
              title={!allowed ? reason : undefined}
              onClick={() =>
                void act('disconnect', async () => {
                  await api.disconnectSearchConsole(siteId);
                  toast.success('Search Console disconnected. The data already synced stays.');
                })
              }
            >
              Disconnect
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="space-y-4 p-4 md:p-5">
        {error && (
          <Alert tone="bad" title="The action was refused">
            {error}
          </Alert>
        )}
        {status.error && !status.data && (
          <Alert tone="bad" title="Couldn’t read the connection" onRetry={() => void status.reload()}>
            {status.error}
          </Alert>
        )}
        {!status.data && !status.error && <p className="text-[13px] text-muted">Loading the connection…</p>}

        {status.data && (
          <>
            <Meta
              items={[
                [
                  'State',
                  connection ? (
                    <span key="state" className="inline-flex items-center gap-2">
                      <StatusPill tone={connection.state === 'active' ? 'good' : connection.state === 'error' ? 'bad' : 'warn'}>
                        {connection.state === 'active'
                          ? 'Connected'
                          : connection.state === 'error'
                            ? 'Needs reconnecting'
                            : 'Waiting for authorization'}
                      </StatusPill>
                      {connection.lastError && <span className="text-[12px] text-bad">{connection.lastError}</span>}
                    </span>
                  ) : (
                    <StatusPill key="state" tone="neutral">
                      Not connected
                    </StatusPill>
                  ),
                ],
                ['Property', status.data.property ? <Mono key="property">{status.data.property}</Mono> : 'None chosen'],
                [
                  'Data through',
                  status.data.datasets.find((dataset) => dataset.coverageThrough)?.coverageThrough
                    ? formatDateTime(`${status.data.datasets.find((dataset) => dataset.coverageThrough)!.coverageThrough}T00:00:00Z`, {
                        zone: true,
                      })
                    : 'No sync yet',
                ],
              ]}
            />

            {connection?.state !== 'active' ? (
              <div className="space-y-2">
                <p className="text-[13px] leading-5 text-fg-2">
                  Sign in with the Google account that can read this site’s Search Console property, and allow read-only access. The
                  authorization happens on Google’s own page; this screen only starts it.
                </p>
                <Button
                  variant="primary"
                  loading={busy === 'connect'}
                  disabled={!allowed}
                  title={!allowed ? reason : undefined}
                  icon={<ExternalLink size={14} />}
                  onClick={() =>
                    void act('connect', async () => {
                      const started = await api.connectSearchConsole(siteId);
                      window.location.assign(started.url);
                    })
                  }
                >
                  Connect Search Console
                </Button>
                {!allowed && <p className="text-[12px] leading-[18px] text-muted">{reason}</p>}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-end gap-2">
                  <Field
                    label="Search Console property"
                    className="min-w-[280px] flex-1"
                    hint="The one marked “suggested” matches this site’s domain."
                  >
                    <Select
                      value={property || status.data.property || ''}
                      onChange={(event) => setProperty(event.target.value)}
                      disabled={!allowed || properties.loading}
                    >
                      <option value="">Choose a property</option>
                      {(properties.data?.properties ?? []).map((entry) => (
                        <option key={entry.property} value={entry.property}>
                          {entry.property}
                          {entry.property === properties.data?.suggested ? ' (suggested)' : ''}
                          {entry.permissionLevel ? ` · ${entry.permissionLevel}` : ''}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button
                    variant="primary"
                    loading={busy === 'select'}
                    disabled={!allowed || !property || property === status.data.property}
                    title={!allowed ? reason : undefined}
                    onClick={() =>
                      void act('select', async () => {
                        await api.selectSearchConsoleProperty(siteId, property);
                        toast.success('Property saved. The new property starts its own 16-month backfill.');
                      })
                    }
                  >
                    Save property
                  </Button>
                </div>
                {properties.error && (
                  <Alert tone="warn" title="Couldn’t list the properties">
                    {properties.error}
                  </Alert>
                )}
                {properties.data && properties.data.properties.length === 0 && (
                  <p className="text-[12px] leading-[18px] text-muted">
                    This Google account can read no Search Console property. Add the property in Search Console first, or reconnect with
                    another account.
                  </p>
                )}
                {properties.data?.suggested && properties.data.suggested !== status.data.property && (
                  <p className="text-[12px] leading-[18px] text-fg-2">
                    Suggested: <Mono>{properties.data.suggested}</Mono> matches this site’s domain.
                  </p>
                )}
              </div>
            )}

            {status.data.datasets.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-line">
                <table className="w-full border-collapse text-left text-[13px] leading-5">
                  <caption className="sr-only">Search Console datasets and their progress</caption>
                  <thead className="bg-surface-2 text-[12px] leading-[18px] text-muted">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Dataset
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Newest final day
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Backfill
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Last read
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.data.datasets.map((dataset) => (
                      <tr key={`${dataset.dataset}:${dataset.searchType}`} className="border-t border-line align-top">
                        <td className="px-3 py-2.5">
                          {dataset.dataset === 'property_totals' ? 'Daily totals' : 'Page aggregates'}
                          <span className="text-muted"> · {dataset.searchType}</span>
                        </td>
                        <td className="px-3 py-2.5 text-fg-2">{dataset.lastFinalDate ?? 'None yet'}</td>
                        <td className="px-3 py-2.5 text-fg-2">
                          {dataset.backfillComplete
                            ? 'Complete'
                            : dataset.backfillThrough
                              ? `Back to ${dataset.backfillThrough}`
                              : 'Not started'}
                        </td>
                        <td className="px-3 py-2.5 text-fg-2">{dataset.lastFetchedAt ? timeAgo(dataset.lastFetchedAt) : 'Never'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {status.data.datasets.some((dataset) => dataset.lastError || dataset.lastWarning) && (
                  <ul className="divide-y divide-line border-t border-line">
                    {status.data.datasets
                      .filter((dataset) => dataset.lastError || dataset.lastWarning)
                      .map((dataset) => (
                        <li
                          key={`${dataset.dataset}:${dataset.searchType}:error`}
                          className="px-3 py-2 text-[12px] leading-[18px] text-warn"
                        >
                          {dataset.dataset}: {dataset.lastError ?? dataset.lastWarning}
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

interface GithubForm {
  owner: string;
  repo: string;
  baseBranch: string;
  token: string;
  mapping: string;
  detector: 'version_file' | 'github_deployments';
  path: string;
  environment: string;
  deployTimeoutHours: string;
}

const EMPTY_FORM: GithubForm = {
  owner: '',
  repo: '',
  baseBranch: 'main',
  token: '',
  mapping: EXAMPLE_MAPPING,
  detector: 'version_file',
  path: '/version.txt',
  environment: 'production',
  deployTimeoutHours: '48',
};

function GithubCard({ siteId, allowed, reason }: { siteId: string; allowed: boolean; reason: string }) {
  const toast = useToast();
  const status = useApi(() => api.getGithubStatus(siteId), [siteId]);
  const [form, setForm] = useState<GithubForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [dialog, ask] = useConfirm();
  // A connection is usable only when the server says it is active *and* a token is still stored:
  // a disconnect keeps the stored settings (repository, mapping) but revokes the credential, and
  // connectors.github.update refuses a revoked row. The settings string alone is not proof.
  const connection = status.data?.connection ?? null;
  const active = connection?.state === 'active' && status.data?.hasToken === true && Boolean(status.data?.repository);
  const revoked = connection?.state === 'revoked';

  // The stored mapping is not readable back (it may carry internal paths), so editing the settings
  // asks for it again rather than silently keeping a value the person cannot see.
  const start = () => {
    const data: GithubStatus | undefined = status.data;
    const [owner, repo] = (data?.repository ?? '/').split('/');
    setError(null);
    setMappingError(null);
    setForm({
      ...EMPTY_FORM,
      owner: owner ?? '',
      repo: repo ?? '',
      baseBranch: data?.baseBranch ?? 'main',
      token: '',
      detector: data?.deploy?.detector ?? 'version_file',
      path: data?.deploy?.detector === 'version_file' ? (data.deploy?.detail ?? '/version.txt') : '/version.txt',
      environment: data?.deploy?.detector === 'github_deployments' ? (data.deploy?.detail ?? 'production') : 'production',
      deployTimeoutHours: data?.deployTimeoutHours ? String(data.deployTimeoutHours) : '48',
    });
  };

  const parseMapping = (text: string): unknown | null => {
    try {
      return JSON.parse(text);
    } catch (caught) {
      setMappingError(`The mapping is not valid JSON: ${errText(caught)}`);
      return null;
    }
  };

  const save = async (mode: 'connect' | 'update') => {
    if (!form) return;
    const mapping = parseMapping(form.mapping);
    if (mapping === null) return;
    setBusy(mode);
    setError(null);
    try {
      if (mode === 'connect') {
        const result = await api.connectGithub({
          siteId,
          owner: form.owner.trim(),
          repo: form.repo.trim(),
          baseBranch: form.baseBranch.trim() || 'main',
          token: form.token.trim(),
          mapping,
          deploy:
            form.detector === 'version_file'
              ? { detector: 'version_file', path: form.path.trim() }
              : { detector: 'github_deployments', environment: form.environment.trim() },
          deployTimeoutHours: Number(form.deployTimeoutHours) || 48,
        });
        toast.success(`Connected ${result.repository} at ${result.baseSha.slice(0, 7)}.`);
      } else {
        const result = await api.updateGithub({
          siteId,
          owner: form.owner.trim(),
          repo: form.repo.trim(),
          baseBranch: form.baseBranch.trim() || 'main',
          mapping,
          deploy:
            form.detector === 'version_file'
              ? { detector: 'version_file', path: form.path.trim() }
              : { detector: 'github_deployments', environment: form.environment.trim() },
          deployTimeoutHours: Number(form.deployTimeoutHours) || 48,
        });
        toast.success(`Saved. ${result.repository} is at ${result.baseSha.slice(0, 7)}.`);
      }
      setForm(null);
      await status.reload();
    } catch (caught) {
      setError(errText(caught));
    } finally {
      // The credential leaves React's state whichever way the request ended: a refused connect must
      // not leave a token in the form (or in a later screenshot, DOM node or devtools snapshot).
      setForm((current) => (current ? { ...current, token: '' } : current));
      setBusy(null);
    }
  };

  return (
    <Card
      title="GitHub"
      description="One repository and the route-to-source mapping that turns a change set into a pull request."
      action={
        status.data && active && !form ? (
          <>
            <Button size="sm" disabled={!allowed} title={!allowed ? reason : undefined} onClick={start}>
              Change settings
            </Button>
            <Button
              size="sm"
              icon={<Unplug size={14} />}
              loading={busy === 'disconnect'}
              disabled={!allowed}
              title={!allowed ? reason : undefined}
              onClick={async () => {
                const confirmed = await ask({
                  title: `Disconnect ${status.data?.repository ?? 'GitHub'}?`,
                  body: 'The stored token is removed. Change sets already open stay readable and their pull requests are untouched, but nothing new can be applied until the site is connected again.',
                  confirmLabel: 'Disconnect GitHub',
                  destructive: true,
                });
                if (!confirmed) return;
                setBusy('disconnect');
                setError(null);
                try {
                  await api.disconnectGithub(siteId);
                  toast.success('GitHub disconnected.');
                  await status.reload();
                } catch (caught) {
                  setError(errText(caught));
                } finally {
                  setBusy(null);
                }
              }}
            >
              Disconnect
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="space-y-4 p-4 md:p-5">
        {dialog}
        {error && (
          <Alert tone="bad" title="The connection was not saved">
            {error}
          </Alert>
        )}
        {status.error && !status.data && (
          <Alert tone="bad" title="Couldn’t read the connection" onRetry={() => void status.reload()}>
            {status.error}
          </Alert>
        )}
        {!status.data && !status.error && <p className="text-[13px] text-muted">Loading the connection…</p>}

        {status.data && !form && (
          <>
            <Meta
              items={[
                [
                  'State',
                  status.data.connection ? (
                    <span key="state" className="inline-flex items-center gap-2">
                      <StatusPill
                        tone={
                          status.data.connection.state === 'active' ? 'good' : status.data.connection.state === 'error' ? 'bad' : 'warn'
                        }
                      >
                        {status.data.connection.state === 'active'
                          ? 'Connected'
                          : status.data.connection.state === 'error'
                            ? 'Needs attention'
                            : 'Not usable'}
                      </StatusPill>
                      {status.data.connection.lastError && <span className="text-[12px] text-bad">{status.data.connection.lastError}</span>}
                    </span>
                  ) : (
                    <StatusPill key="state" tone="neutral">
                      Not connected
                    </StatusPill>
                  ),
                ],
                ['Repository', status.data.repository ? <Mono key="repo">{status.data.repository}</Mono> : 'None'],
                ['Base branch', status.data.baseBranch ?? 'None'],
                [
                  'Deploy detector',
                  status.data.deploy
                    ? `${status.data.deploy.detector === 'version_file' ? 'Version file' : 'GitHub deployments'} · ${status.data.deploy.detail}`
                    : 'None',
                ],
                ['Token', status.data.hasToken ? 'Stored, never shown' : 'No token stored'],
                ['Route rules', `${status.data.sourceRules} ${status.data.sourceRules === 1 ? 'rule' : 'rules'}`],
              ]}
            />
            {!active && (
              <div className="space-y-2">
                <p className="text-[13px] leading-5 text-fg-2">
                  {revoked
                    ? 'This connection was disconnected: its token is gone, and stored settings alone cannot be used again.'
                    : 'Give a fine-grained personal access token with Contents read/write and Pull requests read/write for this repository only.'}{' '}
                  {status.data.hasToken
                    ? 'The token is validated by reading the base branch, then sealed; it is never returned or logged.'
                    : 'Connecting stores the settings and a sealed token in one step.'}
                </p>
                <Button
                  variant="primary"
                  icon={<Link2 size={14} />}
                  disabled={!allowed}
                  title={!allowed ? reason : undefined}
                  onClick={start}
                >
                  Connect GitHub
                </Button>
                {!allowed && <p className="text-[12px] leading-[18px] text-muted">{reason}</p>}
              </div>
            )}
            {active && !allowed && <p className="text-[12px] leading-[18px] text-muted">{reason}</p>}
          </>
        )}

        {form && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save(active ? 'update' : 'connect');
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Owner" required hint="The user or organisation, e.g. TimChr78.">
                <Input value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} required />
              </Field>
              <Field label="Repository" required>
                <Input value={form.repo} onChange={(event) => setForm({ ...form, repo: event.target.value })} required />
              </Field>
              <Field label="Base branch" required hint="Change sets branch from here and their pull requests target it.">
                <Input value={form.baseBranch} onChange={(event) => setForm({ ...form, baseBranch: event.target.value })} required />
              </Field>
              {!active && (
                <Field
                  label="Personal access token"
                  required
                  hint="Contents read/write, Pull requests read/write. Never shown again; a completed request clears it."
                >
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={form.token}
                    onChange={(event) => setForm({ ...form, token: event.target.value })}
                    required
                  />
                </Field>
              )}
            </div>

            <Field
              label="Source mapping"
              required
              error={mappingError}
              hint={
                active
                  ? `JSON. The stored mapping is not readable back, so paste it again to change it (${status.data?.sourceRules ?? 0} rules are stored).`
                  : 'JSON. Route patterns to source files: every change set resolves through this, so a change with no rule is refused.'
              }
            >
              <Textarea mono value={form.mapping} onChange={(event) => setForm({ ...form, mapping: event.target.value })} rows={10} />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Deploy detector" required hint="How this page knows a merge is live.">
                <Select
                  value={form.detector}
                  onChange={(event) => setForm({ ...form, detector: event.target.value as GithubForm['detector'] })}
                >
                  <option value="version_file">Version file on the site</option>
                  <option value="github_deployments">GitHub deployment environment</option>
                </Select>
              </Field>
              {form.detector === 'version_file' ? (
                <Field label="Version file path" required hint="e.g. /version.txt, served by the deployed site.">
                  <Input value={form.path} onChange={(event) => setForm({ ...form, path: event.target.value })} required />
                </Field>
              ) : (
                <Field label="Deployment environment" required hint="e.g. production or github-pages.">
                  <Input value={form.environment} onChange={(event) => setForm({ ...form, environment: event.target.value })} required />
                </Field>
              )}
              <Field label="Deploy timeout" unit="hours" hint="How long a merged change may wait for its deployment.">
                <Input
                  type="number"
                  min={1}
                  max={720}
                  value={form.deployTimeoutHours}
                  onChange={(event) => setForm({ ...form, deployTimeoutHours: event.target.value })}
                />
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="primary" loading={busy !== null} disabled={!allowed} title={!allowed ? reason : undefined}>
                {active ? 'Save changes' : 'Connect GitHub'}
              </Button>
              <Button onClick={() => setForm(null)}>Cancel</Button>
              {active && (
                <p className="text-[12px] leading-[18px] text-muted">
                  To replace the token, disconnect and connect again: an update never takes a credential.
                </p>
              )}
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}
