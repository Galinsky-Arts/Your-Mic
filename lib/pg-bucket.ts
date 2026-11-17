// R2-compatible object storage kept in PostgreSQL (Node/Render + Neon runtime).
// Objects are split into 1 MiB bytea chunks so a 75 MB song is never held in
// memory at once and Range requests read only the chunks they need.
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';

export const STORAGE_CHUNK_BYTES = 1024 * 1024;
export const STORAGE_MAX_OBJECT_BYTES = 75 * 1024 * 1024;

type Range = {offset?: number; length?: number; suffix?: number};
type PutValue = ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string | Blob | null;
type Row = {key: string; size: string | number; etag: string; content_type: string | null; uploaded_at: string | number};

export type PgObject = {
  key: string; size: number; etag: string; httpEtag: string; uploaded: Date; version: string;
  httpMetadata: {contentType?: string}; customMetadata: Record<string, string>;
  range?: {offset: number; length: number};
  writeHttpMetadata(headers: Headers): void;
};
export type PgObjectBody = PgObject & {body: ReadableStream<Uint8Array>; bodyUsed: boolean; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string>; json<T>(): Promise<T>; blob(): Promise<Blob>};

function describe(row: Row): PgObject {
  const contentType = row.content_type || undefined;
  return {
    key: row.key, size: Number(row.size), etag: row.etag, httpEtag: `"${row.etag}"`, uploaded: new Date(Number(row.uploaded_at)),
    version: row.etag, httpMetadata: contentType ? {contentType} : {}, customMetadata: {},
    writeHttpMetadata(headers) {if (contentType) headers.set('Content-Type', contentType);},
  };
}

async function* chunksOf(value: PutValue): AsyncGenerator<Uint8Array> {
  if (value === null) return;
  if (typeof value === 'string') {yield new TextEncoder().encode(value); return;}
  if (value instanceof ArrayBuffer) {yield new Uint8Array(value); return;}
  if (ArrayBuffer.isView(value)) {yield new Uint8Array(value.buffer, value.byteOffset, value.byteLength); return;}
  const stream = value instanceof Blob ? value.stream() : value;
  const reader = stream.getReader();
  try {
    for (;;) {
      const {done, value: chunk} = await reader.read();
      if (done) return;
      yield chunk;
    }
  } finally {reader.releaseLock();}
}

export class PgBucket {
  readonly pool: Pool;
  readonly maxObjectBytes: number;
  constructor(pool: Pool, maxObjectBytes = STORAGE_MAX_OBJECT_BYTES) {this.pool = pool; this.maxObjectBytes = maxObjectBytes;}

  async head(key: string) {
    const {rows} = await this.pool.query<Row>('SELECT key,size,etag,content_type,uploaded_at FROM storage_objects WHERE key=$1', [key]);
    return rows[0] ? describe(rows[0]) : null;
  }

  async get(key: string, options?: {range?: Range}): Promise<PgObjectBody | null> {
    const object = await this.head(key);
    if (!object) return null;
    let offset = 0, length = object.size;
    const range = options?.range;
    if (range) {
      if (range.suffix !== undefined) {length = Math.min(range.suffix, object.size); offset = object.size - length;}
      else {offset = Math.min(range.offset ?? 0, object.size); length = Math.min(range.length ?? object.size - offset, object.size - offset);}
    }
    const pool = this.pool, end = offset + length;
    let position = offset;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (position >= end) {controller.close(); return;}
        const idx = Math.floor(position / STORAGE_CHUNK_BYTES);
        const within = position - idx * STORAGE_CHUNK_BYTES;
        const take = Math.min(STORAGE_CHUNK_BYTES - within, end - position);
        const {rows} = await pool.query<{data: Buffer}>('SELECT substring(data FROM $3 FOR $4) AS data FROM storage_chunks WHERE key=$1 AND idx=$2', [key, idx, within + 1, take]);
        if (!rows[0] || rows[0].data.byteLength !== take) {controller.error(new Error('Stored object is incomplete')); return;}
        position += take;
        controller.enqueue(new Uint8Array(rows[0].data));
      },
    });
    let used = false;
    const read = async () => {used = true; return new Response(body).arrayBuffer();};
    return {
      ...object, ...(range ? {range: {offset, length}} : {}), body,
      get bodyUsed() {return used;},
      arrayBuffer: read,
      text: async () => new TextDecoder().decode(await read()),
      json: async <T>() => JSON.parse(new TextDecoder().decode(await read())) as T,
      blob: async () => new Blob([await read()], object.httpMetadata.contentType ? {type: object.httpMetadata.contentType} : {}),
    };
  }

  async put(key: string, value: PutValue, options: {httpMetadata?: {contentType?: string} | Headers} = {}) {
    const contentType = options.httpMetadata instanceof Headers ? options.httpMetadata.get('content-type') : options.httpMetadata?.contentType;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM storage_objects WHERE key=$1', [key]);
      await client.query("INSERT INTO storage_objects(key,size,etag,content_type,uploaded_at) VALUES($1,0,'',$2,$3)", [key, contentType ?? null, Date.now()]);
      const md5 = createHash('md5');
      let size = 0, idx = 0, pending: Buffer[] = [], pendingBytes = 0;
      const flush = async (all: boolean) => {
        while (pendingBytes >= STORAGE_CHUNK_BYTES || (all && pendingBytes > 0)) {
          const joined = Buffer.concat(pending, pendingBytes);
          const piece = joined.subarray(0, Math.min(STORAGE_CHUNK_BYTES, joined.byteLength));
          await client.query('INSERT INTO storage_chunks(key,idx,data) VALUES($1,$2,$3)', [key, idx++, piece]);
          const rest = joined.subarray(piece.byteLength);
          pending = rest.byteLength ? [Buffer.from(rest)] : []; pendingBytes = rest.byteLength;
        }
      };
      for await (const chunk of chunksOf(value)) {
        size += chunk.byteLength;
        if (size > this.maxObjectBytes) throw Object.assign(new Error('Object exceeds the storage size limit'), {status: 413});
        md5.update(chunk);
        pending.push(Buffer.from(chunk)); pendingBytes += chunk.byteLength;
        if (pendingBytes >= STORAGE_CHUNK_BYTES) await flush(false);
      }
      await flush(true);
      const etag = md5.digest('hex');
      const {rows} = await client.query<Row>('UPDATE storage_objects SET size=$2,etag=$3 WHERE key=$1 RETURNING key,size,etag,content_type,uploaded_at', [key, size, etag]);
      await client.query('COMMIT');
      return describe(rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {client.release();}
  }

  async delete(keys: string | string[]) {
    const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
    if (list.length) await this.pool.query('DELETE FROM storage_objects WHERE key = ANY($1::text[])', [list]);
  }
}
