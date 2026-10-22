import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,insertEnquiry} from '../core.js';
import {archiveEnquiry,syncClosedTickets} from '../archive.js';
const config={hubspot:{token:'test'}};
test('answered archive is durable and idempotent; resolved and deleted entries do not queue closure',()=>{
 const db=openDatabase(':memory:');const i=insertEnquiry(db,{channel:'phone',queue:'general',subject:'Call',callback:1});
 archiveEnquiry(db,i.id,'Phone','Answered',true);archiveEnquiry(db,i.id,'Phone','Answered',true);
 const r=db.prepare('SELECT * FROM enquiries WHERE id=?').get(i.id);
 assert.equal(r.callback,0);assert.equal(r.status,'resolved');assert.ok(r.archived_at);assert.equal(r.hubspot_close_state,'pending');
 assert.equal(db.prepare('SELECT count(*) n FROM notes WHERE enquiry_id=?').get(i.id).n,1);
 const local=insertEnquiry(db,{channel:'web',queue:'general',subject:'Resolved'});archiveEnquiry(db,local.id,'Staff','Resolved');
 assert.equal(db.prepare('SELECT hubspot_close_state FROM enquiries WHERE id=?').get(local.id).hubspot_close_state,'');
 db.close();
});
test('closure discovers actual ticket pipeline closed stage, retries safely and never deletes',async()=>{
 const db=openDatabase(':memory:');const i=insertEnquiry(db,{channel:'phone',queue:'general',subject:'Call'});
 db.prepare("UPDATE enquiries SET hubspot_ticket_id='123' WHERE id=?").run(i.id);archiveEnquiry(db,i.id,'Phone','Answered',true);
 let writes=0,closed=false,fail=true;
 const fetcher=async(url,options={})=>{
   assert.notEqual(options.method,'DELETE');
   if(url.endsWith('/stages')){assert.ok(url.includes('/custom/stages'));return Response.json({results:[{id:'open',metadata:{ticketState:'OPEN'}},{id:'finished',displayOrder:2,metadata:{ticketState:'CLOSED'}}]});}
   if(options.method==='PATCH') {writes++;assert.deepEqual(JSON.parse(options.body),{properties:{hs_pipeline_stage:'finished'}});if(fail)return new Response('',{status:503});closed=true;return Response.json({id:'123'});}
   return Response.json({id:'123',properties:{hs_pipeline:'custom',hs_pipeline_stage:closed?'finished':'open'}});
 };
 const now=new Date();await syncClosedTickets(db,config,fetcher,now);
 assert.equal(db.prepare('SELECT hubspot_close_state FROM enquiries').get().hubspot_close_state,'pending');
 await syncClosedTickets(db,config,fetcher,now);assert.equal(writes,1);
 fail=false;await syncClosedTickets(db,config,fetcher,new Date(now.getTime()+61000));
 assert.equal(db.prepare('SELECT hubspot_close_state FROM enquiries').get().hubspot_close_state,'done');assert.equal(writes,2);
 await syncClosedTickets(db,config,fetcher,new Date(now.getTime()+122000));assert.equal(writes,2);db.close();
});
test('no closed stage fails safely; already closed ticket needs no write',async()=>{
 const db=openDatabase(':memory:');const i=insertEnquiry(db,{channel:'phone',queue:'general',subject:'Call'});
 db.prepare("UPDATE enquiries SET hubspot_ticket_id='123' WHERE id=?").run(i.id);archiveEnquiry(db,i.id,'Phone','Answered',true);
 let stages=[];const fetcher=async(url,o={})=>{assert.ok(!o.method);return Response.json(url.endsWith('/stages')?{results:stages}:{id:'123',properties:{hs_pipeline:'0',hs_pipeline_stage:'4'}});};
 const now=new Date();await syncClosedTickets(db,config,fetcher,now);assert.equal(db.prepare('SELECT hubspot_close_state FROM enquiries').get().hubspot_close_state,'pending');
 stages=[{id:'4',metadata:{ticketState:'CLOSED'}}];await syncClosedTickets(db,config,fetcher,new Date(now.getTime()+61000));assert.equal(db.prepare('SELECT hubspot_close_state FROM enquiries').get().hubspot_close_state,'done');db.close();
});
