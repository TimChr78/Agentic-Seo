import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The admin UI is served from the API server in production, so its requests (/api and /mcp) share
// the origin and the session cookie. `pnpm dev` proxies them to the local server.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: Object.fromEntries(['/api', '/mcp', '/openapi.json'].map((p) => [p, process.env.API_URL ?? 'http://localhost:3000'])),
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 6000,
    manifest: true,
  },
});
