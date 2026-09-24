import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {loadConfig,openDatabase,hashPassword,signature,hmac,insertEnquiry,isOpen} from '../core.js';
import {createApp} from '../server.js';
import {syncEnquiries} from '../hubspot.js';

let app,base;
const account='AC'+'1'.repeat(32),sid='CA'+'2'.repeat(32),child='CA'+'3'.repeat(32);
const config=loadConfig({SESSION_SECRET:'x'.repeat(40),TWILIO_ACCOUNT_SID:account,TWILIO_AUTH_TOKEN:'test-token',
  STAFF_USERS_JSON:JSON.stringify(['manager','agent','accounts'].map(role=>({username:role,role,passwordHash:hashPassword('correct-test-password')}))),
  EMAIL_WEBHOOK_SECRET:'email-test-secret',PUBLIC_PHONE:'+6495550100',HOURS_CONFIRMED:'true',
  TELEPHONY_ENABLED:'true',SUPPORT_PHONE:'+6495550101',AUCKLAND_PHONE:'+6495550102'});
before(async()=>{app=createApp(config,openDatabase(':memory:'));await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;config.base=base;});
after(async()=>{await new Promise(r=>app.server.close(r));app.db.close();});
const token=html=>html.match(/name="csrf" value="([^"]+)"/)[1];
async function formPage(path='/') {const r=await fetch(base+path);return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:token(await r.text())};}
const post=(path,fields,cookie='',extra={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie,...extra},body:new URLSearchParams(fields),redirect:'manual'});
async function signIn(role) {const f=await formPage('/login');const r=await post('/login',{csrf:f.csrf,username:role,password:'correct-test-password'},f.cookie);assert.equal(r.status,303);const cookie=r.headers.get('set-cookie').split(';')[0];return {cookie,csrf:token(await(await fetch(base+'/staff',{headers:{Cookie:cookie}})).text())};}
function voice(path,fields={}) {const form=new URLSearchParams({AccountSid:account,CallSid:sid,From:'+6421555010',...fields});return fetch(base+path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':signature(config.token,config.base+path,form)},body:form});}

test('health check and public page do not expose private destination numbers',async()=>{
  assert.equal((await fetch(base+'/health')).status,200);
  const html=await(await fetch(base)).text();assert.ok(!html.includes(config.routes['1'].phone));assert.ok(html.includes('How can we help?'));
});
test('staff data requires authentication; unknown user rejected',async()=>{
  const r=await fetch(base+'/staff',{redirect:'manual'});assert.equal(r.status,303);
  const f=await formPage('/login');assert.equal((await post('/login',{csrf:f.csrf,username:'unknown',password:'wrong'},f.cookie)).status,401);
});
test('public forms require CSRF and valid contact details',async()=>{
  assert.equal((await post('/enquiries',{name:'Alice'})).status,403);
  const f=await formPage();assert.equal((await post('/enquiries',{csrf:f.csrf,name:'Alice',queue:'sales',store:'any',subject:'Printer',message:'Help'},f.cookie)).status,400);
});
test('browser form policy preserves same-origin login and rejects foreign origins',async()=>{
  const page=await fetch(base+'/login');
  assert.equal(page.headers.get('referrer-policy'),'same-origin');
  const cookie=page.headers.get('set-cookie').split(';')[0];
  const fields={csrf:token(await page.text()),username:'manager',password:'correct-test-password'};
  for(const origin of ['null','https://untrusted.example']) {
    const rejected=await post('/login',fields,cookie,{Origin:origin});
    assert.equal(rejected.status,403);
    assert.match(await rejected.text(),/Invalid request origin/);
  }
  assert.equal((await post('/login',{...fields,csrf:'invalid'},cookie,{Origin:base})).status,403);
  const accepted=await post('/login',fields,cookie,{Origin:base});
  assert.equal(accepted.status,303);
  const session=accepted.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base+'/staff',{headers:{Cookie:session},redirect:'manual'})).status,200);
});
test('valid submission is durable, duplicate form retry is idempotent, HTML is escaped',async()=>{
  const f=await formPage(),fields={csrf:f.csrf,name:'<script>alert(1)</script>',email:'alice@example.test',queue:'sales',store:'auckland',subject:'Printer quote',message:'Please quote a printer'};
  const a=await post('/enquiries',fields,f.cookie),b=await post('/enquiries',fields,f.cookie);assert.equal(a.status,201);assert.equal(b.status,201);
  assert.equal(app.db.prepare("SELECT count(*) AS n FROM enquiries WHERE subject='Printer quote'").get().n,1);
  const s=await signIn('manager');const html=await(await fetch(base+'/staff',{headers:{Cookie:s.cookie}})).text();assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
});
test('accounts are isolated in lists and direct record access',async()=>{
  const item=insertEnquiry(app.db,{channel:'web',queue:'accounts',subject:'Private invoice'});
  const agent=await signIn('agent');const listing=await(await fetch(base+'/staff',{headers:{Cookie:agent.cookie}})).text();assert.ok(!listing.includes('Private invoice'));
  assert.equal((await fetch(base+'/staff/enquiries/'+item.id,{headers:{Cookie:agent.cookie}})).status,404);
  const accounts=await signIn('accounts');assert.equal((await fetch(base+'/staff/enquiries/'+item.id,{headers:{Cookie:accounts.cookie}})).status,200);
});
test('staff updates validate CSRF, persist ownership, and create audit notes',async()=>{
  const s=await signIn('manager');const id=app.db.prepare("SELECT id FROM enquiries WHERE subject='Printer quote'").get().id;
  assert.equal((await post('/staff/enquiries/'+id,{status:'resolved'},s.cookie)).status,403);
  const fields={csrf:s.csrf,status:'in_progress',owner:'agent',due_at:'2027-01-01',outcome:'quoted',quote_value:'500',callback:'complete',next_action:'Call customer',note:'Discussed requirements'};
  assert.equal((await post('/staff/enquiries/'+id,fields,s.cookie)).status,303);
  assert.equal(app.db.prepare('SELECT owner FROM enquiries WHERE id=?').get(id).owner,'agent');
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM notes WHERE enquiry_id=?').get(id).n,1);
});
test('unsigned and tampered voice requests cannot route calls',async()=>{
  assert.equal((await post('/voice/incoming',{CallSid:sid})).status,403);
  const f=new URLSearchParams({AccountSid:account,CallSid:sid});const sig=signature(config.token,base+'/voice/incoming',f);f.set('From','+6421000000');
  assert.equal((await fetch(base+'/voice/incoming',{method:'POST',body:f,headers:{'X-Twilio-Signature':sig}})).status,403);
});
test('incoming retry creates one call record and no-selection falls back to voicemail',async()=>{
  assert.ok((await(await voice('/voice/incoming')).text()).includes('<Gather'));
  await voice('/voice/incoming');assert.equal(app.db.prepare('SELECT count(*) AS n FROM enquiries WHERE external_key=?').get('call:'+sid).n,1);
  assert.ok((await(await voice('/voice/select?attempt=0')).text()).includes('<Gather'));
  assert.ok((await(await voice('/voice/select?attempt=1')).text()).includes('<Record'));
});
test('open-hour route dials configured destination with answer confirmation; machine answer falls back',async()=>{
  const all=Object.fromEntries(Array.from({length:7},(_,i)=>[i,['00:00','23:59']]));config.hours.general=all;
  const xml=await(await voice('/voice/select?attempt=0',{Digits:'3'})).text();assert.ok(xml.includes(config.routes['3'].phone));assert.ok(xml.includes('/voice/confirm?parent='));
  const ended=await(await voice('/voice/dial-ended?backup=0',{DialCallStatus:'completed'})).text();assert.ok(ended.includes('<Record'));
});
test('confirmed staff answer is tracked; recording and status callbacks remain idempotent',async()=>{
  const accepted=await voice('/voice/accept?parent='+sid,{CallSid:child,ParentCallSid:sid,Digits:'1'});assert.equal(accepted.status,200);
  assert.ok(!(await(await voice('/voice/dial-ended?backup=0',{DialCallStatus:'completed'})).text()).includes('<Record'));
  const recording='RE'+'4'.repeat(32);await voice('/voice/recording',{RecordingSid:recording,RecordingStatus:'completed'});await voice('/voice/status',{CallStatus:'completed'});
  const item=app.db.prepare('SELECT * FROM enquiries WHERE external_key=?').get('call:'+sid);assert.equal(item.recording_sid,recording);assert.equal(item.call_status,'voicemail');
});
test('NZ business hours account for time zone, daylight saving and closed dates',()=>{
  const c=loadConfig({});assert.equal(isOpen(c,'auckland',new Date('2026-09-14T21:00:00Z')),true);
  assert.equal(isOpen(c,'christchurch',new Date('2026-09-14T21:00:00Z')),false);
  assert.equal(isOpen(c,'auckland',new Date('2026-12-07T20:00:00Z')),true);
  assert.equal(isOpen(c,'christchurch',new Date('2026-09-14T21:59:00Z')),false);
  assert.equal(isOpen(c,'christchurch',new Date('2026-09-14T22:00:00Z')),true);
  assert.equal(isOpen(c,'christchurch',new Date('2026-09-15T04:59:00Z')),true);
  assert.equal(isOpen(c,'christchurch',new Date('2026-09-15T05:00:00Z')),false);
  assert.equal(isOpen(c,'christchurch',new Date('2026-09-18T23:00:00Z')),false);
  assert.equal(isOpen(c,'christchurch',new Date('2026-12-07T21:00:00Z')),true);
  c.closed=['2026-12-08'];assert.equal(isOpen(c,'auckland',new Date('2026-12-07T20:00:00Z')),false);
});
test('email bridge rejects invalid signatures and leaves support@ in HubSpot',async()=>{
  assert.equal((await post('/hooks/email',{})).status,403);
  const mail={id:'mail-001',to:'support@formtech.co.nz',from:'customer@example.test',subject:'Support',text:'Help'};
  const sendMail=async m=>{const body=JSON.stringify(m),stamp=String(Math.floor(Date.now()/1000));return fetch(base+'/hooks/email',{method:'POST',headers:{'Content-Type':'application/json','X-Formtech-Timestamp':stamp,'X-Formtech-Signature':hmac(config.emailSecret,stamp+'.'+body)},body});};
  assert.equal((await sendMail(mail)).status,202);assert.equal(app.db.prepare("SELECT count(*) AS n FROM enquiries WHERE external_key='email:mail-001'").get().n,0);
  mail.to='orders@formtech.co.nz';await sendMail(mail);await sendMail(mail);assert.equal(app.db.prepare("SELECT count(*) AS n FROM enquiries WHERE external_key='email:mail-001'").get().n,1);
});
test('HubSpot handoff checks uniqueness, survives uncertain creation and links the existing ticket',async()=>{
  const db=openDatabase(':memory:');const item=insertEnquiry(db,{channel:'web',queue:'support',subject:'Repair',phone:'+6421555010'});
  const c={base,hubspot:{token:'fake',pipeline:'0',stage:'1',referenceProperty:'formtech_reference'}};
  let created=0,exists=false;
  const mock=async(url,opts)=>{
    if(url.includes('/properties/'))return new Response(JSON.stringify({hasUniqueValue:true}));
    if(opts.method==='POST'){created++;exists=true;throw Error('Simulated response loss after server commit');}
    return exists?new Response(JSON.stringify({id:'12345'})):new Response('{}',{status:404});
  };
  await syncEnquiries(db,c,mock);assert.ok(db.prepare('SELECT hubspot_error FROM enquiries').get().hubspot_error);
  db.prepare('UPDATE enquiries SET hubspot_attempt_at=0').run();await syncEnquiries(db,c,mock);
  assert.equal(created,1);assert.equal(db.prepare('SELECT hubspot_ticket_id FROM enquiries WHERE id=?').get(item.id).hubspot_ticket_id,'12345');db.close();
});
test('HubSpot creates nothing without a verified unique property',async()=>{
  const db=openDatabase(':memory:');insertEnquiry(db,{channel:'web',queue:'support',subject:'Repair'});
  let writes=0;await syncEnquiries(db,{hubspot:{token:'fake',pipeline:'0',stage:'1',referenceProperty:'reference'}},async(url,opts)=>{if(opts.method==='POST')writes++;return new Response(JSON.stringify({hasUniqueValue:false}));});
  assert.equal(writes,0);assert.ok(db.prepare('SELECT hubspot_error FROM enquiries').get().hubspot_error.includes('setup required'));db.close();
});
test('production fails closed without staff authentication and required telephony configuration',()=>{
  assert.throws(()=>loadConfig({NODE_ENV:'production'}));
  assert.throws(()=>loadConfig({TELEPHONY_ENABLED:'true'}));
});
test('unanswered call tries one backup only, then voicemail; closed route never dials',async()=>{
  const call='CA'+'5'.repeat(32);config.routes['1'].backup='+6495550103';
  config.hours.auckland=Object.fromEntries(Array.from({length:7},(_,i)=>[i,['00:00','23:59']]));
  await voice('/voice/incoming',{CallSid:call});await voice('/voice/select?attempt=0',{CallSid:call,Digits:'1'});
  const backup=await(await voice('/voice/dial-ended?backup=0',{CallSid:call,DialCallStatus:'busy'})).text();assert.ok(backup.includes(config.routes['1'].backup));
  const voicemail=await(await voice('/voice/dial-ended?backup=1',{CallSid:call,DialCallStatus:'no-answer'})).text();assert.ok(voicemail.includes('<Record'));assert.ok(!voicemail.includes('<Dial'));
  config.hours.auckland={};const closed=await(await voice('/voice/select?attempt=0',{CallSid:call,Digits:'1'})).text();assert.ok(!closed.includes('<Dial'));
});
test('completed provider retries do not reopen a callback finished by staff',async()=>{
  const call='CA'+'5'.repeat(32);
  app.db.prepare("UPDATE enquiries SET callback=0 WHERE external_key=?").run('call:'+call);
  await voice('/voice/status',{CallSid:call,CallStatus:'completed'});
  assert.equal(app.db.prepare('SELECT callback FROM enquiries WHERE external_key=?').get('call:'+call).callback,0);
});
test('database persists enquiries across closing and reopening the connection',()=>{
  const path=mkdtempSync(tmpdir()+'/formtech-test-')+'/test.sqlite';let db=openDatabase(path);
  const item=insertEnquiry(db,{channel:'web',queue:'sales',subject:'Persistence check'});db.close();db=openDatabase(path);
  assert.equal(db.prepare('SELECT subject FROM enquiries WHERE reference=?').get(item.reference).subject,'Persistence check');db.close();
});

