import { ChangeSchema } from '@agentic-seo/changes';
import type { ReachEstimate } from '@agentic-seo/commands';
import { isoDateTime } from '@agentic-seo/core';
import { z } from 'zod';

// Artifact types and their content schemas. Every type gets versioning, drafts, diffs and approvals
// from the generic artifact commands; the content schema is what makes content valid for that type.
//
// Prefixes are reserved per type so ids are self-describing and stable for the clients that parse
// them: not note, sct site context, mnd agent mandate, skl skill, prm prompt, rcm recommendation,
// chg change set, brf content brief, smt schema template, rpt report, rtp report template,
// rkt rank tracker, ait AI visibility tracker, aud audit profile, hag hosted agent.
//
// Phase 0/1 implements content for note, site_context, agent_mandate, skill, prompt, change_set and
// recommendation. The other SEO types have a placeholder schema that refuses content with the phase
// it arrives in, so their prefixes and names are reserved now and no caller can mistake a draft for
// a working type.

const Key = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour');
const Days = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

const note = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10_000).describe('Markdown text'),
});

// Site context is the shared memory every agent starts from (domain-model §1): what the business
// does, the current goal, positioning, how to write, the pages that matter, competitors and the
// running research log. One artifact per site; a site id is passed at creation.
const keyPage = z.object({
  url: z.string().url().max(2000),
  label: z.string().trim().min(1).max(120),
  notes: z.string().max(1000).default('').describe('Why this page matters, e.g. "pricing page, main converter"'),
});

const competitorRef = z.object({
  domain: z.string().trim().min(1).max(253).describe('Competing domain, e.g. "example.com"'),
  notes: z.string().max(1000).default('').describe('Where it competes with the site, in one line'),
});

const researchLogEntry = z.object({
  at: isoDateTime('at').describe('When the finding was recorded, e.g. 2026-11-12T09:00:00Z'),
  note: z.string().trim().min(1).max(2000).describe('What was learned'),
  evidence: z.array(z.string().max(500)).max(20).default([]).describe('URLs, artifact ids or short citations that back the finding'),
});

const siteContext = z.object({
  businessOverview: z.string().trim().min(1).max(4000).describe('What the business does, for whom, and what makes it different'),
  currentGoal: z.string().max(2000).default('').describe('The goal the work should serve right now, e.g. "grow organic signups"'),
  positioning: z.string().max(4000).default('').describe('How the site wants to be positioned against its competitors'),
  writingPreferences: z
    .object({
      voice: z.string().max(2000).default('').describe('Tone, person and style, e.g. "plain English, second person"'),
      style: z.string().max(4000).default('').describe('Concrete rules: sentence length, headings, examples'),
      avoid: z.array(z.string().max(500)).max(50).default([]).describe('Claims, words and topics never to use'),
    })
    .default({ voice: '', style: '', avoid: [] }),
  keyPages: z
    .array(keyPage)
    .max(100)
    .default([])
    .describe('Pages that matter most: home, pricing, top converters. Reach counts them above any threshold'),
  competitors: z.array(competitorRef).max(50).default([]).describe('Domains this site competes with'),
  researchLog: z.array(researchLogEntry).max(200).default([]).describe('Append-only findings with their evidence; newest last'),
});
export type SiteContext = z.output<typeof siteContext>;

// Agent mandates (agents-and-autonomy §4): the borders a person grants one agent. A level per SEO
// action class (0 observe … 4 run the loop; capped by the workspace ceilings), what the agent may
// touch, SEO limits, tripwires and a validity period. Publishing a mandate is a `settings` action
// and only people may do it, exactly like the marketing original.
const MandateLevel = z.number().int().min(0).max(4);
const MANDATE_CLASSES = [
  'research.spend',
  'crawl',
  'draft',
  'report.share',
  'index.submit',
  'site.content',
  'site.structural',
  'settings',
  'destructive',
] as const;

const Tripwire = z.enum([
  'verification.failed',
  'gsc.clicks_on_changed_urls',
  'gsc.impressions_on_changed_urls',
  'audit.new_critical_issue',
  'rank.drop',
  'spend.anomaly',
]);

