import {createHarness} from './harness.mjs';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const apiSource=process.env.YM_TEST_API_SOURCE||'./lib/api.ts';
const mf=await createHarness({contents:`import {api} from ${JSON.stringify(apiSource)};export default {fetch:api};`});
try{
 const {DB}=mf;
 const owner={'oai-authenticated-user-id':'lease-test-artist'},controller=randomUUID(),other=randomUUID();
 async function req(path,body){const r=await mf.dispatchFetch('https://your-mic.test/api/'+path,{method:body?'POST':'GET',headers:{...owner,'Content-Type':'application/json','x-controller-token':controller},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};}
 const made=await req('events',{title:'Lease stress',artist:'Artist'}),eventId=made.data.id,trackId=randomUUID(),base='events/'+eventId;
 await DB.prepare('INSERT INTO tracks(id,event_id,title,position,duration,audio_key,mime) VALUES(?,?,?,?,?,?,?)').bind(trackId,eventId,'Long verse',0,600,'test.wav','audio/wav').run();
 await req(base+'/control',{action:'claim',controller});let s=await req(base+'/control',{action:'play',controller});const playbackId=s.data.event.playback_id;
 for(let i=0;i<120;i++){
  await DB.prepare("UPDATE events SET controller_until=?,started_at=? WHERE id=?").bind(Date.now()-[60000,180000,3600000][i%3],Date.now()-3600000,eventId).run();
  const beat=await req(base+'/control',{action:'heartbeat',controller,playbackId,position:40+i/10});assert.equal(beat.status,200,'An expired current controller must renew without reconnecting or restarting');
  s=await req(base);assert.equal(s.data.event.playback_id,playbackId);assert.equal(s.data.event.status,'playing');assert.equal(s.data.event.position,40+i/10);assert(s.data.speakerHere);
 }
 // Race a renewal against an unforced claim: both must never succeed.
 const hash=createHash('sha256').update(controller).digest('hex');
 for(let i=0;i<80;i++){
  await DB.prepare("UPDATE events SET controller_hash=?,controller_until=0,status='playing',version=version+1 WHERE id=?").bind(hash,eventId).run();
  const [beat,claim]=await Promise.all([req(base+'/control',{action:'heartbeat',controller,playbackId,position:52}),req(base+'/control',{action:'claim',controller:other})]);
  assert.equal(beat.status,200);assert.equal(claim.status,409,'An unforced claimant cannot take over even after a long heartbeat outage');
 }
 await DB.prepare('UPDATE events SET controller_hash=?,controller_until=? WHERE id=?').bind(hash,Date.now()+45000,eventId).run();
 assert.equal((await req(base+'/control',{action:'claim',controller:other})).status,409);
 assert.equal((await req(base+'/control',{action:'claim',controller:other,force:true})).status,200);
 assert.equal((await req(base+'/control',{action:'heartbeat',controller,playbackId,position:99})).status,409);
 assert.equal((await req(base+'/control',{action:'play',controller})).status,409);
 console.log('Speaker lease passed: 120 recoveries without restarts, 80 concurrent unforced claims rejected, permanent ownership and explicit takeover.');
}finally{await mf.dispose();}