test('Shopify form submits without third-party cookies and preserves iframe policy',async()=>{
  const r=await fetch(base+'/embed');
  assert.equal(r.headers.get('set-cookie'),null);
  const policy=r.headers.get('content-security-policy');
  assert.match(policy,/frame-ancestors 'self' https:\/\/formtech.co.nz https:\/\/www.formtech.co.nz;/);
  assert.ok(!policy.includes('https://*.myshopify.com'));
  const html=await r.text();assert.match(html,/action="\/embed\/enquiries"/);
  assert.ok(!html.includes('Staff sign in'));
  const fields={csrf:token(html),name:'Embed test',email:'embed@example.test',queue:'support',store:'any',subject:'Shopify cookie-free submission',message:'Test embed with no cookies'};
  const result=await post('/embed/enquiries',fields,'',{Origin:base});
  assert.equal(result.status,201);assert.equal(result.headers.get('set-cookie'),null);
  assert.equal(result.headers.get('content-security-policy'),policy);
  assert.match(await result.text(),/Send another enquiry/);
  await post('/embed/enquiries',fields,'',{Origin:base});
  assert.equal(app.db.prepare("SELECT count(*) AS n FROM enquiries WHERE subject='Shopify cookie-free submission'").get().n,1);
  assert.equal(app.db.prepare("SELECT queue FROM enquiries WHERE subject='Shopify cookie-free submission'").get().queue,'support');
});
test('embed tokens reject tampering, expiry and foreign origins; staff remains isolated',async()=>{
  const html=await(await fetch(base+'/embed')).text();
  const fields={csrf:token(html),name:'Blocked test',email:'embed@example.test',queue:'support',store:'any',subject:'Must not save',message:'Invalid embed'};
  for(const origin of ['https://formtech.co.nz','https://untrusted.example','null'])assert.equal((await post('/embed/enquiries',fields,'',{Origin:origin})).status,403);
  assert.equal((await post('/embed/enquiries',fields)).status,403);
  assert.equal((await post('/embed/enquiries',{...fields,csrf:fields.csrf+'x'},'',{Origin:base})).status,403);
  const raw=(Math.floor(Date.now()/1000)-3601)+'.'+'a'.repeat(40);
  const expired=raw+'.'+hmac(config.secret,'embed:'+raw);
  assert.equal((await post('/embed/enquiries',{...fields,csrf:expired},'',{Origin:base})).status,403);
  assert.equal((await post('/login',{csrf:fields.csrf,username:'manager',password:'correct-test-password'},'',{Origin:base})).status,403);
  for(const path of ['/','/login','/staff','/staff?embed=true']){
    const response=await fetch(base+path,{redirect:'manual'});
    assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  }
  assert.equal(app.db.prepare("SELECT count(*) AS n FROM enquiries WHERE subject='Must not save'").get().n,0);
});