const agentMandate = z.object({
  agent: z
    .string()
    .regex(/^agt_[0-9a-f]{32}$/, 'An agent id, e.g. from agents.list')
    .describe('The agent this mandate is for'),
  purpose: z.string().trim().min(1).max(1000).describe('What the agent is for, in a sentence or two; shown on holds and in reviews'),
  goals: z
    .array(
      z.object({
        measure: z.string().min(1).describe('A measurable goal, e.g. "audit.health_score" or "gsc.clicks"'),
        target: z.number().optional(),
        direction: z.enum(['up', 'down']).default('up'),
      }),
    )
    .max(10)
    .default([]),
  scope: z
    .object({
      sites: z.array(z.string().uuid()).max(50).default([]).describe('Sites the agent may touch; empty: any site in the workspace'),
      changeTypes: z
        .array(z.string().max(64))
        .max(50)
        .default([])
        .describe('Change types it may apply, e.g. meta.title, redirect; empty: any within the levels'),
      connectors: z.array(z.string().max(64)).max(20).default([]).describe('Connectors it may act through, e.g. github; empty: any'),
      artifactTypes: z.array(z.string()).max(30).default([]).describe('Artifact types it may publish; empty: any within the levels'),
      artifacts: z.array(z.string()).max(100).default([]).describe('Specific artifacts it may change; empty: any of the allowed types'),
    })
    .strict()
    .default({ sites: [], changeTypes: [], connectors: [], artifactTypes: [], artifacts: [] }),
  levels: z
    .partialRecord(z.enum(MANDATE_CLASSES), MandateLevel)
    .default({})
    .describe('Level per action class: 0 observe, 1 propose, 2 act with veto, 3 act within limits, 4 run the loop. Missing: 1'),
  limits: z
    .object({
      researchSpendPerDay: z.number().min(0).optional().describe('USD the agent may spend on paid research per day'),
      pagesPerChangeSet: z.number().int().min(0).optional().describe('Most pages one change set may touch'),
      trafficAtRiskPerChangeSet: z.number().int().min(0).optional().describe('GSC clicks/28d one change set may put at risk'),
      changeSetsPerWeek: z.number().int().min(0).optional().describe('Change sets it may apply in a rolling 7 days'),
      changesPerDay: z.number().int().min(0).optional().describe('Agent changes per day, on top of the workspace limit'),
    })
    .strict()
    .default({}),
  tripwires: z
    .array(Tripwire)
    .max(20)
    .default([])
    .describe('Guardian signals that pause or roll the agent back (Phase 7); the list is recorded now'),
  workingHours: z
    .object({
      start: Clock,
      end: Clock,
      days: z.array(Days).optional(),
    })
    .optional()
    .describe('Irreversible actions outside these hours, in the workspace time zone, wait for a person'),
  blackoutDates: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .max(60)
    .default([])
    .describe('Dates (YYYY-MM-DD, workspace time zone) on which the mandate does not apply'),
  holdWindow: z
    .enum(['PT30M', 'PT1H', 'PT2H', 'PT4H', 'PT12H', 'PT24H'])
    .default('PT2H')
    .describe('How long a level-2 action would wait for a veto before it runs (Phase 7)'),
  escalation: z
    .object({ userIds: z.array(z.string()).max(20).default([]) })
    .default({ userIds: [] })
    .describe('Who besides the sponsor is told about holds, refusals and tripwire hits'),
  expires: isoDateTime('expires').describe('The mandate stops applying after this (publish a new version to renew)'),
});
export type AgentMandate = z.output<typeof agentMandate>;

// Skills are named playbooks (agents-and-autonomy §5): Markdown instructions plus the tools a
// hosted run may use. Versioned and reviewed like any other artifact; only a published version is
// used by a run.
const skill = z.object({
  title: z.string().trim().min(1).max(200).describe('What the skill is called, e.g. "Title rewrites that keep intent"'),
  instructions: z
    .string()
    .trim()
    .min(1)
    .max(8000)
    .describe('Markdown playbook the agent follows when this skill applies; written by people'),
  allowedTools: z
    .array(z.string().trim().min(1).max(100))
    .max(50)
    .default([])
    .describe('Command or tool names the playbook may use; empty means the agent’s own grant decides'),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]).describe('Short labels for finding the skill'),
});
export type Skill = z.output<typeof skill>;

