import { AppError, safeErrorText } from '@agentic-seo/core';
import { type Db, schema, type Tx } from '@agentic-seo/db';
import { findLiveConnection, GSC_CONNECTOR_ID } from '@agentic-seo/integrations';
import { GSC_FINALITY_CAP_DAYS, type ProviderGateway } from '@agentic-seo/providers';
import { and, eq, sql } from 'drizzle-orm';
import { addDays, addMonths, maxDay, minDay, today as searchConsoleToday } from './dates';
import { normalizePageUrl } from './urls';

// The Search Console sync (data-providers.md §5, domain-model.md §3). Two datasets, each with a
// watermark per (site, dataset, search type, property):
//
//   property_totals   dimensions [date], aggregationType byProperty
//   page_aggregates   dimensions [date, page, country, device], aggregationType byPage
//
// A first sync backfills 16 months in 30-day chunks and resumes from `backfill_through` after a
// failure. Each run then fetches one window from the earliest of three places to today:
//
//   coverage_through + 1   the first day never fetched (an outage leaves a gap)
//   last_final_date + 1    the first day Google may still revise
//   today − 4              the usual provisional overlap
//
// so a gap after an outage is filled, and provisional days keep being re-fetched until Google's own
// `first_incomplete_date` says they are final. A day still reported incomplete after ten days is
// taken as final with a recorded warning, so one stuck day cannot re-fetch for ever.
//
// Each window is replaced atomically from a completed fetch: its rows are deleted and inserted in
// one transaction, so a row Google dropped on a re-fetch does not linger. The window is fenced by the
// connection's generation and property, so a run for the old property can never write facts or
// watermarks that describe the new one.
//
// Every provider call goes through the gateway (packages/providers), never a direct HTTP request:
// the gateway owns the rate-limit bucket, the cache and the call record. The adapter is free, so the
// sync spends nothing and needs no budget.

const CHUNK_DAYS = 30;
const BACKFILL_MONTHS = 16;
const PROVISIONAL_DAYS = 4;
const MAX_CHUNKS = 40;
const ROW_LIMIT = 25_000;
/** One insert statement's rows; 25,000 rows would exceed Postgres's parameter limit. */
const INSERT_BATCH = 400;

export type GscDatasetName = 'property_totals' | 'page_aggregates';

interface DatasetDefinition {
  dataset: GscDatasetName;
  dimensions: string[];
  aggregationType: 'byProperty' | 'byPage';
}

const DATASETS: readonly DatasetDefinition[] = [
  { dataset: 'property_totals', dimensions: ['date'], aggregationType: 'byProperty' },
  { dataset: 'page_aggregates', dimensions: ['date', 'page', 'country', 'device'], aggregationType: 'byPage' },
];

export interface GscSyncDeps {
  db: Db;
  providers: ProviderGateway;
  now?: () => Date;
}

export interface GscSyncInput {
  workspaceId: string;
  siteId: string;
  /** Limit to one dataset (a repair or a test); both by default. */
  dataset?: GscDatasetName;
  /** Stop after this many backfill chunks per dataset (tests use a small number). */
  maxChunks?: number;
}

export interface DatasetSyncResult {
  dataset: GscDatasetName;
  searchType: string;
  rows: number;
  backfillComplete: boolean;
  backfillThrough: string | null;
  lastFinalDate: string | null;
  coverageThrough: string | null;
  lastWarning: string | null;
}

export interface GscSyncResult {
  siteId: string;
  property: string;
  connectionId: string;
  datasets: DatasetSyncResult[];
}

interface Watermark {
  lastFinalDate: string | null;
  lastFetchedAt: Date | null;
  backfillComplete: boolean;
  backfillThrough: string | null;
  coverageThrough: string | null;
  lastError: string | null;
  lastWarning: string | null;
}

const watermarkOf = (row: typeof schema.gscSyncState.$inferSelect): Watermark => ({
  lastFinalDate: row.lastFinalDate,
  lastFetchedAt: row.lastFetchedAt,
  backfillComplete: row.backfillComplete,
  backfillThrough: row.backfillThrough,
  coverageThrough: row.coverageThrough,
  lastError: row.lastError,
  lastWarning: row.lastWarning,
});

interface WatermarkKey {
  workspaceId: string;
  siteId: string;
  dataset: GscDatasetName;
  searchType: string;
  property: string;
}

