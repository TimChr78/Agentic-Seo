import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Db } from '@agentic-seo/db';

// A small Prometheus exposition (text format 0.0.4) built by hand: the server needs a handful of
// counters, one histogram and a few gauges, which is less code than a dependency and keeps the
// image and the lockfile unchanged. Labels are bounded on purpose: route groups, fixed status
// classes, command names from the registry and the four policy decisions. No workspace id,
// address or person ever appears in a label.

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
const DECISIONS = ['allow', 'hold', 'ask', 'deny'] as const;
/** A scrape must never hang on a slow database: each collector gives up after this. */
const COLLECT_TIMEOUT_MS = 3000;

export type CommandEvent = { command: string; effect: string; outcome: 'ok' | 'error'; durationMs: number };

/** The values only a live install can answer, collected on each scrape (never cached). */
export interface GaugeSnapshot {
  /** Agent decisions in the ledger over the last hour, per decision. */
  agentDecisions?: { decision: string; count: number }[];
  dependencies?: { name: 'postgres'; up: boolean }[];
}

/** Which route group a request belongs to. A fixed set, so the label cardinality cannot grow. */
export function routeGroup(path: string): string {
  if (path === '/healthz' || path === '/readyz' || path === '/metrics') return path.slice(1);
  if (path.startsWith('/api/auth')) return 'auth';
  if (path.startsWith('/v1/')) return 'v1';
  if (path === '/mcp' || path.startsWith('/mcp/')) return 'mcp';
  if (path === '/login' || path === '/consent' || path === '/invite') return 'pages';
  if (path.startsWith('/.well-known/')) return 'well-known';
  if (path.startsWith('/api/')) return 'api';
  // The admin UI's static files and its client-side routes.
  return 'ui';
}

/** HTTP status class label (`2xx`, `4xx`, …): bounded, unlike the exact status. */
export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

