import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,insertEnquiry} from '../core.js';
import {recoverTranscripts} from '../transcription.js';
const account='AC'+'1'.repeat(32),recording='RE'+'2'.repeat(32),sid='TR'+'3'.repeat(32);
const config={account,token:'test-only'};
function setup(){const db=openDatabase(':memory:');const item=insertEnquiry(db,{channel:'phone',queue:'sales',subject:'Call'});db.prepare('UPDATE enquiries SET recording_sid=? WHERE id=?').run(recording,item.id);return {db,item};}
test('recovery retrieves matching completed text without overwriting successful callbacks',async()=>{
 const {db,item}=setup();let calls=0;
 const fetcher=async(url,opts)=>{calls++;assert(url.includes('/Recordings/'+recording+'/Transcriptions.json'));assert.equal(opts.redirect,'error');return new Response(JSON.stringify({transcriptions:[{sid,account_sid:account,recording_sid:recording,status:'completed',transcription_text:'Please repair my printer.'}]}));};
 await recoverTranscripts(db,config,fetcher);await recoverTranscripts(db,config,fetcher,new Date(Date.now()+400000));assert.equal(calls,1);
 const row=db.prepare('SELECT * FROM enquiries WHERE id=?').get(item.id);assert.equal(row.voicemail_transcript,'Please repair my printer.');assert.equal(row.transcription_status,'completed');db.close();
});
test('recovery rejects mismatched recordings, throttles retries, and skips deleted records',async()=>{
 const {db,item}=setup();let calls=0;const now=new Date();
 const fetcher=async()=>{calls++;return new Response(JSON.stringify({transcriptions:[{sid,account_sid:account,recording_sid:'RE'+'4'.repeat(32),status:'completed',transcription_text:'Wrong call'}]}));};
 await recoverTranscripts(db,config,fetcher,now);await recoverTranscripts(db,config,fetcher,now);assert.equal(calls,1);assert.equal(db.prepare('SELECT voicemail_transcript FROM enquiries').get().voicemail_transcript,'');
 db.prepare("UPDATE enquiries SET deleted_at='yes' WHERE id=?").run(item.id);await recoverTranscripts(db,config,fetcher,new Date(+now+400000));assert.equal(calls,1);db.close();
});
test('provider failures are visible and leave existing data intact',async()=>{
 const {db}=setup();await recoverTranscripts(db,config,async()=>new Response('{}',{status:401}));const row=db.prepare('SELECT * FROM enquiries').get();assert(row.transcription_error.includes('401'));assert.equal(row.voicemail_transcript,'');db.close();
});
test('HubSpot schema denial falls back to description, preserves staff text and deduplicates uncertain writes',async()=>{
 const {syncTranscripts}=await import('../hubspot.js');const {db,item}=setup();
 db.prepare("UPDATE enquiries SET voicemail_transcript='Please repair the nozzle.',transcription_sid=?,hubspot_ticket_id='456' WHERE id=?").run(sid,item.id);
 let content='Staff note: quote approved.',patches=0;
 const fetcher=async(url,opts)=>{
  if(url.includes('/properties/'))return new Response('{}',{status:403});
  if(opts.method==='PATCH'){patches++;content=JSON.parse(opts.body).properties.content;throw Error('Lost response after commit');}
  return new Response(JSON.stringify({id:'456',properties:{content}}));
 };
 await syncTranscripts(db,{hubspot:{token:'test'}},fetcher);assert(content.startsWith('Staff note: quote approved.'));assert(content.includes('Please repair the nozzle.'));
 db.prepare('UPDATE enquiries SET transcript_attempt_at=0').run();await syncTranscripts(db,{hubspot:{token:'test'}},fetcher);
 assert.equal(patches,1);assert.equal(db.prepare('SELECT transcript_synced FROM enquiries').get().transcript_synced,'Please repair the nozzle.');db.close();
});