const watermarkWhere = (key: WatermarkKey) =>
  and(
    eq(schema.gscSyncState.workspaceId, key.workspaceId),
    eq(schema.gscSyncState.siteId, key.siteId),
    eq(schema.gscSyncState.dataset, key.dataset),
    eq(schema.gscSyncState.searchType, key.searchType),
    eq(schema.gscSyncState.property, key.property),
  );

/** The watermark row, created on first use; a racing sync finds the winner's row. */
async function ensureWatermark(tx: Tx, key: WatermarkKey) {
  await tx
    .insert(schema.gscSyncState)
    .values({ ...key, backfillComplete: false })
    .onConflictDoNothing();
  const [row] = await tx.select().from(schema.gscSyncState).where(watermarkWhere(key));
  // Not `FOR UPDATE`: the insert above may have been committed by a racing sync; the update that
  // follows uses an explicit WHERE so the last writer wins on one watermark, never a lost chunk.
  if (!row) throw new AppError('conflict', 'The Search Console sync watermark could not be created. Run the sync again.');
  return row;
}

interface FetchedRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** What one provider read tells us beyond its rows: Google's incompleteness and the row cap. */
interface FetchMetadata {
  firstIncompleteDate: string | null;
  firstIncompleteHour: string | null;
}

interface FetchedWindow {
  rows: FetchedRow[];
  metadata: FetchMetadata | null;
  truncated: boolean;
  rowLimitReached: number | null;
}

interface PortResponse {
  rows: FetchedRow[];
  metadata?: FetchMetadata | null;
  truncated?: boolean;
  rowLimitReached?: number | null;
}

async function fetchWindow(
  deps: GscSyncDeps,
  input: {
    workspaceId: string;
    siteId: string;
    connectionId: string;
    property: string;
    definition: DatasetDefinition;
    searchType: string;
    start: string;
    end: string;
    refresh: boolean;
  },
): Promise<FetchedWindow> {
  const result = await deps.providers.call<PortResponse>({
    workspaceId: input.workspaceId,
    port: 'SearchConsole',
    operation: 'searchAnalytics',
    request: {
      property: input.property,
      startDate: input.start,
      endDate: input.end,
      dimensions: input.definition.dimensions,
      rowLimit: ROW_LIMIT,
      searchType: input.searchType,
    },
    caller: { type: 'schedule', id: 'gsc_sync' },
    purpose: `Search Console ${input.definition.dataset} for ${input.start}..${input.end}`,
    siteId: input.siteId,
    // Google data never crosses its credential or its property: both are part of the cache key.
    credentialKey: input.connectionId,
    propertyKey: input.property,
    options: { aggregationType: input.definition.aggregationType },
    // Provisional days must be re-read; final backfill days may come from the gateway cache.
    refresh: input.refresh,
  });
  return {
    rows: result.data.rows,
    metadata: result.data.metadata ?? null,
    truncated: result.data.truncated ?? false,
    rowLimitReached: result.data.rowLimitReached ?? null,
  };
}

async function insertTotals(tx: Tx, rows: (typeof schema.gscPropertyTotals.$inferInsert)[]) {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    await tx
      .insert(schema.gscPropertyTotals)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          schema.gscPropertyTotals.workspaceId,
          schema.gscPropertyTotals.siteId,
          schema.gscPropertyTotals.property,
          schema.gscPropertyTotals.date,
          schema.gscPropertyTotals.searchType,
        ],
        set: {
          clicks: sql`excluded.clicks`,
          impressions: sql`excluded.impressions`,
          ctr: sql`excluded.ctr`,
          position: sql`excluded.position`,
          isFinal: sql`excluded.is_final`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
  }
}

async function insertPages(tx: Tx, rows: (typeof schema.gscPageAggregates.$inferInsert)[]) {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    await tx
      .insert(schema.gscPageAggregates)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          schema.gscPageAggregates.workspaceId,
          schema.gscPageAggregates.siteId,
          schema.gscPageAggregates.property,
          schema.gscPageAggregates.date,
          schema.gscPageAggregates.searchType,
          schema.gscPageAggregates.page,
          schema.gscPageAggregates.country,
          schema.gscPageAggregates.device,
        ],
        set: {
          pageKey: sql`excluded.page_key`,
          clicks: sql`excluded.clicks`,
          impressions: sql`excluded.impressions`,
          ctr: sql`excluded.ctr`,
          position: sql`excluded.position`,
          isFinal: sql`excluded.is_final`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
  }
}