/** Prometheus label values escape backslash, double quote and newline. */
function label(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

const seriesKey = (...parts: string[]) => parts.join('\u0000');

export interface MetricsRegistry {
  recordHttp(route: string, status: string, seconds: number): void;
  recordCommand(event: CommandEvent): void;
  render(gauges?: GaugeSnapshot): string;
}

export function createMetricsRegistry(): MetricsRegistry {
  const requests = new Map<string, number>();
  const durations = new Map<string, { buckets: number[]; sum: number; count: number }>();
  const commands = new Map<string, number>();

  return {
    recordHttp(route, status, seconds) {
      requests.set(seriesKey(route, status), (requests.get(seriesKey(route, status)) ?? 0) + 1);
      const key = seriesKey(route, status);
      let histogram = durations.get(key);
      if (!histogram) {
        histogram = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
        durations.set(key, histogram);
      }
      // Cumulative buckets, so rendering is a straight copy.
      for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]) histogram.buckets[i] += 1;
      histogram.sum += seconds;
      histogram.count += 1;
    },

    recordCommand(event) {
      const key = seriesKey(event.command, event.effect, event.outcome);
      commands.set(key, (commands.get(key) ?? 0) + 1);
    },

    render(gauges = {}) {
      const lines: string[] = [];
      const metric = (name: string, type: 'counter' | 'gauge' | 'histogram', help: string) => {
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      };
      const sample = (name: string, labels: string, value: number) =>
        lines.push(`${name}${labels ? `{${labels}}` : ''} ${Number.isFinite(value) ? value : 0}`);

      const memory = process.memoryUsage();
      metric('aseo_process_uptime_seconds', 'gauge', 'Seconds since this process started.');
      sample('aseo_process_uptime_seconds', '', process.uptime());
      metric('aseo_process_start_time_seconds', 'gauge', 'Unix time at which this process started.');
      sample('aseo_process_start_time_seconds', '', Math.round((Date.now() - process.uptime() * 1000) / 1000));
      metric('aseo_process_resident_memory_bytes', 'gauge', 'Resident set size of this process.');
      sample('aseo_process_resident_memory_bytes', '', memory.rss);
      metric('aseo_process_heap_used_bytes', 'gauge', 'JavaScript heap in use.');
      sample('aseo_process_heap_used_bytes', '', memory.heapUsed);

      metric('aseo_process_event_loop_lag_seconds', 'gauge', 'Mean event-loop delay since the previous scrape (sampled every 10 ms).');
      sample('aseo_process_event_loop_lag_seconds', '', eventLoopLagSeconds());

      metric('aseo_http_requests_total', 'counter', 'HTTP requests by route group and status class.');
      for (const key of [...requests.keys()].sort()) {
        const [route, status] = key.split('\u0000');
        sample('aseo_http_requests_total', `route=${label(route)},status=${label(status)}`, requests.get(key) ?? 0);
      }

      metric('aseo_http_request_duration_seconds', 'histogram', 'HTTP request duration by route group and status class, in seconds.');
      for (const key of [...durations.keys()].sort()) {
        const [route, status] = key.split('\u0000');
        const histogram = durations.get(key);
        if (!histogram) continue;
        const labels = `route=${label(route)},status=${label(status)}`;
        for (let i = 0; i < BUCKETS.length; i++)
          sample('aseo_http_request_duration_seconds_bucket', `${labels},le=${label(String(BUCKETS[i]))}`, histogram.buckets[i]);
        sample('aseo_http_request_duration_seconds_bucket', `${labels},le="+Inf"`, histogram.count);
        sample('aseo_http_request_duration_seconds_sum', labels, histogram.sum);
        sample('aseo_http_request_duration_seconds_count', labels, histogram.count);
      }

      metric('aseo_commands_total', 'counter', 'Command executions by command, effect and outcome.');
      for (const key of [...commands.keys()].sort()) {
        const [command, effect, outcome] = key.split('\u0000');
        sample(
          'aseo_commands_total',
          `command=${label(command)},effect=${label(effect)},outcome=${label(outcome)}`,
          commands.get(key) ?? 0,
        );
      }

      metric('aseo_agent_decisions_last_hour', 'gauge', 'Agent decisions in the ledger over the last hour, per decision.');
      const decisions = new Map((gauges.agentDecisions ?? []).map((row) => [row.decision, row.count]));
      // Every decision is always present, so a dashboard shows zero instead of a gap.
      for (const decision of DECISIONS)
        sample('aseo_agent_decisions_last_hour', `decision=${label(decision)}`, decisions.get(decision) ?? 0);

      metric('aseo_dependency_up', 'gauge', 'Whether a dependency answered a health check on this scrape (1 up, 0 down).');
      for (const dependency of gauges.dependencies ?? [])
        sample('aseo_dependency_up', `name=${label(dependency.name)}`, dependency.up ? 1 : 0);

      return `${lines.join('\n')}\n`;
    },
  };
}

/** Mean event-loop delay since the previous call, in seconds; 0 before the first sample. */
const eventLoop = monitorEventLoopDelay({ resolution: 10 });
eventLoop.enable();
function eventLoopLagSeconds(): number {
  const mean = eventLoop.mean;
  eventLoop.reset();
  // mean is NaN until the first sample; a fresh process has no lag worth reporting.
  return Number.isFinite(mean) ? mean / 1e9 : 0;
}

/** Race a collector against the scrape timeout, so one stuck query cannot block `/metrics`. */
async function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${COLLECT_TIMEOUT_MS / 1000}s`)), COLLECT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ledger gauges, from a read-only aggregate with no workspace label. A missing table (a fresh
 * install before migrations) leaves the gauge out rather than failing the scrape.
 */
export async function collectGauges(db: Db): Promise<GaugeSnapshot> {
  const gauges: GaugeSnapshot = {};
  try {
    const { rows } = await withTimeout(
      db.admin.query<{ decision: string; count: string }>(
        `SELECT decision, count(*) AS count FROM agent_actions WHERE at > now() - interval '1 hour' GROUP BY decision`,
      ),
      'agent decisions',
    );
    gauges.agentDecisions = rows.map((row) => ({ decision: row.decision, count: Number(row.count) }));
  } catch {
    // No schema yet, no permission, or too slow: the other metrics are still worth returning.
  }
  return gauges;
}

/** The same check `/readyz` makes, as a gauge instead of an all-or-nothing answer. */
export async function collectDependencies(deps: { db: { ping(): Promise<void> } }): Promise<{ name: 'postgres'; up: boolean }[]> {
  const postgres = await withTimeout(deps.db.ping(), 'Postgres').then(
    () => true,
    () => false,
  );
  return [{ name: 'postgres', up: postgres }];
}
