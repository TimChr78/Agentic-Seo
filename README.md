# Agentic SEO

An open-source, self-hostable SEO platform built **agent-first**. It is the sister product of [Agentic Marketing](https://github.com/TimChr78/Agentic-Marketing).

Every capability is a command that works the same over REST, MCP (for AI agents) and the web UI, under the same permissions, approvals and audit log. Agents run the whole SEO loop inside borders a person sets: they **find** issues and opportunities, **recommend** with evidence, **change** the site through a pull request or CMS, **verify** the change, and **learn** from measured outcomes. You bring your own data and LLM keys.

> **Status: design, before code.** This repository currently holds the design, the architecture and the implementation plan. Development has not started.

## What it will do

- **Site audits** without paid keys: an SSRF-safe, polite crawler; about 120 deterministic checks (technical, on-page, schema, international, images, performance, GEO and AI crawler access, agent readiness, local, e-commerce) plus LLM-judged checks (E-E-A-T, intent, citability); a health score that names what was not evaluated; drift monitoring.
- **First-party search data:** Google Search Console, GA4, PageSpeed Insights and CrUX, Bing Webmaster, IndexNow, with opportunity detectors (striking distance, CTR gaps, decay, cannibalisation).
- **Market research** (bring your DataForSEO key): keywords, SERPs, domains and competitors, backlinks (with a free Common Crawl fallback), clustering. Every paid action shows its estimate, and budgets cap spend.
- **Monitoring:** rank tracking (including local and geo-grid) and AI visibility across answer engines.
- **Agents:** specialists for each SEO discipline, recommendations with hypotheses and falsification checks, change sets with diffs, verification and rollback, mandates with autonomy levels, a guardian that watches rankings and crawl health, hosted programmes, agent-written reports, and plugins for Claude Code, Codex and Cursor.

It aims at feature parity with [OpenSEO](https://github.com/every-app/open-seo), takes the depth of [claude-seo](https://github.com/AgriciDaniel/claude-seo)'s specialist audits, and adds the closed agentic loop. See the [feature-parity matrix](docs/architecture/feature-parity.md).

## Quick start

Docker with the Compose plugin, from a checkout:

```bash
git clone https://github.com/TimChr78/Agentic-Seo.git && cd Agentic-Seo
corepack pnpm install
corepack pnpm cli init                                             # writes .env with fresh secrets
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
docker compose exec app aseo bootstrap --email you@example.com --workspace 'My site'
docker compose exec app aseo doctor
```

The admin UI and the REST API are then on <http://localhost:3000>. `docker-compose.yml` alone pulls
the release image; the second `-f` builds this checkout until the first release exists. See
[Docker Compose](docs/deployment/compose.md) for the environment, upgrades and backups.

## Documentation

- [Architecture](docs/architecture/README.md): overview, domain model, crawler and audits, data providers, agents and autonomy, security, tech stack, and the [ADRs](docs/architecture/adr/).
- [Implementation plan](docs/architecture/roadmap.md): spikes, phases and "done" criteria.
- [Open questions](docs/architecture/open-questions.md).
- [UI design](docs/design/DESIGN.md): it inherits Agentic Marketing's design system.

## Credits

Functional reference: [OpenSEO](https://github.com/every-app/open-seo) (MIT). Audit methodology inspiration: [claude-seo](https://github.com/AgriciDaniel/claude-seo) (MIT). No code is copied from either project.

## License

[MIT](LICENSE).
