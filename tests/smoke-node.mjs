// Run after `pnpm build:node`. Starts the real Node server (dist-node/server.mjs)
// against a throwaway PostgreSQL database and exercises it over HTTP.
// YM_TEST_PG_URL selects the admin connection (default postgres://postgres@127.0.0.1:5432/postgres).
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
const pg=createRequire(import.meta.url)('pg');
const admin=process.env.YM_TEST_PG_URL||'postgres://postgres@127.0.0.1:5432/postgres';
const name='ym_smoke_'+randomBytes(6).toString('hex'),url=new URL(admin);url.pathname='/'+name;
const sql=async q=>{const c=new pg.Client({connectionString:admin});await c.connect();try{await c.query(q);}finally{await c.end();}};
await sql(`CREATE DATABASE ${name}`);
const password=randomBytes(24).toString('hex'),port=20000+Math.floor(Math.random()*20000),origin=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['dist-node/server.mjs'],{env:{...process.env,DATABASE_URL:url.href,PORT:String(port),HOST:'127.0.0.1',ARTIST_PASSWORD:password,SESSION_SECRET:randomBytes(32).toString('hex'),DEEPGRAM_API_KEY:''},stdio:['ignore','inherit','inherit']});
try{
 const get=(path,options={})=>fetch(origin+path,{redirect:'manual',...options});
 for(let i=0;;i++){try{if((await get('/healthz')).status===200)break;}catch{}if(i>100)throw new Error('Node server did not become healthy');await sleep(200);}
 const home=await get('/');assert.equal(home.status,200);const html=await home.text();assert.match(html,/Your Mic/);
 const assets=[...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(m=>m[1]).filter(s=>s.startsWith('/'));
 assert(assets.length>0,'Production HTML must reference client assets');for(const asset of assets){const r=await get(asset);assert.equal(r.status,200,asset);await r.arrayBuffer();}
 const admin=await get('/admin');assert.equal(admin.status,200);await admin.text();
 const signin=await get('/artist/sign-in');assert.equal(signin.status,200);assert.match(await signin.text(),/Artist password/);
 const form=value=>({method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password:value}).toString()});
 assert.equal((await get('/artist/sign-in',form('wrong-password'))).status,401);
 const login=await get('/artist/sign-in',form(password));assert.equal(login.status,303);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 assert.equal((await get('/api/events',{method:'POST',headers:{'oai-authenticated-user-id':'standalone-artist',Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({title:'Forged',artist:'X'})})).status,401);
 assert.notEqual((await get('/%61pi/mine',{headers:{'oai-authenticated-user-id':'standalone-artist'}})).status,200,'Encoded API paths must not accept forged identity');
 const created=await get('/api/events',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({title:'Node event',artist:'Artist'})});assert.equal(created.status,201);
 const {id}=await created.json();
 // A 2.5 MiB upload spans three storage chunks; ranges must cross chunk boundaries.
 const audio=new Uint8Array(2.5*1024*1024);for(let i=0;i<audio.length;i++)audio[i]=(i*7)&255;
 const up=await get(`/api/events/${id}/tracks?filename=song.mp3&title=Song&duration=3`,{method:'POST',headers:{Cookie:cookie,Origin:origin,'X-Audio-Size':String(audio.length)},body:audio});assert.equal(up.status,201,await up.clone().text());
 const track=(await up.json()).tracks[0];
 const full=new Uint8Array(await (await get('/api/audio/'+track.id)).arrayBuffer());assert.equal(full.length,audio.length);assert.deepEqual(full.subarray(1048000,1049000),audio.subarray(1048000,1049000));
 const start=1048576-10,range=await get('/api/audio/'+track.id,{headers:{Range:`bytes=${start}-${start+19}`}});assert.equal(range.status,206);
 assert.deepEqual(new Uint8Array(await range.arrayBuffer()),audio.subarray(start,start+20));
 const short=await get(`/api/events/${id}/tracks?filename=b.mp3&duration=1`,{method:'POST',headers:{Cookie:cookie,Origin:origin,'X-Audio-Size':'5000'},body:new Uint8Array(10)});assert.equal(short.status,500);
 const snapshot=await (await get('/api/events/'+id,{headers:{Cookie:cookie}})).json();assert.equal(snapshot.tracks.length,1);assert.equal(snapshot.speechAvailable,false);
 assert.equal((await get('/healthz')).status,200);
 console.log('Node production smoke passed: real Node server + PostgreSQL, rendered pages, client assets, sign-in, forged-header removal, event creation, chunked audio storage with cross-chunk ranges, rejected short upload, voice off without a key, health check.');
}finally{child.kill('SIGTERM');await sleep(500);await sql(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);}