/** The day on/before which Google's numbers are final for one window. */
function finalThrough(input: { end: string; today: string; metadata: FetchMetadata | null }): string {
  const firstIncomplete = input.metadata?.firstIncompleteDate ?? null;
  // No metadata means Google reported nothing incomplete in the range, so the whole window is final.
  if (firstIncomplete === null) return input.end;
  const cap = addDays(input.today, -GSC_FINALITY_CAP_DAYS);
  const byGoogle = minDay(addDays(firstIncomplete, -1), input.end) ?? input.end;
  // The cap: a day still incomplete after ten days is final anyway, so one stuck day cannot keep the
  // window provisional for ever. It only makes rows final earlier, never later.
  if (byGoogle < cap) return minDay(cap, input.end) ?? input.end;
  return byGoogle;
}

/** One fetched window: replace its rows and advance the watermark in one transaction. */
async function storeWindow(
  deps: GscSyncDeps,
  input: {
    workspaceId: string;
    siteId: string;
    connectionId: string;
    generation: number;
    property: string;
    definition: DatasetDefinition;
    searchType: string;
    start: string;
    end: string;
    fetched: FetchedWindow;
    today: string;
    now: Date;
    backfill: boolean;
  },
): Promise<{ rows: number; watermark: Watermark }> {
  const finalDay = finalThrough({ end: input.end, today: input.today, metadata: input.fetched.metadata });
  const isFinal = (day: string) => day <= finalDay;
  return deps.db.withWorkspace(input.workspaceId, async (tx) => {
    // The fence: this run's connection must still be the active one, with the property it started
    // for. Taken as a share lock, so a concurrent property change waits for this window to commit
    // and this window sees a property change that committed first.
    const [connection] = await tx
      .select({
        state: schema.connections.state,
        generation: schema.connections.generation,
        property: sql<string | null>`${schema.connections.settings} ->> 'property'`,
      })
      .from(schema.connections)
      .where(and(eq(schema.connections.workspaceId, input.workspaceId), eq(schema.connections.id, input.connectionId)))
      .for('share');
    if (connection?.state !== 'active' || connection.generation !== input.generation || connection.property !== input.property)
      throw new AppError(
        'conflict',
        `The Search Console connection changed while its ${input.definition.dataset} sync was running, so this window was not stored. The next sync starts from the connection’s current state.`,
      );

    const key: WatermarkKey = {
      workspaceId: input.workspaceId,
      siteId: input.siteId,
      dataset: input.definition.dataset,
      searchType: input.searchType,
      property: input.property,
    };
    const current = await ensureWatermark(tx, key);

    // Replace, never merge: a completed fetch is the whole truth for its window, so a row Google
    // dropped is gone afterwards. A fetch that stopped at the row cap is partial, so it upserts
    // instead of deleting; a failed fetch throws before this transaction and stores nothing.
    if (!input.fetched.truncated) {
      const table = input.definition.dataset === 'property_totals' ? 'gsc_property_totals' : 'gsc_page_aggregates';
      await tx.execute(sql`
        DELETE FROM ${sql.identifier(table)}
        WHERE workspace_id = ${input.workspaceId}
          AND site_id = ${input.siteId}
          AND property = ${input.property}
          AND search_type = ${input.searchType}
          AND date BETWEEN ${input.start} AND ${input.end}`);
    }

    if (input.definition.dataset === 'property_totals') {
      const rows = input.fetched.rows
        .filter((row) => typeof row.keys[0] === 'string' && row.keys[0].length === 10)
        .map((row) => ({
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          property: input.property,
          date: row.keys[0] as string,
          searchType: input.searchType,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
          isFinal: isFinal(row.keys[0] as string),
          fetchedAt: input.now,
        }));
      await insertTotals(tx, rows);
    } else {
      const rows = input.fetched.rows
        .filter((row) => typeof row.keys[0] === 'string' && row.keys[0].length === 10 && typeof row.keys[1] === 'string')
        .map((row) => ({
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          property: input.property,
          date: row.keys[0] as string,
          searchType: input.searchType,
          page: row.keys[1] as string,
          pageKey: normalizePageUrl(row.keys[1] as string),
          country: row.keys[2] ?? '',
          device: row.keys[3] ?? '',
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
          isFinal: isFinal(row.keys[0] as string),
          fetchedAt: input.now,
        }));
      await insertPages(tx, rows);
    }

    const firstIncomplete = input.fetched.metadata?.firstIncompleteDate ?? null;
    const lastFinalDate = maxDay(current.lastFinalDate, finalDay);
    // Contiguous coverage: this window ran from `start` to `end`, and the caller only asks for a
    // window that starts at or before coverage+1, so everything through `end` is now fetched. A
    // truncated read is incomplete, so coverage stays where it was and the next run retries the gap.
    const coverageThrough = input.fetched.truncated ? current.coverageThrough : maxDay(current.coverageThrough, input.end);
    const backfillThrough = input.backfill ? maxDay(current.backfillThrough, input.end) : current.backfillThrough;
    const backfillComplete = input.backfill
      ? (backfillThrough !== null && backfillThrough >= input.today) || current.backfillComplete
      : current.backfillComplete;
    // A non-fatal warning: the read stopped at the row cap, or Google still calls a day incomplete
    // past the cap. A clean window clears the previous warning.
    const warning = input.fetched.truncated
      ? `The ${input.definition.dataset.replace('_', ' ')} read for ${input.start} to ${input.end} stopped at the ${input.fetched.rowLimitReached ?? ROW_LIMIT}-row cap, so this window is incomplete.`
      : firstIncomplete !== null && firstIncomplete <= addDays(input.today, -GSC_FINALITY_CAP_DAYS)
        ? `Google still reported ${firstIncomplete} incomplete more than ${GSC_FINALITY_CAP_DAYS} days later; its numbers are marked final so the sync stops re-fetching them.`
        : null;
    const [updated] = await tx
      .update(schema.gscSyncState)
      .set({
        lastFinalDate,
        lastFetchedAt: input.now,
        backfillThrough,
        backfillComplete,
        coverageThrough,
        lastError: null,
        lastWarning: warning,
        updatedAt: input.now,
      })
      .where(watermarkWhere(key))
      .returning();
    if (!updated) throw new AppError('conflict', 'The Search Console sync watermark disappeared while the window was being stored.');
    return { rows: input.fetched.rows.length, watermark: watermarkOf(updated) };
  });
}

