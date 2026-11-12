import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// The web tests share the host with the package suite, and under that load a lazy chunk or a
// chained read can take longer than Testing Library's one-second default. The waits still end as
// soon as their condition holds; only a genuinely stuck UI waits the full five seconds.
configure({ asyncUtilTimeout: 5_000 });

// jsdom has no matchMedia (theme.ts reads it at module load) and no scrolling.
if (!window.matchMedia)
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
window.scrollTo = () => {};

// Vitest runs without globals, so Testing Library cannot register its own cleanup. Unmount after
// every test here, once: a test file that forgets would otherwise leave timers (the skeleton reveal)
// firing after the environment is torn down.
afterEach(cleanup);