test('closed showroom choices announce the selected location before voicemail, while open routes do not',async()=>{
  const all=Object.fromEntries(Array.from({length:7},(_,i)=>[i,['00:00','23:59']]));
  for(const [digit,store,location] of [['1','auckland','Auckland'],['2','christchurch','Christchurch']]) {
    const originalHours=config.hours[store], originalPhone=config.routes[digit].phone;
    try {
      config.hours[store]={};
      const call='CA'+digit.repeat(32);
      await voice('/voice/incoming',{CallSid:call});
      const closed=await(await voice('/voice/select?attempt=0',{CallSid:call,Digits:digit})).text();
      assert.match(closed,new RegExp(`Our ${location} 3D showroom and production bureau is currently closed`));
      assert.ok(closed.indexOf('currently closed')<closed.indexOf('<Record'));
      assert.ok(!closed.includes('<Dial'));
      assert.equal(app.db.prepare('SELECT callback FROM enquiries WHERE external_key=?').get('call:'+call).callback,1);
      config.hours[store]=all;config.routes[digit].phone='+6495550102';
      const open=await(await voice('/voice/select?attempt=0',{CallSid:call,Digits:digit})).text();
      assert.ok(open.includes('<Dial'));assert.ok(!open.includes('currently closed'));
      config.routes[digit].phone='';
      const unconfigured=await(await voice('/voice/select?attempt=0',{CallSid:call,Digits:digit})).text();
      assert.ok(unconfigured.includes('<Record'));assert.ok(!unconfigured.includes('currently closed'));
    } finally {config.hours[store]=originalHours;config.routes[digit].phone=originalPhone;}
  }
});

