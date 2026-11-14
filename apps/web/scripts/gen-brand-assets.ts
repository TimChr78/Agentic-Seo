import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_ACCENT, BRAND_INK, BRAND_NAME, brandMarkSvg, brandWordmarkSvg } from '../../../packages/core/src/brand';

// Generates the product assets in apps/web/public from the single geometry source in
// packages/core/src/brand.ts. Run after changing the mark:
//
//   corepack pnpm --filter @agentic-seo/web gen:brand
//
// Only SVG is generated: the browser scales the mark and favicon without a raster step, so this
// script needs no image library. The output is committed; nothing is generated at runtime.

const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = join(root, 'public');
const brandDir = join(publicDir, 'brand');

const socialPreviewSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640" role="img">
  <title>${BRAND_NAME}: search operations, with people in control</title>
  <rect width="1280" height="640" fill="#f7f6f2"/>
  <rect x="0" y="0" width="1280" height="8" fill="${BRAND_ACCENT}"/>
  <g transform="translate(400 150) scale(7.5)"><rect width="64" height="64" rx="14" fill="${BRAND_ACCENT}"/>
    <path d="M39 28A11 11 0 1 1 17 28A11 11 0 1 1 39 28Z" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M36 36 46 46" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/></g>
  <text x="640" y="430" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-size="96" font-weight="600" letter-spacing="-2" fill="${BRAND_INK}">${BRAND_NAME}</text>
  <text x="640" y="494" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-size="30" fill="#606860">Search operations, with people in control</text>
</svg>`;

async function main() {
  await mkdir(brandDir, { recursive: true });

  const svgs: Record<string, string> = {
    'brand/mark.svg': brandMarkSvg({ title: BRAND_NAME }),
    'brand/mark-wordmark.svg': brandWordmarkSvg({ title: BRAND_NAME }),
    'brand/mark-mono-light.svg': brandMarkSvg({ tone: 'mono-light', title: BRAND_NAME }),
    'brand/mark-mono-dark.svg': brandMarkSvg({ tone: 'mono-dark', title: BRAND_NAME }),
    'brand/mark-wordmark-mono-light.svg': brandWordmarkSvg({ tone: 'mono-light', title: BRAND_NAME }),
    'brand/mark-wordmark-mono-dark.svg': brandWordmarkSvg({ tone: 'mono-dark', title: BRAND_NAME }),
    'favicon.svg': brandMarkSvg({ tone: 'color', title: BRAND_NAME }),
    'brand/social-preview.svg': socialPreviewSvg,
  };
  await Promise.all(Object.entries(svgs).map(([name, svg]) => writeFile(join(publicDir, name), `${svg}\n`)));

  const manifest = {
    name: BRAND_NAME,
    short_name: 'Agentic SEO',
    description: 'Open-source, agent-first search operations with people in control.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f7f6f2',
    theme_color: '#f7f6f2',
    icons: [{ src: '/brand/mark.svg', sizes: 'any', type: 'image/svg+xml' }],
  };
  await writeFile(join(publicDir, 'site.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Wrote brand assets to ${publicDir}`);
}

void main();