// A prompt is an instruction block with named inputs, versioned so a change is reviewable and an
// agent can cite the published version it used. It also says what a good answer looks like: named
// text slots with a length cap and a fallback, or one key out of a fixed set. Small test cases let
// a person try a version and see the answers before anything depends on it.
const promptVariable = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .describe('Input name used in the instructions, e.g. "page_url"'),
  description: z.string().max(500).default('').describe('What the value is, for the person filling it in'),
});

const promptOption = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .describe('The answer value, e.g. "blog_post"'),
  description: z.string().trim().min(1).max(300),
});

const promptSlot = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .describe('Answer field the text is keyed by, e.g. "title"'),
  description: z.string().trim().min(1).max(500),
  maxLength: z.number().int().min(1).max(8000),
  fallback: z.string().max(8000).default('').describe('Used when the model’s text fails a check'),
});

const promptTest = z.object({
  name: z.string().trim().min(1).max(200),
  input: z.record(z.string(), z.unknown()).default({}).describe('The input data the prompt sees; supplies each variable'),
  expect: z
    .object({
      option: z.string().max(64).optional().describe('Choice prompts: the key a good answer should pick'),
      contains: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
      notContains: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    })
    .strict()
    .default({ contains: [], notContains: [] }),
});

const promptOutput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    slots: z.array(promptSlot).min(1).max(8),
    forbidden: z
      .array(z.string().trim().min(1).max(100))
      .max(50)
      .default([])
      .describe('Words and claims a generated text must not contain'),
  }),
  z.object({
    kind: z.literal('choice'),
    options: z.array(promptOption).min(2).max(20).describe('Exactly one of these is the answer'),
  }),
]);

const prompt = z
  .object({
    title: z.string().trim().min(1).max(200),
    instructions: z.string().trim().min(1).max(20_000).describe('The prompt text; reference inputs as {{variable_name}}'),
    variables: z.array(promptVariable).max(50).default([]),
    modelTier: z.enum(['fast', 'deep']).default('fast').describe('Default model tier for a run of this prompt'),
    maxOutputTokens: z.number().int().min(16).max(8000).default(1024).describe('Most tokens one answer may use'),
    output: promptOutput.default({
      kind: 'text',
      slots: [{ name: 'text', description: 'The answer', maxLength: 4000, fallback: '' }],
      forbidden: [],
    }),
    tests: z.array(promptTest).max(20).default([]),
  })
  .superRefine((def, ctx) => {
    if (def.output.kind !== 'choice') return;
    const keys = new Set(def.output.options.map((o) => o.key));
    def.tests.forEach((t, index) => {
      if (t.expect.option !== undefined && !keys.has(t.expect.option))
        ctx.addIssue({
          code: 'custom',
          path: ['tests', index, 'expect', 'option'],
          message: `Test "${t.name}" expects unknown option "${t.expect.option}"`,
        });
    });
  });
export type Prompt = z.output<typeof prompt>;

// A recommendation (ADR-0008, domain-model.md §4, DESIGN.md §4.3): what to do about the evidence,
// why it should work, and how we will know it did not. The synthesis fields are required for every
// author — a person writing one by hand has to be as falsifiable as an agent — and the command
// that creates one validates the evidence ids against the database and computes the traffic at
// stake itself, so a number in here is never invented (packages/recommendations).
//
// The status is not part of the content: it is derived from the artifact's own lifecycle (draft,
// published, rejected) and the change sets whose content points here, so it cannot disagree with
// what actually happened.
const recommendationChangeType = z
  .enum(['meta.title', 'meta.description', 'schema.jsonld', 'image.alt', 'redirect'])
  .describe('A Phase 1 change type (packages/changes); the catalogue is the limit of what a change set can apply');

const recommendationEvidence = z.strictObject({
  kind: z
    .enum(['issue', 'finding', 'search_fact', 'audit'])
    .describe(
      'issue: a site issue id; finding: an audit finding id; search_fact: the absolute URL of a page with Search Console data; audit: an audit id',
    ),
  id: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .describe('The evidence id, or the page URL for a search_fact; it must exist for this site in this workspace'),
  note: z.string().trim().min(1).max(500).describe('What this evidence shows, in one line, for a reviewer'),
});

