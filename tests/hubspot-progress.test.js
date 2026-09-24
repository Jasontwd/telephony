import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,insertEnquiry} from '../core.js';
import {syncTicketProgress} from '../hubspot.js';
import {callReport} from '../call-summary.js';
const config={base:'https://example.test',hubspot:{token:'test',pipeline:'0',stage:'1'}};
function setup(){const db=openDatabase(':memory:');const item=insertEnquiry(db,{channel:'phone',queue:'sales',subject:'Call',callback:1});db.prepare("UPDATE enquiries SET hubspot_ticket_id='123' WHERE id=?").run(item.id);return {db,item};}
const response=(props,extra={})=>async(url,options)=>{assert.equal(url,'https://api.hubapi.com/crm/v3/objects/tickets/batch/read');assert.equal(options.method,'POST');return new Response(JSON.stringify({results:[{id:'123',properties:props,...extra}]}));};
test('HubSpot requires owner and progressed stage; missing or deleted tickets fail safe',async()=>{
  for(const [owner,stage,pipeline,expected] of [['42','2','0',true],['42','1','0',false],['','2','0',false],[null,'2','0',false],['42','','0',false],['42','2','other',false]]) {
    const {db,item}=setup();await syncTicketProgress(db,config,response({hubspot_owner_id:owner,hs_pipeline_stage:stage,hs_pipeline:pipeline}));
    assert.equal(!!db.prepare('SELECT archived_at FROM enquiries WHERE id=?').get(item.id).archived_at,expected);db.close();
  }
  for(const mock of [async()=>new Response('{}',{status:403}),async()=>new Response(JSON.stringify({results:[]})),response({hs_pipeline_stage:'2',hs_pipeline:'0'}),response({hubspot_owner_id:'42',hs_pipeline_stage:'2',hs_pipeline:'0'},{archived:true})]) {
    const {db,item}=setup();await syncTicketProgress(db,config,mock);const row=db.prepare('SELECT * FROM enquiries WHERE id=?').get(item.id);assert.equal(row.archived_at,'');assert(row.hubspot_sync_error);db.close();
  }
});
test('archive retains call totals, excludes callback totals, audits once and ignores deleted rows',async()=>{
  const {db,item}=setup();const mock=response({hubspot_owner_id:'42',hs_pipeline_stage:'2',hs_pipeline:'0'});
  await syncTicketProgress(db,config,mock);await syncTicketProgress(db,config,mock,new Date(Date.now()+120000));
  assert.equal(db.prepare('SELECT count(*) n FROM notes WHERE enquiry_id=?').get(item.id).n,1);
  const report=callReport(db,config,new Date(Date.now()-86400000),new Date(Date.now()+1000));assert.equal(report.counts.total,1);assert.equal(report.counts.callbacks,0);
  const removed=insertEnquiry(db,{channel:'web',queue:'accounts',subject:'Deleted'});db.prepare("UPDATE enquiries SET deleted_at='yes',hubspot_ticket_id='456' WHERE id=?").run(removed.id);
  await syncTicketProgress(db,config,()=>{throw Error('No request expected');});assert.equal(db.prepare('SELECT hubspot_checked_at FROM enquiries WHERE id=?').get(removed.id).hubspot_checked_at,0);db.close();
});
test('poll cadence avoids repeated requests and preserves state until successful retry',async()=>{
  const {db,item}=setup();let requests=0;const now=new Date();
  await syncTicketProgress(db,config,async()=>{requests++;return new Response('{}',{status:500});},now);
  await syncTicketProgress(db,config,async()=>{requests++;throw Error('Too soon');},new Date(now.getTime()+30000));assert.equal(requests,1);
  await syncTicketProgress(db,config,response({hubspot_owner_id:'42',hs_pipeline_stage:'2',hs_pipeline:'0'}),new Date(now.getTime()+90000));
  const row=db.prepare('SELECT * FROM enquiries WHERE id=?').get(item.id);assert(row.archived_at);assert.equal(row.hubspot_sync_error,'');db.close();
});
