// A small D1-compatible facade over node-postgres, used only by the Node
// (Render + Neon) runtime. The application keeps one SQL dialect that both
// SQLite/D1 and PostgreSQL accept; this adapter supplies the D1 call shape
// (prepare/bind/first/all/run/batch) and D1's write semantics:
//   - `?` placeholders become `$1..$n` (quoted text is left alone),
//   - `meta.changes` is the affected-row count of INSERT/UPDATE/DELETE, which the
//     version/lease compare-and-swap checks rely on,
//   - `batch()` runs as one transaction (all statements commit or none do),
//   - writes are serialized with a transaction advisory lock, matching D1's
//     single-writer model so NOT EXISTS / COUNT guards cannot race.
import type {Pool, PoolClient, QueryResult} from 'pg';

type Queryable = Pick<PoolClient, 'query'>;
type Meta = {changes: number; last_row_id: number; rows_read: number; rows_written: number; duration: number; changed_db: boolean; size_after: number};
export type D1LikeResult<T = Record<string, unknown>> = {success: true; results: T[]; meta: Meta};

// Arbitrary constant key for the single-writer advisory lock.
const WRITE_LOCK = 0x59_4d_31; // "YM1"

export function translateSql(sql: string) {
  let out = '', n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {j++; continue;}
          break;
        }
      }
      out += sql.slice(i, j + 1); i = j; continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop); i = stop - 1; continue;
    }
    out += c === '?' ? '$' + (++n) : c;
  }
  return out;
}

function value(v: unknown) {
  if (v === undefined) throw new TypeError('D1_TYPE_ERROR: Type \'undefined\' not supported for value \'undefined\'');
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return v;
}

const isWrite = (sql: string) => !/^\s*(SELECT|WITH|VALUES|EXPLAIN|SHOW)\b/i.test(sql);

function result<T>(r: QueryResult, started: number): D1LikeResult<T> {
  const write = r.command === 'INSERT' || r.command === 'UPDATE' || r.command === 'DELETE';
  const changes = write ? r.rowCount ?? 0 : 0;
  return {success: true, results: (r.rows ?? []) as T[], meta: {changes, last_row_id: 0, rows_read: write ? 0 : r.rowCount ?? 0, rows_written: changes, duration: Date.now() - started, changed_db: changes > 0, size_after: 0}};
}

export class PgD1PreparedStatement {
  private readonly db: PgD1Database;
  readonly sql: string;
  readonly params: unknown[];
  constructor(db: PgD1Database, sql: string, params: unknown[] = []) {this.db = db; this.sql = sql; this.params = params;}
  bind(...values: unknown[]) {return new PgD1PreparedStatement(this.db, this.sql, values.map(value));}
  async run<T = Record<string, unknown>>() {return this.db.execute<T>(this);}
  async all<T = Record<string, unknown>>() {return this.db.execute<T>(this);}
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = (await this.db.execute<Record<string, unknown>>(this)).results[0];
    if (!row) return null;
    return (column ? row[column] ?? null : row) as T;
  }
  async raw<T = unknown[]>() {
    return (await this.db.execute<Record<string, unknown>>(this)).results.map(row => Object.values(row)) as T[];
  }
}

export class PgD1Database {
  readonly pool: Pool;
  constructor(pool: Pool) {this.pool = pool;}
  prepare(sql: string) {return new PgD1PreparedStatement(this, sql);}

  async query<T>(client: Queryable, statement: PgD1PreparedStatement) {
    const started = Date.now();
    return result<T>(await client.query(translateSql(statement.sql), statement.params), started);
  }

  async execute<T>(statement: PgD1PreparedStatement): Promise<D1LikeResult<T>> {
    if (!isWrite(statement.sql)) return this.query<T>(this.pool, statement);
    return (await this.transaction(client => this.query<T>(client, statement)));
  }

  async batch<T = Record<string, unknown>>(statements: PgD1PreparedStatement[]) {
    return this.transaction(async client => {
      const results: D1LikeResult<T>[] = [];
      for (const statement of statements) results.push(await this.query<T>(client, statement));
      return results;
    });
  }

  async exec(sql: string) {
    const started = Date.now();
    await this.pool.query(sql);
    return {count: 1, duration: Date.now() - started};
  }

  async transaction<R>(work: (client: PoolClient) => Promise<R>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
      const out = await work(client);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {client.release();}
  }
}