const reachEstimate = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('unknown'),
    reason: z.string().trim().min(1).max(1000).describe('What is missing, in a sentence a person can act on'),
  }),
  z.strictObject({
    kind: z.literal('known'),
    affectedUrls: z.number().int().min(0).describe('The evidence pages the estimate counted'),
    clicksAtRisk: z.number().int().nullable().describe('Search Console clicks over 28 days; null when the pages have no history'),
    impressionsAtRisk: z.number().int().nullable().optional(),
    clicksAtRiskLastYear: z.number().int().nullable().optional(),
    impressionsAtRiskLastYear: z.number().int().nullable().optional(),
    criticalPages: z.array(z.string().max(2000)).max(50).default([]),
    dataThrough: z.string().max(20).optional().describe('The newest day of page data the estimate used, YYYY-MM-DD'),
  }),
]);

/** The content's traffic-at-stake field is packages/commands' ReachEstimate, not a look-alike. */
export const recommendationReachSchema = reachEstimate satisfies z.ZodType<ReachEstimate>;

const recommendation = z.strictObject({
  title: z.string().trim().min(1).max(200).describe('What to do, in one line, e.g. "Rewrite the titles of 12 striking-distance pages"'),
  rationale: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe('Why this, why now, in Markdown; cite the evidence by id, never a metric that is not in it'),
  evidence: z.array(recommendationEvidence).min(1).max(20).describe('What the recommendation rests on; at least one item'),
  hypothesis: z.string().trim().min(1).max(2000).describe('The causal claim: if we do this, then that, because …'),
  expectedImpact: z.strictObject({
    summary: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe('What we expect to change, stated as an estimate: "Expected: CTR +10–20% on 34 queries"'),
    trafficAtStake: reachEstimate.describe('Computed by recommendations.create from the evidence pages, never supplied by a caller'),
    confidence: z.enum(['low', 'medium', 'high']).describe('How sure we are, given the evidence'),
  }),
  effort: z.enum(['small', 'medium', 'large']).describe('How much work this is for a person or an agent'),
  dependsOn: z
    .array(z.string().regex(/^rcm_[0-9a-f]{32}$/, 'A recommendation id, e.g. from recommendations.list'))
    .max(20)
    .default([])
    .describe('Recommendations that should land first; cycles are refused'),
  verificationPlan: z.strictObject({
    recheck: z.string().trim().min(1).max(2000).describe('What to re-fetch or re-measure, and what it must show'),
    when: z.string().trim().min(1).max(500).describe('When, e.g. "28 days after the deploy"'),
  }),
  falsificationCheck: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe('How we would know this failed, in a sentence that starts "We will know this failed if…"'),
  leadingIndicator: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe('The earliest signal that it is working or not, e.g. "impressions-weighted CTR, daily"'),
  proposedChanges: z
    .array(
      z.strictObject({
        type: recommendationChangeType,
        url: z.string().url().max(2048).describe('The page the change is about'),
        summary: z.string().trim().min(1).max(500).describe('The edit, in one line, for a reviewer'),
      }),
    )
    .max(20)
    .default([])
    .describe('Change sets to draft from this; a hint for whoever implements it, not a change set'),
  author: z
    .strictObject({
      kind: z.enum(['person', 'agent', 'specialist']),
      specialist: z.enum(['strategist', 'technical']).optional(),
    })
    .superRefine((author, ctx) => {
      if (author.kind === 'specialist' && !author.specialist)
        ctx.addIssue({ code: 'custom', path: ['specialist'], message: 'A specialist author names which specialist wrote it.' });
    })
    .describe('Who wrote this: a person, an agent (API token or MCP client), or a hosted specialist'),
});
export type Recommendation = z.output<typeof recommendation>;

/** A type whose content arrives in a later phase: the schema refuses every value with the reason. */
function placeholder(phase: number) {
  return z.unknown().superRefine((_value, ctx) => {
    ctx.addIssue({
      code: 'custom',
      message: `This artifact type arrives in Phase ${phase}.`,
    });
  });
}

