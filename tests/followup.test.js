import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,insertEnquiry} from '../core.js';
import {runFollowups} from '../followup.js';
const now=new Date('2026-09-24T03:00:00Z');
const config={base:'https://example.test',followupEnabled:true,summary:{apiKey:'test',from:'calls@example.test'},hubspot:{stage:'1'}};
function add(db,store='auckland',hours=5){const row=insertEnquiry(db,{channel:'phone',queue:'sales',subject:'Call',callback:1,store});db.prepare('UPDATE enquiries SET created_at=? WHERE id=?').run(new Date(now-3600000*hours).toISOString(),row.id);return row;}
const ok=async()=>new Response(JSON.stringify({id:'test-message'}));
test('five-hour trigger routes exact recipients, handles unspecified location and sends once',async()=>{
 const db=openDatabase(':memory:');add(db,'auckland');add(db,'christchurch');add(db,'any');add(db,'auckland',4.999);
 const sent=[];const sender=async(url,options)=>{sent.push(JSON.parse(options.body));return ok();};
 await runFollowups(db,config,sender,now);assert.deepEqual(sent.map(m=>m.to[0]),['martin@formtech.co.nz','jason@formtech.co.nz','jason@formtech.co.nz']);
 await runFollowups(db,config,sender,now);assert.equal(sent.length,3);assert.equal(db.prepare('SELECT count(*) n FROM notes').get().n,3);db.close();
});
test('progress, deletion, completion, archive and stale HubSpot status suppress reminders',async()=>{
 for(const change of ["status='in_progress'","status='waiting'","callback=0","deleted_at='yes'","archived_at='yes'","channel='web'","hubspot_ticket_id='123',hubspot_stage='2'","hubspot_ticket_id='123',hubspot_stage='1'",`hubspot_ticket_id='123',hubspot_stage='1',hubspot_checked_at=${Math.floor(now/1000)},hubspot_sync_error='unavailable'`]){
  const db=openDatabase(':memory:');const item=add(db);db.exec(`UPDATE enquiries SET ${change} WHERE id=${item.id}`);let sent=0;
  await runFollowups(db,config,async()=>{sent++;return ok();},now);assert.equal(sent,0,change);db.close();
 }
 const db=openDatabase(':memory:');const item=add(db);db.prepare("UPDATE enquiries SET hubspot_ticket_id='123',hubspot_stage='1',hubspot_checked_at=? WHERE id=?").run(Math.floor(now/1000),item.id);let sent=0;await runFollowups(db,config,async()=>{sent++;return ok();},now);assert.equal(sent,1);db.close();
});
test('uncertain delivery retries same payload and key; progress cancels remaining retry',async()=>{
 const db=openDatabase(':memory:');const item=add(db);const requests=[];
 const fail=async(url,options)=>{requests.push(options);throw Error('Network failure');};
 await runFollowups(db,config,fail,now);await runFollowups(db,config,fail,new Date(+now+60000));assert.equal(requests.length,1);
 await runFollowups(db,config,fail,new Date(+now+300000));assert.equal(requests.length,2);
 assert.equal(requests[0].body,requests[1].body);assert.equal(requests[0].headers['Idempotency-Key'],requests[1].headers['Idempotency-Key']);
 db.prepare("UPDATE enquiries SET status='waiting' WHERE id=?").run(item.id);await runFollowups(db,config,fail,new Date(+now+900000));assert.equal(requests.length,2);assert.equal(db.prepare('SELECT status FROM followup_jobs').get().status,'cancelled');db.close();
});
test('disabled and missing sender do not send; retry cutoff prevents duplicates beyond provider window',async()=>{
 const db=openDatabase(':memory:');add(db);let sent=0;const fail=async()=>{sent++;throw Error('Network');};
 await runFollowups(db,{...config,followupEnabled:false},fail,now);await runFollowups(db,{...config,summary:{...config.summary,from:''}},fail,now);assert.equal(sent,0);
 await runFollowups(db,config,fail,now);await runFollowups(db,config,fail,new Date(+now+23*3600000));assert.equal(sent,1);assert.equal(db.prepare('SELECT status FROM followup_jobs').get().status,'needs_review');db.close();
});
test('concurrent checks claim one job',async()=>{
 const db=openDatabase(':memory:');add(db);let finish,calls=0;
 const sender=()=>{calls++;return new Promise(resolve=>finish=()=>resolve(new Response(JSON.stringify({id:'test-id'}))));};
 const first=runFollowups(db,config,sender,now);await runFollowups(db,config,sender,now);assert.equal(calls,1);finish();await first;db.close();
});