test('daily call preview is manager-only and does not send mail',async()=>{
  assert.equal((await fetch(base+'/staff/call-summary',{redirect:'manual'})).status,303);
  for(const role of ['agent','accounts','manager']) {
    const session=await signIn(role);
    const response=await fetch(base+'/staff/call-summary',{headers:{Cookie:session.cookie}});
    assert.equal(response.status,role==='manager'?200:404);
    if(role==='manager')assert.match(await response.text(),/Viewing this page does not send an email/);
  }
});

test('manual email trigger requires manager and CSRF and refuses an unconfigured sender',async()=>{
  const agent=await signIn('agent');assert.equal((await post('/staff/call-summary/test',{csrf:agent.csrf},agent.cookie)).status,404);
  const manager=await signIn('manager');assert.equal((await post('/staff/call-summary/test',{},manager.cookie)).status,403);
  assert.equal((await post('/staff/call-summary/test',{csrf:manager.csrf},manager.cookie)).status,400);
});

test('manager deletion is reversible, audited, CSRF protected and excluded from summaries',async()=>{
  const {callReport}=await import('../call-summary.js');
  const item=insertEnquiry(app.db,{channel:'phone',queue:'general',subject:'Disposable test call',external_key:'call:deletion-test',callback:1});
  const manager=await signIn('manager'),agent=await signIn('agent');
  const path='/staff/enquiries/'+item.id;
  assert.equal((await post(path+'/delete',{reason:'test',csrf:agent.csrf},agent.cookie)).status,404);
  assert.equal((await post(path+'/delete',{reason:'test'},manager.cookie)).status,403);
  assert.equal((await post(path+'/delete',{reason:'wrong',csrf:manager.csrf},manager.cookie)).status,400);
  assert.equal((await post(path+'/delete',{reason:'test',csrf:manager.csrf},manager.cookie)).status,303);
  const html=await(await fetch(base+'/staff',{headers:{Cookie:manager.cookie}})).text();assert(!html.includes('Disposable test call'));
  assert.equal((await fetch(base+path,{headers:{Cookie:agent.cookie}})).status,404);
  assert.equal((await fetch(base+'/staff/deleted',{headers:{Cookie:agent.cookie}})).status,404);
  const deleted=await(await fetch(base+'/staff/deleted',{headers:{Cookie:manager.cookie}})).text();assert(deleted.includes('Disposable test call'));
  const detail=await(await fetch(base+path,{headers:{Cookie:manager.cookie}})).text();assert(detail.includes('Restore enquiry'));assert(!detail.includes('Save changes'));
  const report=callReport(app.db,config,new Date(Date.now()-86400000),new Date(Date.now()+1000));assert(!report.text.includes(item.reference));
  assert.equal(insertEnquiry(app.db,{channel:'phone',queue:'general',subject:'Replay',external_key:'call:deletion-test'}).id,item.id);
  assert(app.db.prepare('SELECT deleted_at FROM enquiries WHERE id=?').get(item.id).deleted_at);
  await post(path+'/delete',{reason:'test',csrf:manager.csrf},manager.cookie);
  assert.equal(app.db.prepare('SELECT count(*) n FROM notes WHERE enquiry_id=?').get(item.id).n,1);
  assert.equal((await post(path+'/restore',{csrf:manager.csrf},manager.cookie)).status,303);
  assert.equal(app.db.prepare('SELECT deleted_at FROM enquiries WHERE id=?').get(item.id).deleted_at,'');
  assert(callReport(app.db,config,new Date(Date.now()-86400000),new Date(Date.now()+1000)).text.includes(item.reference));
});

