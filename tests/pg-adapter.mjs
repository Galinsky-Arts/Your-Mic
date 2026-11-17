// PostgreSQL adapter checks. The SQL translation tests always run; the database
// tests run with YM_TEST_DB=pg (see tests/harness.mjs for YM_TEST_PG_URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import {translateSql} from '../lib/d1-postgres.ts';

test('placeholders become numbered parameters outside quoted text', () => {
  assert.equal(translateSql('SELECT * FROM t WHERE a=? AND b=?'), 'SELECT * FROM t WHERE a=$1 AND b=$2');
  assert.equal(translateSql("SELECT '?' AS \"q?\", ? -- why?\n,?"), "SELECT '?' AS \"q?\", $1 -- why?\n,$2");
  assert.equal(translateSql("SELECT 'it''s ?', ?"), "SELECT 'it''s ?', $1");
});

test('D1 semantics on PostgreSQL', {skip: process.env.YM_TEST_DB !== 'pg' && 'set YM_TEST_DB=pg'}, async () => {
  const {createHarness} = await import('./harness.mjs');
  const h = await createHarness();
  try {
    const {DB, BUCKET} = h;
    await DB.prepare("INSERT INTO events(id,owner_id,title,artist,created_at) VALUES(?,?,?,?,?)").bind('e1', 'o', 'T', 'A', Date.now()).run();
    const row = await DB.prepare('SELECT created_at, version, position, owner_id IS NOT NULL AS "owned" FROM events WHERE id=?').bind('e1').first();
    assert.equal(typeof row.created_at, 'number'); assert.equal(row.owned, 1);
    assert.equal(await DB.prepare('SELECT title FROM events WHERE id=?').bind('e1').first('title'), 'T');
    assert.equal(await DB.prepare('SELECT * FROM events WHERE id=?').bind('missing').first(), null);
    // meta.changes drives every version/lease compare-and-swap.
    assert.equal((await DB.prepare('UPDATE events SET version=version+1 WHERE id=? AND version=?').bind('e1', 0).run()).meta.changes, 1);
    assert.equal((await DB.prepare('UPDATE events SET version=version+1 WHERE id=? AND version=?').bind('e1', 0).run()).meta.changes, 0);
    assert.equal((await DB.prepare('SELECT * FROM events').all()).meta.changes, 0);
    // Concurrent compare-and-swap: exactly one winner.
    const racers = await Promise.all(Array.from({length: 20}, () => DB.prepare('UPDATE events SET version=version+1 WHERE id=? AND version=?').bind('e1', 1).run()));
    assert.equal(racers.filter(r => r.meta.changes === 1).length, 1);
    // batch() is atomic: a failing statement rolls back the earlier ones.
    await assert.rejects(DB.batch([DB.prepare('UPDATE events SET title=? WHERE id=?').bind('changed', 'e1'), DB.prepare('INSERT INTO events(id) VALUES(?)').bind('bad')]));
    assert.equal(await DB.prepare('SELECT title FROM events WHERE id=?').bind('e1').first('title'), 'T');
    const results = await DB.batch([DB.prepare('UPDATE events SET title=? WHERE id=?').bind('B', 'e1'), DB.prepare('SELECT title FROM events WHERE id=?').bind('e1')]);
    assert.equal(results[0].meta.changes, 1); assert.equal(results[1].results[0].title, 'B');
    // ON CONFLICT DO NOTHING reports no change for a duplicate.
    const sub = () => DB.prepare('INSERT INTO subscribers(id,event_id,email,created_at,consent) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').bind(crypto.randomUUID(), 'e1', 'a@b.test', 1, 'yes').run();
    assert.equal((await sub()).meta.changes, 1); assert.equal((await sub()).meta.changes, 0);
    // Object storage: overwrite, head, suffix/offset ranges, delete, size cap.
    const bytes = new Uint8Array(1024 * 1024 + 300).map((_, i) => i % 251);
    await BUCKET.put('k', new Uint8Array(3));
    const put = await BUCKET.put('k', new Blob([bytes]).stream(), {httpMetadata: {contentType: 'audio/mpeg'}});
    assert.equal(put.size, bytes.length);
    const head = await BUCKET.head('k'); assert.equal(head.size, bytes.length); assert.equal(head.httpMetadata.contentType, 'audio/mpeg'); assert.match(head.httpEtag, /^"[0-9a-f]{32}"$/);
    assert.deepEqual(new Uint8Array(await (await BUCKET.get('k', {range: {offset: 1024 * 1024 - 5, length: 10}})).arrayBuffer()), bytes.subarray(1024 * 1024 - 5, 1024 * 1024 + 5));
    assert.deepEqual(new Uint8Array(await (await BUCKET.get('k', {range: {suffix: 7}})).arrayBuffer()), bytes.subarray(bytes.length - 7));
    assert.deepEqual(new Uint8Array(await (await BUCKET.get('k')).arrayBuffer()), bytes);
    await BUCKET.delete(['k']); assert.equal(await BUCKET.head('k'), null); assert.equal(await BUCKET.get('k'), null);
    const {PgBucket} = await import('../lib/pg-bucket.ts');
    const small = new PgBucket(BUCKET.pool, 10);
    await assert.rejects(small.put('big', new Uint8Array(11)), /size limit/); assert.equal(await BUCKET.head('big'), null);
  } finally {await h.dispose();}
});