// A change set (ADR-0007, domain-model.md §4): an ordered set of typed changes to one site through
// one connector, each already resolved to the source file it edits, with the base commit, the
// file's hash at drafting time and the rendered diff. The site comes from the artifact row, never
// from the content, so a change set cannot be re-pointed at another site by editing its JSON.
//
// Drafting resolves and applies every change in memory (packages/change-sets), which is why the
// stored shape carries the resolution: applying the change set later re-reads each file and
// compares `sourceHash`, so a source that moved on is caught before a branch is created. The diff
// is stored because the reviewer sees it without the source file being re-read.
const changeSetSource = z.strictObject({
  path: z.string().min(1).max(1024).describe('The repository file this change edits, e.g. about/index.html'),
  editor: z.enum(['html', 'markdown_frontmatter', 'netlify']).describe('The editor that wrote the change'),
  confidence: z
    .enum(['exact', 'pattern', 'glob'])
    .describe('How the mapping found the file: an exact route, a route pattern, or a glob of drafts'),
  affectedRoutes: z
    .array(z.string().min(1).max(2048))
    .min(1)
    .max(500)
    .describe('Every route the edit reaches; a layout source lists all routes it renders, which is what reach counts'),
  fields: z
    .record(z.string(), z.array(z.string().min(1).max(120)).min(1))
    .optional()
    .describe('markdown_frontmatter only: change field -> frontmatter keys, from the mapping rule'),
  dialect: z
    .enum(['yaml', 'strip_quotes'])
    .optional()
    .describe('markdown_frontmatter only: how the build quotes a written value (the pilot uses strip_quotes)'),
});

const changeSetFileDiff = z.strictObject({
  path: z.string().min(1).max(1024),
  status: z.enum(['added', 'modified', 'deleted']),
  unified: z.string().max(200_000).describe('A unified diff with a/ and b/ headers; empty when nothing changed'),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
});

const changeSetChange = z.strictObject({
  change: ChangeSchema.describe('The typed edit (packages/changes); applying it writes source.path'),
  source: changeSetSource,
  baseSha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/, 'A commit SHA: 40 hex characters from GitHub')
    .describe('The base branch head the change was resolved against'),
  sourceHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'The sha256 of the source file, from sourceHashOf()')
    .describe('The file at baseSha; the apply job refuses a file that hashes differently now'),
  diff: changeSetFileDiff,
});

const changeSet = z.strictObject({
  connector: z.literal('github').describe('The connector that applies this change set; only GitHub pull requests in Phase 1'),
  title: z.string().trim().min(1).max(200).describe('What this change set does, in one line; the pull request title'),
  summary: z.string().trim().min(1).max(2000).describe('Why these changes, and what evidence backs them'),
  recommendationId: z
    .string()
    .regex(/^rcm_[0-9a-f]{32}$/, 'A recommendation id, e.g. from recommendations.create')
    .optional()
    .describe('The recommendation this change set implements, when there is one'),
  changes: z.array(changeSetChange).min(1).max(50).describe('The edits in order; several may touch one file, and the diff is the net edit'),
  verificationPlan: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe('What a re-fetch after deployment must show; the verification job checks every affected URL against it'),
  rollbackPlan: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe('How to undo this: a revert pull request while the files still match, or a new proposed change set'),
});
export type ChangeSetContent = z.output<typeof changeSet>;
export type ChangeSetDraftedChange = z.output<typeof changeSetChange>;
/** The content schema, for packages that build or check a change set (packages/change-sets). */
export const changeSetContentSchema = changeSet;