test('deleted support enquiries are skipped by the HubSpot worker',async()=>{
  const db=openDatabase(':memory:');
  const item=insertEnquiry(db,{channel:'web',queue:'support',subject:'Test ticket'});
  db.prepare("UPDATE enquiries SET deleted_at=?,updated_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(new Date().toISOString(),item.id);
  let requests=0;
  await syncEnquiries(db,{...config,hubspot:{...config.hubspot,token:'test',pipeline:'0',stage:'1'}},async()=>{requests++;throw Error('Must not sync deleted record');});
  assert.equal(requests,0);db.close();
});

test('all queues and channels backfill into tickets without deleted or already-linked records',async()=>{
  const db=openDatabase(':memory:');
  const c={base,hubspot:{token:'fake',pipeline:'0',stage:'1',referenceProperty:'formtech_reference'}};
  for(const queue of ['sales','general','orders','accounts','support'])insertEnquiry(db,{channel:queue==='accounts'?'email':'web',queue,subject:queue,owner:'jason'});
  const call=insertEnquiry(db,{channel:'phone',queue:'sales',subject:'Old call'});
  db.prepare("UPDATE enquiries SET updated_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(call.id);
  const linked=insertEnquiry(db,{channel:'web',queue:'sales',subject:'Already linked'});
  db.prepare("UPDATE enquiries SET hubspot_ticket_id='9876' WHERE id=?").run(linked.id);
  const removed=insertEnquiry(db,{channel:'web',queue:'general',subject:'Deleted'});
  db.prepare("UPDATE enquiries SET deleted_at='2020-01-01' WHERE id=?").run(removed.id);
  const sent=[];
  const mock=async(url,opts)=>{
    if(url.includes('/properties/'))return new Response(JSON.stringify({hasUniqueValue:true}));
    if(opts.method==='POST'){sent.push(JSON.parse(opts.body).properties);return new Response(JSON.stringify({id:String(1000+sent.length)}));}
    return new Response('{}',{status:404});
  };
  await syncEnquiries(db,c,mock);assert.equal(sent.length,6);
  for(const queue of ['sales','general','orders','accounts','support'])assert(sent.some(p=>p.content.includes('Queue: '+queue)));
  assert(sent.every(p=>p.hs_pipeline==='0'&&p.hs_pipeline_stage==='1'));
  await syncEnquiries(db,c,mock);assert.equal(sent.length,6);db.close();
});
test('unsettled phone calls do not block website tickets behind the batch limit',async()=>{
  const db=openDatabase(':memory:');for(let i=0;i<12;i++)insertEnquiry(db,{channel:'phone',queue:'sales',subject:'In progress'});
  const web=insertEnquiry(db,{channel:'web',queue:'general',subject:'Repair enquiry'});
  let sent=0;
  await syncEnquiries(db,{base,hubspot:{token:'fake',pipeline:'0',stage:'1',referenceProperty:'formtech_reference'}},async(url,opts)=>{
    if(url.includes('/properties/'))return new Response(JSON.stringify({hasUniqueValue:true}));
    if(opts.method==='POST'){sent++;return new Response(JSON.stringify({id:'999'}));}
    return new Response('{}',{status:404});
  });
  assert.equal(sent,1);assert.equal(db.prepare('SELECT hubspot_ticket_id FROM enquiries WHERE id=?').get(web.id).hubspot_ticket_id,'999');db.close();
});

test('archived enquiries leave active lists while preserving accounts access restrictions',async()=>{
  const account=insertEnquiry(app.db,{channel:'web',queue:'accounts',subject:'Archived confidential invoice'});
  const sale=insertEnquiry(app.db,{channel:'web',queue:'sales',subject:'Archived sales request'});
  app.db.prepare('UPDATE enquiries SET archived_at=? WHERE id IN (?,?)').run(new Date().toISOString(),account.id,sale.id);
  const manager=await signIn('manager'),agent=await signIn('agent');
  const active=await(await fetch(base+'/staff',{headers:{Cookie:manager.cookie}})).text();assert(!active.includes('Archived sales request'));assert(!active.includes('Archived confidential invoice'));
  const archive=await(await fetch(base+'/staff/archived',{headers:{Cookie:agent.cookie}})).text();assert(archive.includes('Archived sales request'));assert(!archive.includes('Archived confidential invoice'));
  assert.equal((await fetch(base+'/staff/enquiries/'+account.id,{headers:{Cookie:agent.cookie}})).status,404);
  const detail=await(await fetch(base+'/staff/enquiries/'+sale.id,{headers:{Cookie:manager.cookie}})).text();assert(!detail.includes('Save changes'));assert(detail.includes('Continue working on the linked HubSpot ticket'));
  assert.equal((await post('/staff/enquiries/'+sale.id,{csrf:manager.csrf},manager.cookie)).status,409);
});