async function recordFailure(deps: GscSyncDeps, input: WatermarkKey & { message: string; now: Date }) {
  await deps.db.withWorkspace(input.workspaceId, async (tx) => {
    await ensureWatermark(tx, input);
    await tx.update(schema.gscSyncState).set({ lastError: input.message, updatedAt: input.now }).where(watermarkWhere(input));
  });
}

/**
 * The first day of the incremental window: the earliest day that must be (re-)fetched. A gap after
 * an outage starts at coverage+1 and is never clipped by the finality cap (it is unfetched, not
 * provisional); the provisional part starts at the first day Google may still revise, and the cap
 * keeps one stuck day from re-fetching a huge range for ever.
 */
export function incrementalStart(state: { coverageThrough: string | null; lastFinalDate: string | null }, today: string): string {
  const gapStart = state.coverageThrough ? addDays(state.coverageThrough, 1) : null;
  const provisionalStart = addDays(today, -PROVISIONAL_DAYS);
  const afterFinal = state.lastFinalDate ? addDays(state.lastFinalDate, 1) : provisionalStart;
  const cap = addDays(today, -GSC_FINALITY_CAP_DAYS);
  const revisionStart = minDay(afterFinal, provisionalStart) ?? provisionalStart;
  const provisional = revisionStart < cap ? cap : revisionStart;
  const earliest = minDay(gapStart, provisional) ?? provisional;
  // Search Analytics refuses a range longer than 16 months; the backfill covers anything older.
  const floor = addMonths(today, -BACKFILL_MONTHS);
  const start = earliest < floor ? floor : earliest;
  return start > today ? today : start;
}

/**
 * Runs the sync for one site. Throws when the site has no active Search Console connection or no
 * selected property; a provider failure is recorded on the watermark and rethrown so the worker
 * retries from the last committed chunk.
 */
