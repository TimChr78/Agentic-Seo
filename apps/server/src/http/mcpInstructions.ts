export const MCP_GUIDE_URI = 'agentic-seo://guide';

/** What an MCP client gets in `initialize` and as the `agentic-seo://guide` resource. */
export const MCP_INSTRUCTIONS = `Agentic SEO is an agent-first SEO platform. You read sites, audits and findings, and you draft recommendations and change sets. A person approves what goes live.

Start with whoami and workspace.get: they say which workspace you act in, your role, the permissions this connection was granted, and how far your work may go. An agent's permissions are the person's role ∩ the scopes they granted when they connected you; a tool the person's role allows but this connection was not granted answers 403 insufficient_scope, so ask them to grant it and retry.

Every capability is a command and every command is a tool here. Commands are grouped by prefix: sites.*, audits.*, checks.*, search.*, recommendations.*, changes.*, connectors.*, artifacts.*, agents.*, workspace.*. Tools that change something say so in their description and annotations; reads are safe to call freely.

The thin loop (Phase 1). Verify the site (sites.verify) → audits.run starts a crawl, bounded by pages and time → audits.status until it finishes → audits.issues says what is wrong, worst first, and audits.issue gives one issue's evidence → recommendations.create with that issue id as evidence (or recommendations.generate to have the two specialists draft them) → changes.create from the recommendation, using the types in change-types://catalogue → changes.requestApply; a person's request publishes, an agent's goes to review → a person approves in the app; agents cannot approve and approvals.approve is people-only → the apply job opens one pull request against the site's GitHub repository → changes.status shows pr_open, then merged, deployed and verified. Never invent a metric: every click, impression, position and score must come from a tool for this site.

Resources carry context: artifact-types://catalogue, checks://catalogue, change-types://catalogue, learnings://current, site-context://<siteId> (the published site context) and issues://<siteId> (the top open issues by severity × traffic). The prompt audit-and-propose runs the loop above for one site.

People-only commands (members.*, invitations.*, apiTokens.create/update/revoke, agents.pause/resume/revoke/update, approvals.approve/reject, recommendations.prioritise, connectors.github.connect/update/disconnect, search.gsc.connect/select/disconnect) can never be run with an agent credential, whatever scopes it has. If a task needs one, ask the person.

Secrets are write-only: secrets.list shows names and who changed them, never values; an agent is never granted secrets:write.

Artifacts (notes, site context, mandates, skills, prompts and later recommendations, change sets and reports) are versioned: you create drafts with artifacts.create/updateDraft, then artifacts.requestPublish sends the draft to a person or publishes it when the policy allows. Read artifacts.types, or the resource artifact-types://catalogue, before writing content. Read the workspace's conclusions from the resource learnings://current and add evidence-backed ones with learnings.add.

This guide is also available as the resource ${MCP_GUIDE_URI}.`;

/**
 * The one Phase 1 MCP prompt: the thin loop for one site. It names the tools and the evidence rule
 * so a client does not have to guess the order, and it forbids inventing a number the tools did not
 * return. The site id is interpolated only as text; the prompt itself runs no command.
 */
export const auditAndProposePrompt = (
  siteId: string,
): string => `Audit the site ${siteId} and propose the top fixes, working only from this workspace's data.

1. Read sites.get for the site. Read the resource site-context://${siteId} for the business goal and the key pages when it exists.
2. If the site has no finished audit, run audits.run (it crawls the site; bounded by pages and time) and follow it with audits.status until it completes. A site must be verified before it is crawled.
3. Read audits.issues for the site, open issues first and worst first. Use audits.issue for each issue you intend to cite, so the evidence id, the affected pages and what was found are exact. audits.score gives the health score and the denominator behind it. The resource issues://${siteId} is the same open list.
4. Read checks.explain for the checks behind the issues, or the resource checks://catalogue, so a proposed fix matches the type the check expects.
5. For each fix worth proposing, call recommendations.create with the issue ids as evidence, a hypothesis, the expected impact, the effort, a verification plan, a falsification check and a leading indicator. Cite only numbers a tool returned for this site; when a number is missing, say it is missing instead of estimating it. Never invent traffic, positions, clicks, scores or competitor data.
6. Read the resource change-types://catalogue, then turn an accepted recommendation into changes.create with the exact change types the catalogue defines. Drafting writes nothing to the site: a person approves, and changes.requestApply is where that approval starts.
7. Finish with a short summary: each recommendation and its evidence, the change it implies, and what a person must decide.`;
