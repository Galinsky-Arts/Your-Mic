// Node runtime (Render + Neon). Node builds alias `cloudflare:workers` to this
// module, so application code keeps reading `env.DB`, `env.BUCKET` and its
// secrets exactly as on Cloudflare. The Cloudflare build never imports it.
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {PgD1Database} from './d1-postgres';
import {PgBucket} from './pg-bucket';

// SQLite/D1 returns JavaScript numbers for integers and 1/0 for booleans.
pg.types.setTypeParser(pg.types.builtins.INT8, v => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, v => Number(v));
pg.types.setTypeParser(pg.types.builtins.BOOL, v => (v === 't' ? 1 : 0) as unknown as boolean);

// Workers provide FixedLengthStream; Node needs an equivalent length check.
class FixedLengthStreamPolyfill extends TransformStream<Uint8Array, Uint8Array> {
  constructor(expected: number | bigint) {
    const limit = Number(expected);
    let seen = 0;
    super({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) throw new Error('The upload is larger than its declared size.');
        controller.enqueue(chunk);
      },
      flush() {if (seen !== limit) throw new Error('The upload ended before its declared size.');},
    });
  }
}
const globals = globalThis as Record<string, unknown>;
if (!('FixedLengthStream' in globals)) globals.FixedLengthStream = FixedLengthStreamPolyfill;

let pool: pg.Pool | undefined, db: PgD1Database | undefined, bucket: PgBucket | undefined;

export function pgPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) return undefined;
    pool = new pg.Pool({connectionString, max: Number(process.env.PG_POOL_MAX) || 8, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000});
    pool.on('error', error => console.error('Your Mic database pool error', error.message));
  }
  return pool;
}

export async function closePool() {
  const current = pool;
  pool = undefined; db = undefined; bucket = undefined;
  await current?.end();
}

const read = (name: string) => process.env[name] || undefined;

export const env = {
  get DB() {const p = pgPool(); return p ? (db ??= new PgD1Database(p)) : undefined;},
  get BUCKET() {const p = pgPool(); return p ? (bucket ??= new PgBucket(p)) : undefined;},
  get DEEPGRAM_API_KEY() {return read('DEEPGRAM_API_KEY');},
  get MC_CLOUDFLARE_ACCOUNT_ID() {return read('MC_CLOUDFLARE_ACCOUNT_ID');},
  get MC_CLOUDFLARE_API_TOKEN() {return read('MC_CLOUDFLARE_API_TOKEN');},
  get ARTIST_PASSWORD() {return read('ARTIST_PASSWORD');},
  get SESSION_SECRET() {return read('SESSION_SECRET');},
  AI: undefined,
} as unknown as Cloudflare.Env;

// Applies drizzle-postgres/*.sql once each, in name order, all-or-nothing,
// under an advisory lock so concurrent instances cannot race.
export async function migrate(directory = process.env.YOUR_MIC_PG_MIGRATIONS || path.resolve(process.cwd(), 'drizzle-postgres')) {
  const p = pgPool();
  if (!p) throw new Error('DATABASE_URL is not set.');
  const client = await p.connect();
  const applied: string[] = [];
  let current = '';
  // One transaction with a transaction-scoped lock, so this is also safe
  // through a transaction-mode pooler such as Neon's pooled endpoint.
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7514163)');
    await client.query('CREATE TABLE IF NOT EXISTS your_mic_migrations (name text PRIMARY KEY, applied_at bigint NOT NULL)');
    const done = new Set((await client.query<{name: string}>('SELECT name FROM your_mic_migrations')).rows.map(r => r.name));
    for (const name of (await readdir(directory)).filter(n => n.endsWith('.sql')).sort()) {
      if (done.has(name)) continue;
      current = name;
      await client.query(await readFile(path.join(directory, name), 'utf8'));
      await client.query('INSERT INTO your_mic_migrations(name,applied_at) VALUES($1,$2)', [name, Date.now()]);
      applied.push(name);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(`PostgreSQL migration ${current || '(setup)'} failed; nothing was applied: ${(error as Error).message}`);
  } finally {client.release();}
  return applied;
}
