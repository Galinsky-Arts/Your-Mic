import {createHarness} from './harness.mjs';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const mf=await createHarness();
try{
 const {DB,BUCKET}=mf;
 const owner={'oai-authenticated-user-id':'artist'},controller=randomUUID(),host={...owner,'x-controller-token':controller},guest=()=>({'x-guest-token':randomUUID()});
 async function req(path,method='GET',body,headers=host,status=200){const r=await mf.dispatchFetch('https://requests.test/api/'+path,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const d=await r.json();assert.equal(r.status,status,JSON.stringify(d));return d;}
 const created=await req('events','POST',{title:'Sides A and B',artist:'Artist'},host,201),base='events/'+created.id,a=randomUUID(),b=randomUUID();
 await DB.batch([a,b].map((id,i)=>DB.prepare('INSERT INTO tracks(id,event_id,title,position,duration,audio_key,mime) VALUES(?,?,?,?,?,?,?)').bind(id,created.id,i?'Instrumental':'Lyrical song',i,180,id+'.wav','audio/wav')));
 await BUCKET.put(a+'.wav',new Uint8Array(64),{httpMetadata:{contentType:'audio/wav'}});
 let s=await req(base);assert(s.tracks.every(t=>t.rapAllowed===1),'Existing/new tracks default to allowed');
 const firstGuest=guest();s=await req(base+'/queue','POST',{name:'Already queued',trackId:a},firstGuest,201);const entry=s.queue[0].id;
 await req(base+'/tracks/'+a,'PATCH',{rapAllowed:false},guest(),401);
 await req(base+'/tracks/'+a,'PATCH',{rapAllowed:false},{'oai-authenticated-user-id':'other'},403);
 await req(base+'/tracks/'+a,'PATCH',{rapAllowed:0},host,400);
 await req(base+'/tracks/'+randomUUID(),'PATCH',{rapAllowed:false},host,404);
 s=await req(base+'/control','POST',{action:'claim',controller});s=await req(base+'/control','POST',{action:'play',controller});
 const before=await DB.prepare('SELECT * FROM events WHERE id=?').bind(created.id).first();
 s=await req(base+'/tracks/'+a,'PATCH',{rapAllowed:false});assert.equal(s.tracks.find(t=>t.id===a).rapAllowed,0);
 assert.deepEqual(await DB.prepare('SELECT * FROM events WHERE id=?').bind(created.id).first(),before,'Availability must not mutate any speaker or transport field');
 assert.equal(s.queue.find(q=>q.id===entry).status,'waiting','Already queued turns remain intact');
 const publicView=await req(base,'GET',undefined,guest());assert.equal(publicView.tracks.length,2);assert.equal(publicView.tracks.find(t=>t.id===a).rapAllowed,0);
 for(let i=0;i<20;i++)await req(base+'/queue','POST',{name:'Stale or direct request',trackId:a},guest(),400);
 assert.equal((await req(base)).queue.length,1);
 const preview=await mf.dispatchFetch('https://requests.test/api/audio/'+a);assert.equal(preview.status,200);assert.equal((await preview.arrayBuffer()).byteLength,64,'Listening stays available');
 const range=await mf.dispatchFetch('https://requests.test/api/audio/'+a,{headers:{Range:'bytes=0-9'}});assert.equal(range.status,206);
 s=await req(base+'/queue','POST',{name:'Other allowed song',trackId:b},guest(),201);assert.equal(s.queue.length,2);
 s=await req(base+'/control','POST',{action:'next',controller,version:s.event.version});assert.equal(s.event.current_track,b);
 s=await req(base+'/control','POST',{action:'next',controller,version:s.event.version});assert.equal(s.event.current_track,a,'Playlist still includes a listening-only song');
 s=await req(base+'/tracks/'+a,'PATCH',{rapAllowed:true});assert.equal(s.tracks.find(t=>t.id===a).rapAllowed,1);
 s=await req(base+'/queue','POST',{name:'Allowed again',trackId:a},guest(),201);assert.equal(s.queue.length,3);
 console.log('Rap request selection passed: allowed by default, artist-only toggles, server-side stale/direct request rejection, re-enable, private listening/ranges, preserved queued turns and unchanged live transport.');
}finally{await mf.dispose();}
