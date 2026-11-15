import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderCatalogueMarkdown } from '../src/catalogue-doc';

// The catalogue document is generated, so it cannot describe a check that no longer exists or miss
// one that does. Regenerate with `node packages/checks/scripts/catalogue-md.mjs`.

describe('the catalogue document', () => {
  it('matches the committed docs/architecture/check-catalogue.md', () => {
    const committed = readFileSync(new URL('../../../docs/architecture/check-catalogue.md', import.meta.url), 'utf8');
    expect(committed).toBe(renderCatalogueMarkdown());
  });
});
