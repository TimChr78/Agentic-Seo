#!/usr/bin/env node
// Warns about freshness rules that have not been reviewed for six months. Not wired into CI yet;
// run it before a release or when touching a check that depends on a Google change:
//   node packages/checks/scripts/stale-rules.mjs
import { tsImport } from 'tsx/esm/api';

const { freshnessRules } = await tsImport(new URL('../src/rules.ts', import.meta.url).href, import.meta.url);

const cutoff = new Date();
cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
let stale = 0;
for (const rule of freshnessRules) {
  const reviewed = new Date(`${rule.reviewedAt}T00:00:00Z`);
  if (reviewed < cutoff) {
    stale++;
    console.warn(`warning: rule "${rule.id}" was last reviewed on ${rule.reviewedAt}. Check it again at ${rule.source}`);
  }
}
if (stale === 0) console.log(`All ${freshnessRules.length} freshness rules were reviewed within the last six months.`);
