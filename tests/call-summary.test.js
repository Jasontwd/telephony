import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,insertEnquiry} from '../core.js';
import {loadSummaryConfig,summarySlot,callReport,runCallSummary} from '../call-summary.js';
const config={base:'https://example.test',summary:loadSummaryConfig({CALL_SUMMARY_ENABLED:'true',RESEND_API_KEY:'test-only',CALL_SUMMARY_FROM:'calls@example.test'})};
const at=value=>new Date(value);
const activate=db=>runCallSummary(db,config,()=>{throw Error('Unexpected send');},at('2026-09-21T19:00:00Z'));
test('NZ schedule stays at 8am across daylight saving and covers exactly 24 hours',()=>{
  for(const [now,end] of [['2026-09-22T00:00:00Z','2026-09-21T20:00:00.000Z'],['2026-09-27T00:00:00Z','2026-09-26T19:00:00.000Z'],['2027-04-04T00:00:00Z','2027-04-03T20:00:00.000Z']]) {
    const slot=summarySlot(at(now));assert.equal(slot.end.toISOString(),end);assert.equal(slot.end-slot.start,86400000);
  }
});
test('report counts only incoming phone records within boundaries and escapes caller data',()=>{
  const db=openDatabase(':memory:');
  function add(time,fields={}){const row=insertEnquiry(db,{channel:'phone',queue:'sales',subject:'Call',...fields});db.prepare('UPDATE enquiries SET created_at=?,accepted=?,recording_sid=?,call_status=?,status=? WHERE id=?').run(time,fields.accepted||0,fields.recording_sid||'',fields.call_status||'completed',fields.status||'new',row.id);}
  add('2026-09-20T20:00:00.000Z',{accepted:1,phone:'<script>bad</script>'});
  add('2026-09-21T10:00:00.000Z',{recording_sid:'REtest',callback:1});
  add('2026-09-21T11:00:00.000Z',{callback:1,status:'resolved'});
  add('2026-09-21T12:00:00.000Z',{channel:'web'});
  add('2026-09-21T20:00:00.000Z');add('2026-09-20T19:59:59.999Z');
  const report=callReport(db,config,at('2026-09-20T20:00:00Z'),at('2026-09-21T20:00:00Z'));
  assert.deepEqual(report.counts,{total:3,answered:1,voicemail:1,unanswered:1,incomplete:0,callbacks:1});
  assert(!report.html.includes('<script>'));assert(report.html.includes('&lt;script&gt;'));db.close();
});
test('missing sender never sends; daily trigger starts next scheduled morning and sends once',async()=>{
  const db=openDatabase(':memory:');let sends=0;
  const sender=async(url,options)=>{sends++;assert.equal(url,'https://api.resend.com/emails');assert.deepEqual(JSON.parse(options.body).to,['jason@formtech.co.nz']);return {ok:true,json:async()=>({id:'test-message-id'})};};
  assert.equal((await runCallSummary(db,{...config,summary:{...config.summary,from:''}},sender)).status,'not_configured');
  await activate(db);assert.equal((await runCallSummary(db,config,sender,at('2026-09-21T19:59:59Z'))).status,'idle');
  assert.equal((await runCallSummary(db,config,sender,at('2026-09-21T20:00:00Z'))).status,'accepted');
  await runCallSummary(db,config,sender,at('2026-09-21T21:00:00Z'));assert.equal(sends,1);
  assert.equal(db.prepare('SELECT payload FROM call_summary_jobs').get().payload,'');db.close();
});
test('ambiguous failure retries frozen payload with same key and stops before deduplication expires',async()=>{
  const db=openDatabase(':memory:');await activate(db);const requests=[];
  const sender=async(url,options)=>{requests.push(options);throw Error('Network interrupted');};
  await runCallSummary(db,config,sender,at('2026-09-21T20:00:00Z'));
  insertEnquiry(db,{channel:'phone',queue:'support',subject:'Later call'});
  await runCallSummary(db,config,sender,at('2026-09-21T20:01:00Z'));assert.equal(requests.length,1);
  await runCallSummary(db,config,sender,at('2026-09-21T20:05:00Z'));assert.equal(requests.length,2);
  assert.equal(requests[0].body,requests[1].body);assert.equal(requests[0].headers['Idempotency-Key'],requests[1].headers['Idempotency-Key']);
  await runCallSummary(db,config,sender,at('2026-09-22T19:00:00Z'));assert.equal(requests.length,2);
  assert.equal(db.prepare('SELECT status FROM call_summary_jobs').get().status,'needs_review');db.close();
});
test('concurrent ticks lease the report so only one request is in flight',async()=>{
  const db=openDatabase(':memory:');await activate(db);let release;let sends=0;
  const sender=()=>{sends++;return new Promise(resolve=>release=()=>resolve({ok:true,json:async()=>({id:'test-id'})}));};
  const first=runCallSummary(db,config,sender,at('2026-09-21T20:00:00Z'));
  await runCallSummary(db,config,sender,at('2026-09-21T20:00:00Z'));assert.equal(sends,1);release();await first;db.close();
});
