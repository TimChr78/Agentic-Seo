// One source of truth for the e2e server's addresses: the Playwright config, the helpers and the
// server entry all import this module, so TEST_PORT_OFFSET moves the API, the readiness port and
// every default URL together. E2E_PORT still wins when a caller names a port explicitly, and
// E2E_BASE names an already-running server instead of the one Playwright starts.

export interface E2EPorts {
  /** The server's port (the API and the built UI). */
  port: number;
  /** Where the browser and Playwright point, e.g. http://localhost:3100. */
  base: string;
  /** The test-only readiness port, always the next port. */
  readinessPort: number;
  /** Readiness origin; E2E_READY_BASE overrides it for a server started elsewhere. */
  readinessBase: string;
}

export function portsFor(env: Record<string, string | undefined> = process.env): E2EPorts {
  const baseUrl = env.E2E_BASE ? new URL(env.E2E_BASE) : null;
  // URL drops a scheme's default port ("https://x:443".port === ''), so fall back by scheme.
  const basePort = baseUrl ? Number(baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80)) : null;
  const offset = Number(env.TEST_PORT_OFFSET ?? 0) || 0;
  const port = Number(env.E2E_PORT ?? basePort ?? 3100 + offset);
  const readinessPort = port + 1;
  return {
    port,
    base: env.E2E_BASE ?? `http://localhost:${port}`,
    readinessPort,
    readinessBase: env.E2E_READY_BASE ?? `http://127.0.0.1:${readinessPort}`,
  };
}

export const { port: e2ePort, base: e2eBase, readinessPort: e2eReadinessPort, readinessBase: e2eReadinessBase } = portsFor();
