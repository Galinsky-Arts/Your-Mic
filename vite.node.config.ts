import path from 'node:path';
import vinext from 'vinext';
import {defineConfig} from 'vite';

// Node hosting (Render + Neon). The app code imports `cloudflare:workers`; here
// that module is the Node runtime: PostgreSQL behind a D1-compatible adapter and
// object storage in PostgreSQL. Cloudflare builds use vite.cloudflare.config.ts.
export default defineConfig({
  resolve: {alias: {'cloudflare:workers': path.resolve(import.meta.dirname, 'lib/node-runtime.ts')}},
  plugins: [vinext()],
});
