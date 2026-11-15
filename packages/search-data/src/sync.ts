import { AppError, safeErrorText } from '@agentic-seo/core';
import { type Db, schema, type Tx } from '@agentic-seo/db';
import { GSC_CONNECTOR_ID, liveConnection } from '@agentic-seo/integrations';
import { GSC_FINALITY_DAYS, type ProviderGateway } from '@agentic-seo/providers';
import { and, eq, sql } from 'drizzle-orm';
import { addDays, addMonths, dayString } from './dates';

// The Search Console sync (data-providers.md §5, domain-model.md §3). Two datasets, each with a
// watermark per (site, dataset, search type):
//
//   property_totals   dimensions [date], aggregationType byProperty
//   page_aggregates   dimensions [date, page, country, device], aggregationType byPage
//
// A first sync backfills 16 months in 30-day chunks and resumes from `backfill_through` after a
// failure. Every run re-fetches the last few days, which Google still revises, and flips each row
// to final once it is older than three days. Upserts key on the row's identity, so a re-fetch of a
// provisional day replaces it instead of duplicating it.
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
  lastError: string | null;
}

const watermarkOf = (row: typeof schema.gscSyncState.$inferSelect): Watermark => ({
  lastFinalDate: row.lastFinalDate,
  lastFetchedAt: row.lastFetchedAt,
  backfillComplete: row.backfillComplete,
  backfillThrough: row.backfillThrough,
  lastError: row.lastError,
});

/** The watermark row, created on first use; a racing sync finds the winner's row. */
async function ensureWatermark(tx: Tx, input: { workspaceId: string; siteId: string; dataset: GscDatasetName; searchType: string }) {
  await tx
    .insert(schema.gscSyncState)
    .values({
      workspaceId: input.workspaceId,
      siteId: input.siteId,
      dataset: input.dataset,
      searchType: input.searchType,
      backfillComplete: false,
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(schema.gscSyncState)
    .where(
      and(
        eq(schema.gscSyncState.workspaceId, input.workspaceId),
        eq(schema.gscSyncState.siteId, input.siteId),
        eq(schema.gscSyncState.dataset, input.dataset),
        eq(schema.gscSyncState.searchType, input.searchType),
      ),
    );
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
): Promise<FetchedRow[]> {
  const result = await deps.providers.call<{ rows: FetchedRow[] }>({
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
  return result.data.rows;
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
          schema.gscPageAggregates.page,
          schema.gscPageAggregates.country,
          schema.gscPageAggregates.device,
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

/** One fetched window: map the rows, upsert them and advance the watermark in one transaction. */
async function storeWindow(
  deps: GscSyncDeps,
  input: {
    workspaceId: string;
    siteId: string;
    property: string;
    definition: DatasetDefinition;
    searchType: string;
    start: string;
    end: string;
    fetched: FetchedRow[];
    today: string;
    now: Date;
    backfill: boolean;
  },
): Promise<{ rows: number; watermark: Watermark }> {
  const cutoff = addDays(input.today, -GSC_FINALITY_DAYS);
  const isFinal = (day: string) => day <= cutoff;
  return deps.db.withWorkspace(input.workspaceId, async (tx) => {
    const current = await ensureWatermark(tx, {
      workspaceId: input.workspaceId,
      siteId: input.siteId,
      dataset: input.definition.dataset,
      searchType: input.searchType,
    });
    if (input.definition.dataset === 'property_totals') {
      const rows = input.fetched
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
      const rows = input.fetched
        .filter((row) => typeof row.keys[0] === 'string' && row.keys[0].length === 10 && typeof row.keys[1] === 'string')
        .map((row) => ({
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          property: input.property,
          date: row.keys[0] as string,
          page: row.keys[1] as string,
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

    // The newest day fetched in this window that is already final. A provisional window reaches the
    // cutoff, a backfill chunk may end before it.
    const finalThrough = input.end <= cutoff ? input.end : cutoff;
    const lastFinalDate = current.lastFinalDate === null || current.lastFinalDate < finalThrough ? finalThrough : current.lastFinalDate;
    const backfillThrough = input.backfill
      ? current.backfillThrough === null || current.backfillThrough < input.end
        ? input.end
        : current.backfillThrough
      : current.backfillThrough;
    const backfillComplete = input.backfill ? backfillThrough !== null && backfillThrough >= input.today : current.backfillComplete;
    const [updated] = await tx
      .update(schema.gscSyncState)
      .set({
        lastFinalDate,
        lastFetchedAt: input.now,
        backfillThrough,
        backfillComplete,
        lastError: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(schema.gscSyncState.workspaceId, input.workspaceId),
          eq(schema.gscSyncState.siteId, input.siteId),
          eq(schema.gscSyncState.dataset, input.definition.dataset),
          eq(schema.gscSyncState.searchType, input.searchType),
        ),
      )
      .returning();
    return { rows: input.fetched.length, watermark: watermarkOf(updated!) };
  });
}

async function recordFailure(
  deps: GscSyncDeps,
  input: { workspaceId: string; siteId: string; dataset: GscDatasetName; searchType: string; message: string; now: Date },
) {
  await deps.db.withWorkspace(input.workspaceId, async (tx) => {
    await ensureWatermark(tx, input);
    await tx
      .update(schema.gscSyncState)
      .set({ lastError: input.message, updatedAt: input.now })
      .where(
        and(
          eq(schema.gscSyncState.workspaceId, input.workspaceId),
          eq(schema.gscSyncState.siteId, input.siteId),
          eq(schema.gscSyncState.dataset, input.dataset),
          eq(schema.gscSyncState.searchType, input.searchType),
        ),
      );
  });
}

/**
 * Runs the sync for one site. Throws when the site has no active Search Console connection or no
 * selected property; a provider failure is recorded on the watermark and rethrown so the worker
 * retries from the last committed chunk.
 */
export async function runGscSync(deps: GscSyncDeps, input: GscSyncInput): Promise<GscSyncResult> {
  const now = (deps.now ?? (() => new Date()))();
  const today = dayString(now);
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
    const connection = await liveConnection(tx, input.workspaceId, input.siteId, GSC_CONNECTOR_ID);
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
    return { property, connectionId: connection.id };
  });

  const definitions = input.dataset ? DATASETS.filter((d) => d.dataset === input.dataset) : DATASETS;
  const results: DatasetSyncResult[] = [];

  for (const definition of definitions) {
    let state: Watermark = await deps.db.withWorkspace(input.workspaceId, async (tx) =>
      watermarkOf(
        await ensureWatermark(tx, { workspaceId: input.workspaceId, siteId: input.siteId, dataset: definition.dataset, searchType }),
      ),
    );
    let totalRows = 0;
    try {
      // 1. The fresh window: Google revises the last few days, so they are always re-read.
      const provisionalStart = addDays(today, -PROVISIONAL_DAYS);
      const fetched = await fetchWindow(deps, {
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        connectionId: prepared.connectionId,
        property: prepared.property,
        definition,
        searchType,
        start: provisionalStart,
        end: today,
        refresh: true,
      });
      const stored = await storeWindow(deps, {
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        property: prepared.property,
        definition,
        searchType,
        start: provisionalStart,
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
      });
    } catch (err) {
      const message = safeErrorText(err instanceof Error ? err.message : String(err), 500);
      await recordFailure(deps, {
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        dataset: definition.dataset,
        searchType,
        message,
        now,
      });
      throw err;
    }
  }

  return { siteId: input.siteId, property: prepared.property, connectionId: prepared.connectionId, datasets: results };
}
