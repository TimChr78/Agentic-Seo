#!/usr/bin/env node
// Writes docs/architecture/check-catalogue.md from the code. Run it after changing a check:
//   node packages/checks/scripts/catalogue-md.mjs
// A test compares the committed file with this output, so a forgotten run fails the build.
import { writeFileSync } from 'node:fs';
import { tsImport } from 'tsx/esm/api';

const { renderCatalogueMarkdown } = await tsImport(new URL('../src/catalogue-doc.ts', import.meta.url).href, import.meta.url);
const target = new URL('../../../docs/architecture/check-catalogue.md', import.meta.url);
writeFileSync(target, renderCatalogueMarkdown());
console.log('Wrote docs/architecture/check-catalogue.md.');
