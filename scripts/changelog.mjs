#!/usr/bin/env node
// Changelog fragments: every pull request that changes behaviour adds changelog.d/<slug>.md
// (one or more Markdown bullet lines). `check` validates the fragments; the release script will
// fold them into CHANGELOG.md. Tasks never edit CHANGELOG.md directly.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../changelog.d/', import.meta.url).pathname;
const cmd = process.argv[2];
if (cmd !== 'check') {
  console.error('usage: node scripts/changelog.mjs check');
  process.exit(2);
}
let bad = 0;
for (const name of readdirSync(dir)) {
  if (name === 'README.md') continue;
  if (!/^[a-z0-9][a-z0-9-]*\.md$/.test(name)) {
    console.error(`changelog.d/${name}: name must be kebab-case .md`);
    bad++;
    continue;
  }
  const lines = readFileSync(join(dir, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  if (lines.length === 0 || !lines.every((l) => /^(- | {2})/.test(l))) {
    console.error(`changelog.d/${name}: must contain Markdown bullet lines ("- …")`);
    bad++;
  }
}
process.exit(bad ? 1 : 0);
