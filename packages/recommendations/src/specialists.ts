import { artifactTypes, type Skill } from '@agentic-seo/artifacts';
import { hashValue, newId } from '@agentic-seo/core';
import { schema, type Tx } from '@agentic-seo/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

// The two specialists of task G (agents-and-autonomy.md §5) are `skill` artifacts, not code: a
// playbook is Markdown written for a model, versioned and reviewed like any other artifact, so a
// person can change how synthesis works without a release. They are seeded on first use with a
// published version 1, one pair per workspace; after that the workspace's own artifact is what the
// run reads, including a version a person edited.
//
// The technical specialist is the cheap, deterministic half: read the site's issues, weigh them by
// severity, how many indexable pages they touch and the traffic those pages earn, group the issues
// one change can fix, and propose candidates only of change types the mapping supports. The
// strategist is the deep half: detect the business type, merge and prune the candidates, dedupe
// against open recommendations, and write the final, falsifiable recommendations.

export const TECHNICAL_SKILL_TITLE = 'Technical specialist: prioritise issues into candidates';
export const STRATEGIST_SKILL_TITLE = 'Strategist: synthesise recommendations';

/** The agents row each specialist writes as; a person can pause it like any other agent. */
export const specialistAgentName = (name: SpecialistName): string => (name === 'technical' ? 'Technical specialist' : 'Strategist');

/** The specialist behind an agents row, by the name the platform created it with; null for any other agent. */
export const specialistOfAgentName = (agentName: string): SpecialistName | null =>
  agentName === specialistAgentName('strategist') ? 'strategist' : agentName === specialistAgentName('technical') ? 'technical' : null;

export type SpecialistName = 'technical' | 'strategist';

export interface SpecialistDefinition {
  name: SpecialistName;
  title: string;
  tags: string[];
  /** The default model tier: the technical pass is cheap, the synthesis is not. */
  tier: 'fast' | 'deep';
  instructions: string;
}

const technicalPlaybook = `# Technical specialist

You turn a site's deterministic audit findings into fix candidates. You are the cheap first pass of a
full audit; a strategist reads your candidates and writes the recommendations people see.

## What you are given
- The site: name, primary domain, business type when it is known.
- The audit you are working from: how many pages it crawled, its health score, and the categories it
  could not evaluate.
- Its open issues, worst first: id, check, severity, category, how many pages are affected out of how
  many were evaluated, Search Console clicks over 28 days for those pages (null without a connection),
  the check's fix change type when the catalogue has one, and up to three evidence samples.
- The change types this site's connector can apply, with "mapping" when a source file is mapped for it
  and "manual" when a person would have to edit by hand.

## How to choose
1. Weight by severity first, then by affected indexable pages, then by clicks. A critical issue on one
   page outranks a low issue on a hundred.
2. Group issues one change can fix. Twelve pages with the same missing title is one candidate, not
   twelve. Name every issue id in the group.
3. Prefer a group whose fix change type is supported. A group that needs a change type the site cannot
   apply yet may still be proposed, with no change types, but rank it lower and say so.
4. Drop an issue you cannot act on: no fix type, a generated page the mapping refuses, or a category
   the audit did not evaluate.
5. Never invent a number. Every count, page total and click figure in your rationale must come from
   the facts you were given. Do not mention a metric you were not given.

## Output
Return at most the requested number of candidates. For each: a one-line title, the issue ids it
covers, the change types it needs, a rationale in one or two sentences naming the affected pages and
clicks from the facts, an effort of small, medium or large, and the affected page URLs (at most 10).`;

const strategistPlaybook = `# Strategist

You are the orchestrator of a full audit. You receive the site, its facts, the candidates the
technical specialist proposed, and the recommendations that are already open for this site. You write
the recommendations a person will read, approve and later measure.

## Method: PERCEIVE → ANALYZE → VALIDATE → ACT
1. **PERCEIVE** the site for what it is. A SaaS, a local business, a publisher, an e-commerce store and
   an agency need different work from the same findings. Say which one you read it as, only if the
   facts support it.
2. **ANALYZE**. Merge candidates that share a cause. Keep the ones that matter for this business and
   this audit; drop the ones that do not. Deduplicate against the open recommendations: do not restate
   one that already exists.
3. **VALIDATE**. Every recommendation must rest on at least one evidence id from the facts, name a
   causal hypothesis, and be falsifiable. If you cannot say how it would fail, it is not ready.
4. **ACT**. Describe the changes it implies (proposedChanges), only of the change types the site can
   apply, and the verification a person or an agent will run afterwards.

## Rules that are checked mechanically
- Every evidence id must appear in the facts: issue ids, finding ids, the audit id, or a page URL that
  has Search Console data. An id you made up fails validation and the item is retried, then dropped.
- Every number in your rationale and in expectedImpact.summary must appear in the facts. Write
  "the 12 pages this issue affects" only when the facts say 12.
- Never use "boost", "skyrocket", "guarantee", "guaranteed" or "SEO juice". State an expectation, not a
  promise: "Expected: …", "We will know this failed if …".
- Do not state the traffic at stake: the platform computes it from the evidence pages.
- falsificationCheck starts with "We will know this failed if". leadingIndicator is the earliest daily
  signal that it is working.

## Output
Write at most the requested number of recommendations. Keep each rationale under 4,000 characters and
specific to this site.`;

