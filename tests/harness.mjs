// Runs an API/standalone bundle against either backend:
//   default          Miniflare (Cloudflare Workers + D1 + R2), SQLite migrations in drizzle/
//   YM_TEST_DB=pg    Node + PostgreSQL (the Render/Neon runtime), migrations in drizzle-postgres/
// YM_TEST_PG_URL selects the admin connection used to create a throwaway database
// (default postgres://postgres@127.0.0.1:5432/postgres).
import {createRequire} from 'node:module';
import {readFile,readdir,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),wranglerRequire=createRequire(require.resolve('wrangler/package.json'));
const {build}=wranglerRequire('esbuild');
export const backend=process.env.YM_TEST_DB==='pg'?'pg':'d1';
const API="import {api} from './lib/api.ts';export default {fetch:api};";
const BINDINGS=['DEEPGRAM_API_KEY','MC_CLOUDFLARE_ACCOUNT_ID','MC_CLOUDFLARE_API_TOKEN','ARTIST_PASSWORD','SESSION_SECRET'];

export async function createHarness({contents=API,bindings={},outboundService}={}){
 return backend==='pg'?pgHarness(contents,bindings,outboundService):d1Harness(contents,bindings,outboundService);
}

async function d1Harness(contents,bindings,outboundService){
 const {Miniflare}=wranglerRequire('miniflare');
 const built=await build({stdin:{contents,resolveDir:process.cwd()},bundle:true,write:false,platform:'browser',format:'esm',external:['cloudflare:workers']});
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET'],...(Object.keys(bindings).length?{bindings}:{}),...(outboundService?{outboundService}:{})});
 const DB=await mf.getD1Database('DB'),BUCKET=await mf.getR2Bucket('BUCKET');
 for(const file of(await readdir('drizzle')).filter(n=>n.endsWith('.sql')).sort())for(const sql of(await readFile('drizzle/'+file,'utf8')).split('--> statement-breakpoint'))if(sql.trim())await DB.prepare(sql).run();
 return {backend:'d1',DB,BUCKET,dispatchFetch:(url,init)=>mf.dispatchFetch(url,init),dispose:()=>mf.dispose()};
}

const cloudflareWorkersToNode={name:'cloudflare-workers-to-node',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:path.resolve('lib/node-runtime.ts')}));}};

async function pgHarness(contents,bindings,outboundService){
 const admin=new URL(process.env.YM_TEST_PG_URL||'postgres://postgres@127.0.0.1:5432/postgres');
 const pg=require('pg');
 const name='ym_test_'+randomBytes(6).toString('hex');
 const adminClient=new pg.Client({connectionString:admin.href});await adminClient.connect();
 await adminClient.query(`CREATE DATABASE ${name}`);await adminClient.end();
 const url=new URL(admin.href);url.pathname='/'+name;
 for(const key of BINDINGS)delete process.env[key];
 Object.assign(process.env,bindings,{DATABASE_URL:url.href});
 await mkdir('work',{recursive:true});
 const file=path.resolve('work',`harness-${name}.mjs`);
 const built=await build({stdin:{contents:contents+"\nexport {env as __env,migrate as __migrate,closePool as __close} from './lib/node-runtime.ts';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',external:['pg'],plugins:[cloudflareWorkersToNode]});
 await writeFile(file,built.outputFiles[0].text);
 const mod=await import(pathToFileURL(file).href);
 await mod.__migrate();
 const realFetch=globalThis.fetch;
 if(outboundService)globalThis.fetch=async(input,init)=>outboundService(new Request(input,init));
 const ctx={waitUntil(){},passThroughOnException(){}};
 return {backend:'pg',DB:mod.__env.DB,BUCKET:mod.__env.BUCKET,
  dispatchFetch:async(url,init)=>mod.default.fetch(new Request(url,init),mod.__env,ctx),
  async dispose(){
   globalThis.fetch=realFetch;await mod.__close();await rm(file,{force:true});
   const c=new pg.Client({connectionString:admin.href});await c.connect();await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await c.end();
  }};
}
