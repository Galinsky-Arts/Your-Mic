// Node hosting build (Render + Neon): the vinext app into dist/ (using
// vite.node.config.ts) and the Node HTTP entry into dist-node/server.mjs.
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {build} from 'vite';

const vite = path.resolve('node_modules/vite/bin/vite.js');
const app = spawnSync(process.execPath, [vite, 'build', '--config', 'vite.node.config.ts'], {stdio: 'inherit'});
if (app.status !== 0) process.exit(app.status ?? 1);

await build({
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  resolve: {alias: {'cloudflare:workers': path.resolve('lib/node-runtime.ts')}},
  build: {
    ssr: path.resolve('server/node.ts'), outDir: 'dist-node', emptyOutDir: true, target: 'node22', minify: false,
    rollupOptions: {output: {entryFileNames: 'server.mjs', format: 'es'}},
  },
});
console.log('Node build complete. Start with `pnpm start:node` (needs DATABASE_URL).');