export const specialistDefinitions: readonly SpecialistDefinition[] = [
  {
    name: 'technical',
    title: TECHNICAL_SKILL_TITLE,
    tags: ['recommendations', 'specialist', 'technical'],
    tier: 'fast',
    instructions: technicalPlaybook,
  },
  {
    name: 'strategist',
    title: STRATEGIST_SKILL_TITLE,
    tags: ['recommendations', 'specialist', 'strategist'],
    tier: 'deep',
    instructions: strategistPlaybook,
  },
];

export interface InstalledSpecialist {
  name: SpecialistName;
  artifactId: string;
  version: number;
  /** The published playbook, as the run reads it. */
  skill: Skill;
}

const definitionOf = (name: SpecialistName): SpecialistDefinition => {
  const found = specialistDefinitions.find((definition) => definition.name === name);
  if (!found) throw new Error(`${name} is not a recommendation specialist`);
  return found;
};

const contentOf = (definition: SpecialistDefinition): Skill =>
  artifactTypes.skill.content.parse({
    title: definition.title,
    instructions: definition.instructions,
    allowedTools: [],
    tags: definition.tags,
  });

/** The published content of an existing skill artifact, or null when it has none this run can read. */
async function publishedSkill(tx: Tx, artifactId: string, version: number): Promise<Skill | null> {
  const [row] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, artifactId), eq(schema.artifactVersions.number, version)));
  const parsed = artifactTypes.skill.content.safeParse(row?.content);
  return parsed.success ? parsed.data : null;
}

/**
 * Seeds the two specialist skills on first use and returns the published playbooks. Serialised per
 * workspace with an advisory lock, so two runs starting together cannot create two pairs; the second
 * one reads what the first wrote.
 *
 * A skill a person already published under the specialist's title is adopted, never overwritten. A
 * skill under that title with no published version is a person's unpublished draft: the run leaves
 * it alone and uses the platform's own seeded playbook (a separate artifact, titled "… (built in)")
 * instead, so nobody's draft is rewritten and the run still has instructions it is allowed to read.
 * Publishing the person's draft later makes the next run adopt it; the built-in one then stays as
 * an unused skill rather than being deleted under someone.
 */
export async function ensureSpecialists(tx: Tx, workspaceId: string, sponsorUserId: string): Promise<InstalledSpecialist[]> {
  // One lock for the pair, not one per skill: both are created in the same transaction.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`recommendation-specialists:${workspaceId}`}, 0))`);
  const installed: InstalledSpecialist[] = [];
  for (const definition of specialistDefinitions) {
    const content = contentOf(definition);
    const builtInTitle = builtInTitleOf(definition);
    // RLS scopes this to the workspace; the type and titles identify the pair we seed and the
    // artifact a person may have written in its place.
    const rows = await tx
      .select({
        id: schema.artifacts.id,
        name: schema.artifacts.name,
        latestVersion: schema.artifacts.latestVersion,
        publishedVersion: schema.artifacts.publishedVersion,
      })
      .from(schema.artifacts)
      .where(
        and(
          eq(schema.artifacts.type, 'skill'),
          eq(schema.artifacts.archived, false),
          inArray(schema.artifacts.name, [definition.title, builtInTitle]),
        ),
      );
    // The person's own published playbook wins over the built-in one.
    const own = rows.find((row) => row.name === definition.title && row.publishedVersion);
    const builtIn = rows.find((row) => row.name === builtInTitle);
    const adoptable = own ?? (builtIn?.publishedVersion ? builtIn : undefined);
    if (adoptable?.publishedVersion) {
      const published = await publishedSkill(tx, adoptable.id, adoptable.publishedVersion);
      if (published) {
        installed.push({ name: definition.name, artifactId: adoptable.id, version: adoptable.publishedVersion, skill: published });
        continue;
      }
    }
    // No readable published playbook: seed one on the built-in artifact (never on a person's draft).
    if (builtIn) {
      const number = builtIn.latestVersion + 1;
      await tx.insert(schema.artifactVersions).values({
        workspaceId,
        artifactId: builtIn.id,
        number,
        state: 'published',
        content,
        contentHash: hashValue(content),
        authorType: 'user',
        authorId: sponsorUserId,
        note: 'Seeded specialist playbook',
      });
      await tx
        .update(schema.artifacts)
        .set({ latestVersion: number, publishedVersion: number, updatedAt: new Date() })
        .where(eq(schema.artifacts.id, builtIn.id));
      installed.push({ name: definition.name, artifactId: builtIn.id, version: number, skill: content });
      continue;
    }
    const id = newId('skl');
    await tx.insert(schema.artifacts).values({ workspaceId, id, type: 'skill', name: builtInTitle, latestVersion: 1, publishedVersion: 1 });
    await tx.insert(schema.artifactVersions).values({
      workspaceId,
      artifactId: id,
      number: 1,
      state: 'published',
      content,
      contentHash: hashValue(content),
      authorType: 'user',
      authorId: sponsorUserId,
      note: 'Seeded specialist playbook',
    });
    installed.push({ name: definition.name, artifactId: id, version: 1, skill: content });
  }
  return installed;
}

/** The platform's own playbook artifact when a person's draft holds the plain title. */
export const builtInTitleOf = (definition: SpecialistDefinition): string => `${definition.title} (built in)`;

/** The default model tier a specialist's playbook asks for. */
export const tierOfSpecialist = (name: SpecialistName): 'fast' | 'deep' => definitionOf(name).tier;