export const artifactTypes = {
  note: { prefix: 'not', label: 'Note', description: 'Free-form note, used to exercise the artifact system.', content: note },
  site_context: {
    prefix: 'sct',
    label: 'Site context',
    description:
      'The shared memory every agent starts from: business overview, current goal, positioning, writing preferences, key pages, competitors and research log. One per site; agents read it as site-context://<site> in a later phase.',
    content: siteContext,
    singleton: true,
  },
  agent_mandate: {
    prefix: 'mnd',
    label: 'Agent mandate',
    description:
      'The borders a person grants one agent (agents-and-autonomy §4): a level per SEO action class (0 observe, 1 propose, 2 act with veto, 3 act within limits, 4 run the loop), the sites and change types it may touch, SEO limits, tripwires and an end date. Only people create, change or approve mandates; the workspace ceilings cap every level.',
    content: agentMandate,
    peopleOnly: true,
  },
  skill: {
    prefix: 'skl',
    label: 'Skill',
    description:
      'A named playbook (Markdown instructions and the tools it may use) that a hosted run can follow. Versioned so people review it like any other artifact.',
    content: skill,
  },
  prompt: {
    prefix: 'prm',
    label: 'AI prompt',
    description: 'Instructions for an AI step, with named inputs and a default model tier. Versioned so a change is reviewable.',
    content: prompt,
  },
  recommendation: {
    prefix: 'rcm',
    label: 'Recommendation',
    description:
      'A versioned, evidence-backed recommendation with a hypothesis, expected impact, verification plan and falsification check. Create one with recommendations.create, which validates its evidence and computes the traffic at stake.',
    content: recommendation,
  },
  change_set: {
    prefix: 'chg',
    label: 'Change set',
    description: 'An ordered set of changes to one site through one connector, with a diff and a rollback plan.',
    content: changeSet,
    // The source path, base commit, source hash and diff are derived from the repository while
    // drafting, and the apply worker re-derives them. The generic artifact commands would let a
    // caller write any of them by hand; only changes.create and changes.updateDraft may.
    serverOwned: true,
  },
  content_brief: {
    prefix: 'brf',
    label: 'Content brief',
    description: 'An editorial brief for one backlog topic: thesis, audience, sources, outline and success measure.',
    content: placeholder(6),
  },
  schema_template: {
    prefix: 'smt',
    label: 'Schema template',
    description: 'A reusable JSON-LD template with typed parameters for a page type.',
    content: placeholder(1),
  },
  report: {
    prefix: 'rpt',
    label: 'Report',
    description: 'A rendered report a person can share, with the evidence behind it.',
    content: placeholder(6),
  },
  report_template: {
    prefix: 'rtp',
    label: 'Report template',
    description: 'A reusable report layout and section set.',
    content: placeholder(6),
  },
  rank_tracker: {
    prefix: 'rkt',
    label: 'Rank tracker',
    description: 'Keywords × market × device × schedule. A recurring spend commitment, reviewed like any other artifact.',
    content: placeholder(4),
  },
  ai_visibility_tracker: {
    prefix: 'ait',
    label: 'AI visibility tracker',
    description: 'Prompts × engines × market × schedule, with the brand and competitors to match in answers.',
    content: placeholder(5),
  },
  audit_profile: {
    prefix: 'aud',
    label: 'Audit profile',
    description: 'Saved crawl settings and check overrides for a site.',
    content: placeholder(2),
  },
  hosted_agent: {
    prefix: 'hag',
    label: 'Hosted agent',
    description: 'A programme template that runs a specialist on a schedule at level 1.',
    content: placeholder(6),
  },
} as const;

export type ArtifactType = keyof typeof artifactTypes;
export const ARTIFACT_TYPES = Object.keys(artifactTypes) as [ArtifactType, ...ArtifactType[]];
export const artifactTypeEnum = z.enum(ARTIFACT_TYPES);

/**
 * Looser schemas for saving drafts: a draft may be unfinished. Types without an entry use their
 * normal content schema. Publishing always validates the full schema in `artifactTypes`.
 */
export const draftContentSchemas = new Map<ArtifactType, z.ZodType>();

/**
 * Checks beyond the schema that need heavy libraries. Packages register them; artifact commands run
 * them on every save so an agent gets the error right away.
 */
export type ContentValidator = (content: unknown) => string[] | Promise<string[]>;

/**
 * A registry with one entry per artifact type. A second registration for the same type would
 * silently replace the first, so it throws instead.
 */
class OnePerType<V> extends Map<ArtifactType, V> {
  constructor(private readonly what: string) {
    super();
  }
  override set(type: ArtifactType, value: V): this {
    if (this.has(type)) throw new Error(`${type} already has a ${this.what}; combine them in one function`);
    return super.set(type, value);
  }
}

export const contentValidators = new OnePerType<ContentValidator>('content validator');
/** Checks that only apply to publishing (a draft may be unfinished), e.g. a referenced artifact exists. */
export type PublishValidator = (
  content: unknown,
  tx: import('@agentic-seo/db').Tx,
  artifact?: { id: string; type: string; workspaceId: string },
) => Promise<string[]>;
export const publishValidators = new OnePerType<PublishValidator>('publish validator');

/** Ids an artifact's content refers to, for display in artifacts.get. */
export type ReferenceExtractor = (content: unknown) => string[];
export const referenceExtractors = new OnePerType<ReferenceExtractor>('reference extractor');
export function referencesOf(type: string, content: unknown): string[] {
  return referenceExtractors.get(type as ArtifactType)?.(content) ?? [];
}

/** A key that is a lowercase identifier; exported for content schemas in other packages. */
export { Key as artifactKey };
