# ADR-0002: TypeScript modular monolith, one image, role-based processes

- Status: Proposed
- Date: 2026-11-12

## Context
The project has one maintainer, it must be self-hostable, and its workload is mixed: an interactive API, long crawls, scheduled data pulls and agent runs.

## Decision
One TypeScript codebase and one OCI image. A `ROLE` variable selects `api`, `worker`, `scheduler` or `all`. Packages are modules with service interfaces. The browser renderer is a **separate optional image**, because Chromium would triple the main image's size and attack surface.

## Alternatives
- Microservices: too much to operate for one person.
- Python for crawling and analysis (as claude-seo): a second language and runtime for one module.

## Consequences
Crawls scale by adding worker replicas; the scheduler stays a single replica. A crawl must never block the API's event loop: extraction runs in workers only, and CPU-heavy steps can move to `worker_threads`.
