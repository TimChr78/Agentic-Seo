# ADR-0003: Postgres as the only required database

- Status: Proposed
- Date: 2026-11-12

## Context
Agentic Marketing runs Postgres, ClickHouse, NATS and Valkey because of its event hot path. SEO data is different:
- crawl state is transient but needs a queue;
- facts (rank observations, GSC rows, AI answers) arrive in daily batches;
- blobs (HTML, screenshots, reports) are large.

A single site's GSC history is typically 10⁵–10⁷ rows.

## Decision
- **Postgres 17** for everything relational. This includes the Graphile Worker job queue, the crawl frontier (table as queue with `SKIP LOCKED`, the pattern validated in Agentic Marketing's journey runtime spike) and the outbox for events.
- Facts live in **monthly range-partitioned tables** with BRIN indexes on date, accessed through a `facts` repository interface.
- **Object storage** (S3-compatible, or the local filesystem driver) holds HTML snapshots, screenshots and reports.

## Alternatives
- ClickHouse for facts: faster at scale, but one more stateful service for every self-hoster. It stays the upgrade path behind the `facts` interface.
- Durable Objects or SQLite per audit (as OpenSEO): this ties us to Cloudflare or a custom runtime.

## Consequences
`docker compose up` runs two containers (app, Postgres), plus an optional renderer. Spike 1 must prove this on a **mixed workload**, not a single crawl: a crawl with a realistic link graph, a concurrent GSC backfill, queue activity and interactive API queries. It measures API latency, WAL and disk growth, and crash recovery. Fact tables need composite indexes on `(workspace_id, site_id, …)` in addition to BRIN on date. In the single-process `all` role, extraction runs in `worker_threads` so the API stays responsive. The local filesystem blob driver is supported only for single-node installs; more than one node requires S3-compatible storage. Per-audit link-edge tables are partitions dropped after finalize, to avoid bloat.