export async function runGscSync(deps: GscSyncDeps, input: GscSyncInput): Promise<GscSyncResult> {
  const now = (deps.now ?? (() => new Date()))();
  // Google's day, not UTC's: at 18:00 Pacific, UTC is already tomorrow.
  const today = searchConsoleToday(now);
  const searchType = 'web';
  const maxChunks = input.maxChunks ?? MAX_CHUNKS;

  const prepared = await deps.db.withWorkspace(input.workspaceId, async (tx) => {
    const [site] = await tx
      .select({ id: schema.sites.id, name: schema.sites.name, domain: schema.sites.primaryDomain, archived: schema.sites.archived })
      .from(schema.sites)
      .where(and(eq(schema.sites.workspaceId, input.workspaceId), eq(schema.sites.id, input.siteId)));
    if (!site) throw new AppError('not_found', `Site ${input.siteId} does not exist in this workspace.`);
    if (site.archived)
      throw new AppError('conflict', `Site “${site.name}” (${site.domain}) is archived, so its Search Console data is no longer synced.`);
    const connection = await findLiveConnection(tx, input.workspaceId, input.siteId, GSC_CONNECTOR_ID);
    if (!connection)
      throw new AppError('precondition_failed', 'Search Console is not connected for this site. Run search.gsc.connect first.');
    if (connection.state === 'error')
      throw new AppError(
        'conflict',
        connection.lastError ?? 'The Search Console connection needs to be reconnected. Run search.gsc.connect.',
      );
    if (connection.state !== 'active')
      throw new AppError('conflict', 'The Search Console connection has not finished authorizing. Run search.gsc.connect again.');
    const property = connection.settings.property;
    if (typeof property !== 'string' || !property)
      throw new AppError(
        'precondition_failed',
        'No Search Console property is selected for this site. Run search.gsc.properties, then search.gsc.select.',
      );
    return { property, connectionId: connection.id, generation: connection.generation };
  });

  const definitions = input.dataset ? DATASETS.filter((d) => d.dataset === input.dataset) : DATASETS;
  const results: DatasetSyncResult[] = [];

  for (const definition of definitions) {
    const key: WatermarkKey = {
      workspaceId: input.workspaceId,
      siteId: input.siteId,
      dataset: definition.dataset,
      searchType,
      property: prepared.property,
    };
    let state: Watermark = await deps.db.withWorkspace(input.workspaceId, async (tx) => watermarkOf(await ensureWatermark(tx, key)));
    let totalRows = 0;
    try {
      // 1. The incremental window: gap fill, provisional days, and the usual four-day overlap.
      const start = incrementalStart(state, today);
      const fetched = await fetchWindow(deps, {
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        connectionId: prepared.connectionId,
        property: prepared.property,
        definition,
        searchType,
        start,
        end: today,
        refresh: true,
      });
      const stored = await storeWindow(deps, {
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        connectionId: prepared.connectionId,
        generation: prepared.generation,
        property: prepared.property,
        definition,
        searchType,
        start,
        end: today,
        fetched,
        today,
        now,
        backfill: false,
      });
      totalRows += stored.rows;
      state = stored.watermark;

      // 2. The 16-month backfill, 30 days at a time, resuming after the last committed chunk.
      let chunkStart = state.backfillComplete
        ? today
        : state.backfillThrough
          ? addDays(state.backfillThrough, 1)
          : addMonths(today, -BACKFILL_MONTHS);
      let chunks = 0;
      while (!state.backfillComplete && chunkStart <= today && chunks < maxChunks) {
        const chunkEnd = addDays(chunkStart, CHUNK_DAYS - 1) <= today ? addDays(chunkStart, CHUNK_DAYS - 1) : today;
        const chunk = await fetchWindow(deps, {
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          connectionId: prepared.connectionId,
          property: prepared.property,
          definition,
          searchType,
          start: chunkStart,
          end: chunkEnd,
          refresh: false,
        });
        const committed = await storeWindow(deps, {
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          connectionId: prepared.connectionId,
          generation: prepared.generation,
          property: prepared.property,
          definition,
          searchType,
          start: chunkStart,
          end: chunkEnd,
          fetched: chunk,
          today,
          now,
          backfill: true,
        });
        totalRows += committed.rows;
        state = committed.watermark;
        chunks += 1;
        chunkStart = addDays(chunkEnd, 1);
      }

      results.push({
        dataset: definition.dataset,
        searchType,
        rows: totalRows,
        backfillComplete: state.backfillComplete,
        backfillThrough: state.backfillThrough,
        lastFinalDate: state.lastFinalDate,
        coverageThrough: state.coverageThrough,
        lastWarning: state.lastWarning,
      });
    } catch (err) {
      const message = safeErrorText(err instanceof Error ? err.message : String(err), 500);
      await recordFailure(deps, { ...key, message, now });
      throw err;
    }
  }

  return { siteId: input.siteId, property: prepared.property, connectionId: prepared.connectionId, datasets: results };
}
