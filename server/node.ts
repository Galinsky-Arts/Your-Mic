// Node HTTP entry for Render (or any Node host) with PostgreSQL (Neon).
// Mirrors worker/standalone.ts: sign-in, /api and /healthz go through
// standaloneFetch; every other request is served by the vinext production
// handler built by `pnpm build:node`. Externally supplied `oai-*` identity
// headers are removed from every request before either path sees it.
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {ReadableStream as NodeReadableStream} from 'node:stream/web';
import {startProdServer} from 'vinext/server/prod-server';
import {standaloneFetch} from '../lib/standalone';
import {closePool, env, migrate} from '../lib/node-runtime';

type Listener = (req: IncomingMessage, res: ServerResponse) => void;
const STANDALONE_PATHS = new Set(['/healthz', '/artist/sign-in', '/artist/sign-out', '/signin-with-chatgpt', '/signout-with-chatgpt']);

function toRequest(req: IncomingMessage) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : 'http';
  const url = new URL(req.url || '/', `${proto}://${req.headers.host || 'localhost'}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(':')) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  // The login rate limit keys on the client address. Render's proxy supplies
  // X-Forwarded-For; a client cannot set cf-connecting-ip directly here.
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  headers.set('cf-connecting-ip', ip);
  const method = req.method || 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
  return new Request(url, {method, headers, body, duplex: 'half'} as RequestInit);
}

async function send(req: IncomingMessage, res: ServerResponse, response: Response) {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {if (name !== 'set-cookie') headers[name] = value;});
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body || req.method === 'HEAD') {res.end(); await response.body?.cancel(); return;}
  await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), res);
}

export async function startNodeServer({port = Number(process.env.PORT) || 3000, host = process.env.HOST || '0.0.0.0', outDir = path.resolve(process.env.YOUR_MIC_DIST || 'dist')} = {}) {
  if (process.env.YOUR_MIC_MIGRATE !== '0') {
    const applied = await migrate();
    if (applied.length) console.log(`Applied PostgreSQL migrations: ${applied.join(', ')}`);
  }
  // Start vinext on a private loopback port only to obtain its request handler,
  // then serve that handler from our own public server. Nothing reaches the
  // framework without the header sanitization below.
  const internal = await startProdServer({port: 0, host: '127.0.0.1', outDir, silent: true});
  const [framework] = internal.server.listeners('request') as Listener[];
  await new Promise<void>(resolve => internal.server.close(() => resolve()));
  if (!framework) throw new Error('The vinext production handler is unavailable. Run `pnpm build:node` first.');

  const server = createServer((req, res) => {
    for (const name of Object.keys(req.headers)) if (name.toLowerCase().startsWith('oai-')) delete req.headers[name];
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (!STANDALONE_PATHS.has(pathname) && !pathname.startsWith('/api/')) return framework(req, res);
    standaloneFetch(toRequest(req), env, async () => new Response('Not found', {status: 404}))
      .then(response => send(req, res, response))
      .catch(error => {
        console.error('Your Mic request failed', error);
        if (!res.headersSent) {res.writeHead(500, {'Content-Type': 'text/plain'}); res.end('Internal Server Error');}
        else res.destroy();
      });
  });
  server.requestTimeout = 0; // 75 MB uploads on slow venue Wi-Fi must not be cut off.
  await new Promise<void>(resolve => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Your Mic (Node runtime) listening on http://${host}:${actualPort}`);
  const stop = () => server.close(() => {closePool().finally(() => process.exit(0));});
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return {server, port: actualPort};
}

if (process.env.YOUR_MIC_NO_AUTOSTART !== '1') {
  startNodeServer().catch(error => {console.error(error); process.exit(1);});
}
