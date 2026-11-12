import { describe, expect, it } from 'vitest';
import { autonomySettings, decide, estimateImpact, type MandateView, type PolicyInput, UNKNOWN_REACH } from '../src/policy';

const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  command: 'changes.requestApply',
  actionClass: 'site.content',
  impact: {},
  settings: autonomySettings({}),
  counters: { changes: 0 },
  approvable: true,
  ...over,
});

describe('autonomy settings', () => {
  it('default to a person in charge: level 1, switch on, no loops', () => {
    const s = autonomySettings({});
    expect(s).toMatchObject({ switch: 'on', allowLoops: false, maxLevel: {} });
    expect(s.limits).toEqual({ changesPerDay: 500 });
  });

  it('fall back to the defaults when the stored value is unreadable', () => {
    expect(autonomySettings({ switch: 'sometimes' }).switch).toBe('on');
    expect(autonomySettings(null).maxLevel).toEqual({});
  });
});

describe('the SEO reach hook', () => {
  it('returns unknown until page-level search data exists', async () => {
    expect(await estimateImpact({ command: 'changes.requestApply', actionClass: 'site.content' })).toEqual({ reach: UNKNOWN_REACH });
    expect(UNKNOWN_REACH.kind).toBe('unknown');
  });
});

describe('the policy engine', () => {
  it('allows reads and drafts', () => {
    expect(decide(base({ actionClass: 'read' })).decision).toBe('allow');
    expect(decide(base({ actionClass: 'draft' })).decision).toBe('allow');
  });

  it('leaves an agent without a mandate to the approval policy when nothing is exceeded', () => {
    expect(decide(base()).decision).toBe('allow');
    expect(decide(base({ actionClass: 'crawl' })).decision).toBe('allow');
  });

  it('refuses what cannot wait for an approval, with the reason and a way out', () => {
    const out = decide(
      base({ command: 'audits.run', actionClass: 'crawl', approvable: false, settings: autonomySettings({ switch: 'propose_only' }) }),
    );
    expect(out.decision).toBe('deny');
    expect(out.reasons.at(-1)).toContain('audits.run cannot wait for an approval');
  });

  it('enforces the daily change limit', () => {
    const settings = autonomySettings({ limits: { changesPerDay: 10 } });
    expect(decide(base({ settings, counters: { changes: 9 } })).decision).toBe('allow');
    expect(decide(base({ settings, counters: { changes: 10 } })).decision).toBe('ask');
  });

  it('propose-only lets agents draft but sends every other change to a person', () => {
    const settings = autonomySettings({ switch: 'propose_only' });
    expect(decide(base({ settings, actionClass: 'draft' })).decision).toBe('allow');
    expect(decide(base({ settings })).decision).toBe('ask');
    expect(decide(base({ settings, command: 'audits.run', actionClass: 'crawl', approvable: false })).decision).toBe('deny');
  });

  it('off leaves agents read-only', () => {
    const settings = autonomySettings({ switch: 'off' });
    expect(decide(base({ settings, actionClass: 'read' })).decision).toBe('allow');
    expect(decide(base({ settings, actionClass: 'draft' })).decision).toBe('deny');
    expect(decide(base({ settings })).decision).toBe('deny');
  });
});

describe('the policy engine with a mandate (Phase 7 structure)', () => {
  const mandate = (over: Partial<MandateView> = {}): MandateView => ({
    id: 'mnd_1',
    version: 1,
    levels: { 'site.content': 3 },
    holdWindow: 'PT2H',
    purpose: 'Fix meta titles on product pages',
    ...over,
  });
  const settings = autonomySettings({ maxLevel: { 'site.content': 3 } });
  const change = (over: Partial<PolicyInput> = {}) =>
    decide(
      base({
        settings,
        mandate: mandate(),
        impact: { reach: { kind: 'known', affectedUrls: 10, clicksAtRisk: 120, criticalPages: [] } },
        ...over,
      }),
    );

  it('level 3 inside the workspace ceiling runs autonomously', () => {
    expect(change()).toMatchObject({ decision: 'allow', autonomous: true, level: 3, mandate: { id: 'mnd_1', version: 1 } });
  });

  it('is capped by the workspace ceiling, whose default is a person', () => {
    expect(change({ settings: autonomySettings({}) })).toMatchObject({ decision: 'ask', level: 1 });
  });

  it('level 2 holds for the veto window', () => {
    const out = change({ mandate: mandate({ levels: { 'site.content': 2 } }) });
    expect(out).toMatchObject({ decision: 'hold', level: 2 });
    expect(out.reasons[0]).toContain('PT2H');
  });

  it('level 1 asks, and a non-approvable action at level 2 is refused rather than held', () => {
    expect(change({ mandate: mandate({ levels: { 'site.content': 1 } }) })).toMatchObject({ decision: 'ask', level: 1 });
    const out = change({ actionClass: 'index.submit', approvable: false, mandate: mandate({ levels: { 'index.submit': 2 } }) });
    expect(out.decision).toBe('deny');
  });

  it('unknown reach always requires a person, never a silent one-level drop', () => {
    const out = change({ impact: { reach: UNKNOWN_REACH } });
    expect(out).toMatchObject({ decision: 'ask', level: 1 });
    expect(out.reasons.join(' ')).toContain('needs a person');
  });

  it('never makes settings or destructive changes autonomous, and refuses at level 0', () => {
    expect(change({ actionClass: 'settings', mandate: mandate({ levels: { settings: 3 } }) }).decision).toBe('ask');
    expect(change({ impact: { needsPerson: 'Connections always need a person.' } }).decision).toBe('ask');
    expect(change({ mandate: mandate({ levels: { 'site.content': 0 } }) })).toMatchObject({ decision: 'deny', level: 0 });
  });

  it('without allowLoops, a granted level 4 is capped at 3', () => {
    const four = autonomySettings({ maxLevel: { 'site.content': 4 } });
    expect(change({ settings: four, mandate: mandate({ levels: { 'site.content': 4 } }) })).toMatchObject({
      decision: 'allow',
      level: 3,
      autonomous: true,
    });
  });
});
