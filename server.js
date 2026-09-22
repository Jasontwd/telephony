import http from 'node:http';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {loadConfig,openDatabase,insertEnquiry,limited,signature,equal,hmac,checkPassword,hashPassword,esc,queues,stores,statuses,isOpen,canSee} from './core.js';
import * as views from './views.js';
import {syncSupport} from './hubspot.js';

const fail = (status,message) => { throw Object.assign(Error(message),{status}); };
const cookieValue = (req,key) => (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(key+'='))?.slice(key.length+1)||'';
async function readBody(req) {
  let size=0; const chunks=[];
  for await (const chunk of req) { size+=chunk.length; if(size>32768) fail(413,'Request is too large'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
export function createApp(config=loadConfig(), db=openDatabase(config.dbPath)) {
  const css=readFileSync(new URL('./static/style.css',import.meta.url));
  const logo=readFileSync(new URL('./static/formtech-logo.png',import.meta.url));
  const embedJs=readFileSync(new URL('./static/embed.js',import.meta.url));
  const dummyHash=hashPassword(randomBytes(24).toString('hex'));
  const updateCall=(id,fields)=> {
    const keys=Object.keys(fields);
    db.prepare(`UPDATE enquiries SET ${keys.map(k=>`${k}=?`).join(',')},updated_at=? WHERE id=?`)
      .run(...Object.values(fields),new Date().toISOString(),id);
  };
  const xml = body => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
  const say = text => `<Say language="en-AU">${esc(text)}</Say>`;
  const url = path => config.base+path;
  const voicemail = item => {
    updateCall(item.id,{callback:1});
    return say('Please leave your name, phone number and a short message after the beep. Your message will be recorded for the Formtech team to follow up.')+
      `<Record maxLength="120" timeout="5" playBeep="true" action="${url('/voice/thanks')}" method="POST" recordingStatusCallback="${url('/voice/recording')}" recordingStatusCallbackMethod="POST"/>`+say('Thank you. Goodbye.')+'<Hangup/>';
  };
  const menu=attempt=>`<Gather numDigits="1" timeout="7" actionOnEmptyResult="true" action="${url('/voice/select?attempt='+attempt)}" method="POST">`+
    say('Thanks for calling Formtech. For Auckland sales and demos, press 1. For Christchurch sales and demos, press 2. For technical support and repairs, press 3. For orders and deliveries, press 4. For accounts and payments, press 5.')+'</Gather>';
  const dial=(item,route,backup=false)=> {
    const dest=backup?route.backup:route.phone;
    if(!dest||!isOpen(config,route.store)) return voicemail(item);
    return `<Dial timeout="20" answerOnBridge="true" callerId="${esc(config.publicPhone)}" action="${url('/voice/dial-ended?backup='+(backup?'1':'0'))}" method="POST"><Number url="${url('/voice/confirm?parent='+encodeURIComponent(item.external_key.slice(5)))}" method="POST">${esc(dest)}</Number></Dial>`;
  };
  async function handler(req,res) {
    const embedded=['/embed','/embed/enquiries'].includes(new URL(req.url,config.base).pathname);
    res.setHeader('X-Content-Type-Options','nosniff');
    // no-referrer makes browsers send Origin: null on form POSTs, which our
    // origin check correctly rejects. Preserve same-origin form provenance
    // while still withholding referrers from external websites.
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors "+(embedded?"'self' https://formtech.co.nz https://www.formtech.co.nz":"'none'")+"; base-uri 'none'");
    res.setHeader('Cache-Control','no-store');
    if(config.production) res.setHeader('Strict-Transport-Security','max-age=31536000');
    const send=(code,body,type='text/html; charset=utf-8')=>{res.writeHead(code,{'Content-Type':type});res.end(body);};
    const redirect=path=>{res.writeHead(303,{Location:path});res.end();};
    const setCookie=(key,value,maxAge)=>res.setHeader('Set-Cookie',`${key}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.production?'; Secure':''}`);
    try {
      const requestUrl=new URL(req.url,config.base), path=requestUrl.pathname;
      if(req.method==='GET'&&path==='/health') {db.prepare('SELECT 1').get();return send(200,'ok','text/plain');}
      if(req.method==='GET'&&path==='/style.css') return send(200,css,'text/css');
      if(req.method==='GET'&&path==='/formtech-logo.png') return send(200,logo,'image/png');
      if(req.method==='GET'&&path==='/embed.js') return send(200,embedJs,'text/javascript');
      const now=Math.floor(Date.now()/1000);
      db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
      const session=db.prepare('SELECT * FROM sessions WHERE token=?').get(hmac(config.secret,cookieValue(req,'session')));
      const user=!embedded&&session&&config.users.find(u=>u.username===session.username);
      const ip=config.production&&process.env.FLY_APP_NAME ? String(req.headers['fly-client-ip']||req.socket.remoteAddress) : req.socket.remoteAddress;
      const ipKey=hmac(config.secret,ip||'unknown');
      const body=req.method==='POST'?await readBody(req):'';
      const form=new URLSearchParams(body);
      const value=(key,max=5000)=>{const text=form.get(key)||'';if(text.length>max)fail(400,'Field is too long');return text.trim();};
      const publicCsrf=()=> {
        let token=cookieValue(req,'form');
        const [stamp,nonce,sig]=token.split('.');
        if(!stamp||!nonce||!sig||Number(stamp)<now-3600||Number(stamp)>now||!equal(sig,hmac(config.secret,stamp+'.'+nonce))) {
          const raw=now+'.'+randomBytes(20).toString('hex');token=raw+'.'+hmac(config.secret,raw);setCookie('form',token,3600);
        }
        return token;
      };
      // Public iframe forms cannot rely on third-party cookies. Use a short-lived,
      // purpose-bound signed token and the same strict Origin check; never use
      // this token for staff or other cookie-authenticated actions.
      const embedToken=()=>{
        const raw=now+'.'+randomBytes(20).toString('hex');
        return raw+'.'+hmac(config.secret,'embed:'+raw);
      };
      const checkEmbedToken=()=>{
        if(req.headers.origin!==config.base)fail(403,'Invalid request origin');
        const token=value('csrf',200),parts=token.split('.');
        const [stamp,nonce,sig]=parts;
        if(parts.length!==3||!/^\d+$/.test(stamp)||!/[a-f0-9]{40}/.test(nonce)||
          Number(stamp)<now-3600||Number(stamp)>now||!equal(sig,hmac(config.secret,'embed:'+stamp+'.'+nonce)))
          fail(403,'Form expired. Reload the page and try again.');
      };
      const checkCsrf=()=> {
        if(req.headers.origin && req.headers.origin!==config.base) fail(403,'Invalid request origin');
        const expected=user?session.csrf:publicCsrf();
        if(!equal(value('csrf',200),expected))fail(403,'Form expired. Reload the page and try again.');
      };
      if(path.startsWith('/voice/')) {
        if(req.method!=='POST')fail(405,'POST required');
        if(!config.enabled)fail(503,'Phone service is not enabled');
        if(!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))fail(415,'Form body required');
        if(!equal(req.headers['x-twilio-signature']||'',signature(config.token,config.base+req.url,form))||value('AccountSid',64)!==config.account)fail(403,'Invalid signature');
        const sid=value('CallSid',64);
        if(!/^CA[a-fA-F0-9]{32}$/.test(sid))fail(400,'Invalid call identifier');
        if(path==='/voice/confirm'||path==='/voice/accept') {
          const parent=requestUrl.searchParams.get('parent')||'';
          if(value('ParentCallSid',64)!==parent)fail(403,'Invalid parent call');
          const item=db.prepare('SELECT * FROM enquiries WHERE external_key=?').get('call:'+parent);
          if(!item)fail(404,'Call not found');
          if(path==='/voice/confirm')return send(200,xml(`<Gather numDigits="1" timeout="7" action="${esc(url('/voice/accept?parent='+parent))}" method="POST">${say('Formtech '+item.queue+' call. Press 1 to accept.')}</Gather><Hangup/>`),'text/xml');
          if(value('Digits',8)==='1') {updateCall(item.id,{accepted:1,callback:0,call_status:'answered'});return send(200,xml(''),'text/xml');}
          return send(200,xml('<Hangup/>'),'text/xml');
        }
        let item=db.prepare('SELECT * FROM enquiries WHERE external_key=?').get('call:'+sid);
        if(!item && ['/voice/incoming','/voice/status'].includes(path))item=insertEnquiry(db,{external_key:'call:'+sid,channel:'phone',phone:value('From',40),queue:'general',subject:'Incoming phone enquiry',callback:1});
        if(!item)fail(404,'Call not found');
        if(path==='/voice/incoming')return send(200,xml(menu(0)),'text/xml');
        if(path==='/voice/select') {
          const route=config.routes[value('Digits',8)];
          if(!route) return send(200,xml(requestUrl.searchParams.get('attempt')==='0'?say('Sorry, please choose one of the following options.')+menu(1):voicemail(item)),'text/xml');
          updateCall(item.id,{queue:route.queue,store:route.store,owner:config.users.some(u=>u.username===route.owner)?route.owner:'',subject:route.label,call_status:'routing'});
          item=db.prepare('SELECT * FROM enquiries WHERE id=?').get(item.id);
          return send(200,xml(dial(item,route)),'text/xml');
        }
        if(path==='/voice/dial-ended') {
          if(item.accepted)return send(200,xml(say('Thank you for calling Formtech.')+'<Hangup/>'),'text/xml');
          updateCall(item.id,{call_status:value('DialCallStatus',40)||'unanswered',callback:1});
          const route=Object.values(config.routes).find(r=>r.queue===item.queue&&r.store===item.store);
          return send(200,xml(route?.backup&&requestUrl.searchParams.get('backup')!=='1'?dial(item,route,true):voicemail(item)),'text/xml');
        }
        if(path==='/voice/recording') {
          const recording=value('RecordingSid',64);
          if(value('RecordingStatus',40)==='completed'&&/^RE[a-fA-F0-9]{32}$/.test(recording)&&item.recording_sid!==recording)updateCall(item.id,{recording_sid:recording,callback:1,call_status:'voicemail'});
          return send(200,xml(''),'text/xml');
        }
        if(path==='/voice/status') {
          const state=value('CallStatus',40);
          if(['completed','busy','failed','no-answer','canceled'].includes(state))updateCall(item.id,{call_status:item.recording_sid?'voicemail':item.accepted?'answered':state});
          return send(200,xml(''),'text/xml');
        }
        if(path==='/voice/thanks')return send(200,xml(say('Thank you. The Formtech team will follow up during business hours.')+'<Hangup/>'),'text/xml');
        fail(404,'Not found');
      }
      if(path==='/hooks/email'&&req.method==='POST') {
        if(!config.emailSecret)fail(503,'Email bridge is not configured');
        const timestamp=String(req.headers['x-formtech-timestamp']||'');
        if(!/^\d{10}$/.test(timestamp)||Math.abs(now-Number(timestamp))>300||!equal(req.headers['x-formtech-signature']||'',hmac(config.emailSecret,timestamp+'.'+body)))fail(403,'Invalid email signature');
        let mail;try{mail=JSON.parse(body);}catch{fail(400,'Invalid JSON');}
        if(!mail||typeof mail!=='object')fail(400,'Invalid email');
        // support@ stays connected directly to HubSpot: never re-import its emails.
        if(mail.to?.toLowerCase()==='support@formtech.co.nz')return send(202,JSON.stringify({handledBy:'hubspot',imported:false}),'application/json');
        const mailboxes={'orders@formtech.co.nz':'orders','accounts@formtech.co.nz':'accounts'};
        for(const key of ['id','to','from','subject','text'])if(typeof mail[key]!=='string'||!mail[key].trim()||mail[key].length>(key==='text'?20000:500))fail(400,'Invalid email fields');
        if(!mailboxes[mail.to.toLowerCase()])fail(400,'Unknown mailbox');
        const item=insertEnquiry(db,{external_key:'email:'+mail.id,channel:'email',email:mail.from,queue:mailboxes[mail.to.toLowerCase()],subject:mail.subject,message:mail.text});
        return send(200,JSON.stringify({reference:item.reference}),'application/json');
      }
      if(req.method==='GET'&&path==='/') return send(200,views.contact(config,user?session.csrf:publicCsrf()));
      if(req.method==='GET'&&path==='/embed') return send(200,views.contact(config,embedToken(),'',true));
      if(req.method==='POST'&&(path==='/enquiries'||path==='/embed/enquiries')) {
        if(embedded)checkEmbedToken();else checkCsrf();
        if(limited(db,'form:'+ipKey,10,3600))fail(429,'Too many enquiries. Please try again later.');
        if(value('website',200))fail(400,'Unable to submit this form');
        const item={name:value('name',120),email:value('email',254),phone:value('phone',40),queue:value('queue',20),store:value('store',20),subject:value('subject',180),message:value('message',5000),channel:'web'};
        if(!item.name||!item.subject||!item.message||(!item.email&&!item.phone)||!queues.includes(item.queue)||!stores.includes(item.store)||
          (item.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email))||(item.phone&&!/^[+\d\s().-]{6,40}$/.test(item.phone)))fail(400,'Please include your name, a valid email or phone, subject and message.');
        item.message=[value('company',120)&&'Company: '+value('company',120),value('product',180)&&'Order / model: '+value('product',180),item.message].filter(Boolean).join('\n\n');
        const desired=item.store==='auckland'?'martin':item.store==='christchurch'?'jason':'';
        item.owner=item.queue!=='accounts'&&config.users.some(u=>u.username===desired&&u.role!=='accounts')?desired:'';
        item.external_key='web:'+hmac(config.secret,value('csrf',200)+JSON.stringify(item));
        const saved=insertEnquiry(db,item);
        return send(201,views.page('Enquiry received',`<div class="narrow"><div class="eyebrow">ENQUIRY RECEIVED</div><h1>Thanks. We’ll be in touch.</h1><p>Your reference is <strong>${esc(saved.reference)}</strong>. Our team will follow up during business hours.</p><a href="${embedded?'/embed':'/'}">${embedded?'Send another enquiry':'Return to contact page'}</a></div>`,null,null,embedded));
      }
      if(path==='/login'&&req.method==='GET')return user?redirect('/staff'):send(200,views.login(publicCsrf()));
      if(path==='/login'&&req.method==='POST') {
        checkCsrf();
        const username=value('username',40).toLowerCase();
        if(limited(db,'login:'+ipKey,15,900)||limited(db,'user:'+hmac(config.secret,username),30,900))fail(429,'Too many sign-in attempts. Try again in 15 minutes.');
        const found=config.users.find(u=>u.username===username);
        const password=form.get('password')||'';
        if(password.length>256)fail(400,'Password is too long');
        const valid=checkPassword(password,found?.passwordHash||dummyHash);
        if(!found||!valid)return send(401,views.login(publicCsrf(),'Username or password was not recognised.'));
        const token=randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hmac(config.secret,token),found.username,randomBytes(24).toString('hex'),now+28800);
        setCookie('session',token,28800);return redirect('/staff');
      }
      if(path.startsWith('/staff')||path==='/logout') {
        if(!user)return redirect('/login');
        if(req.method==='POST')checkCsrf();
        if(path==='/logout'&&req.method==='POST'){db.prepare('DELETE FROM sessions WHERE token=?').run(session.token);setCookie('session','',0);return redirect('/login');}
        if(path==='/staff'&&req.method==='GET') {
          const where=user.role==='manager'?'1=1':user.role==='accounts'?"queue='accounts'":"queue<>'accounts'";
          return send(200,views.dashboard(db.prepare(`SELECT * FROM enquiries WHERE ${where} ORDER BY created_at DESC`).all(),user,session.csrf,Object.fromEntries(requestUrl.searchParams)));
        }
        if(path==='/staff/routing'&&req.method==='GET')return send(200,views.routing(config,user,session.csrf));
        const match=path.match(/^\/staff\/enquiries\/(\d+)$/);
        if(match) {
          const item=db.prepare('SELECT * FROM enquiries WHERE id=?').get(Number(match[1]));
          if(!item||!canSee(user,item))fail(404,'Enquiry not found');
          if(req.method==='GET')return send(200,views.detail(item,db.prepare('SELECT * FROM notes WHERE enquiry_id=? ORDER BY id DESC').all(item.id),config.users,user,session.csrf,config));
          if(req.method==='POST') {
            const state=value('status',30),owner=value('owner',40),due=value('due_at',10),outcome=value('outcome',20),quote=value('quote_value',30),callback=value('callback',10);
            const assigned=config.users.find(u=>u.username===owner);
            if(!statuses.includes(state)||(owner&&(!assigned||!canSee(assigned,item)))||!['','qualified','quoted','won','lost'].includes(outcome)||!['needed','complete'].includes(callback)||
              (due&&(!/^\d{4}-\d{2}-\d{2}$/.test(due)||Number.isNaN(Date.parse(due))||new Date(due).toISOString().slice(0,10)!==due))||
              (quote&&(!Number.isFinite(Number(quote))||Number(quote)<0||Number(quote)>100000000)))fail(400,'Invalid update');
            const next=value('next_action',500),note=value('note',5000),time=new Date().toISOString();
            db.exec('BEGIN IMMEDIATE');
            try {
              db.prepare('UPDATE enquiries SET owner=?,status=?,due_at=?,outcome=?,quote_value=?,callback=?,next_action=?,updated_at=? WHERE id=?')
                .run(owner,state,due,outcome,quote?Number(quote):null,callback==='needed'?1:0,next,time,item.id);
              db.prepare('INSERT INTO notes(enquiry_id,author,created_at,body) VALUES(?,?,?,?)').run(item.id,user.username,time,
                `Status: ${state}; owner: ${owner||'unassigned'}; due: ${due||'none'}; callback: ${callback}; outcome: ${outcome||'none'}; quote: ${quote||'none'}; next action: ${next||'none'}`+(note?'\n\n'+note:''));
              db.exec('COMMIT');
            } catch(e) {db.exec('ROLLBACK');throw e;}
            return redirect(path);
          }
        }
      }
      fail(404,'Page not found');
    } catch(error) {
      if(!error.status) console.error('Request failed:',error.code||error.name);
      send(error.status||500,views.page('Unable to complete request',`<h1>${error.status||500}</h1><p>${esc(error.status?error.message:'Please try again shortly.')}</p><a href="${embedded?'/embed':'/'}">Return to contact page</a>`,null,null,embedded));
    }
  }
  const server=http.createServer(handler);
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,db};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  const config=loadConfig();
  const {server,db}=createApp(config);
  let syncing=false;
  const timer=setInterval(async()=>{if(syncing)return;syncing=true;try{await syncSupport(db,config);}catch(e){console.error('Support handoff failed');}finally{syncing=false;}},30000);
  timer.unref();
  server.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>console.log('Formtech service listening'));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{clearInterval(timer);server.close(()=>process.exit(0));});
}
