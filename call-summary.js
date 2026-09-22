import {createHash} from 'node:crypto';
import {esc} from './core.js';

const zone='Pacific/Auckland', dayMs=86400000;
const parts=date=>Object.fromEntries(new Intl.DateTimeFormat('en-NZ',{
  timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
}).formatToParts(date).map(p=>[p.type,p.value]));
const dateKey=date=>{const p=parts(date);return `${p.year}-${p.month}-${p.day}`;};
const display=date=>new Intl.DateTimeFormat('en-NZ',{timeZone:zone,dateStyle:'medium',timeStyle:'short'}).format(new Date(date));

export function loadSummaryConfig(env) {
  const hour=Number(env.CALL_SUMMARY_HOUR||8);
  if(!Number.isInteger(hour)||hour<4||hour>23)throw Error('CALL_SUMMARY_HOUR must be 4 through 23 (NZ time)');
  const to=(env.CALL_SUMMARY_TO||'jason@formtech.co.nz').trim().toLowerCase();
  const from=(env.CALL_SUMMARY_FROM||'').trim();
  const email=/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/;
  if(!email.test(to)||(from&&!email.test(from)))throw Error('Invalid call summary email address');
  return {enabled:env.CALL_SUMMARY_ENABLED==='true',hour,to,from,apiKey:env.RESEND_API_KEY||''};
}
export const summaryReady=config=>!!(config.summary?.enabled&&config.summary.apiKey&&config.summary.from);

// Resolve this morning's local time independently of the current UTC offset.
// Hours 04:00-23:00 avoid NZ's missing/repeated daylight-saving transition hour.
export function summarySlot(now,hour=8) {
  const key=dateKey(now),[y,m,d]=key.split('-').map(Number),target=Date.UTC(y,m-1,d,hour);
  let utc=target;
  for(let i=0;i<3;i++) {
    const p=parts(new Date(utc));
    utc+=target-Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
  }
  return {key,start:new Date(utc-dayMs),end:new Date(utc)};
}
function outcome(call) {
  if(call.recording_sid)return 'Voicemail';
  if(call.accepted)return 'Answered';
  return ['completed','busy','failed','no-answer','canceled'].includes(call.call_status)?'Unanswered':'In progress / incomplete';
}
export function callReport(db,config,start,end) {
  const calls=db.prepare(`SELECT id,reference,created_at,phone,queue,store,owner,status,call_status,accepted,callback,recording_sid
    FROM enquiries WHERE deleted_at='' AND channel='phone' AND created_at>=? AND created_at<? ORDER BY created_at,id`).all(start.toISOString(),end.toISOString());
  const counts={total:calls.length,answered:0,voicemail:0,unanswered:0,incomplete:0,callbacks:0};
  const queues={};
  for(const call of calls){
    const state=outcome(call);
    counts[state==='Answered'?'answered':state==='Voicemail'?'voicemail':state==='Unanswered'?'unanswered':'incomplete']++;
    if(call.callback&&call.status!=='resolved')counts.callbacks++;
    queues[call.queue]=(queues[call.queue]||0)+1;
  }
  const window=`${display(start)} to ${display(end)} (New Zealand time)`;
  const headline=`${counts.total} incoming calls | ${counts.answered} answered | ${counts.voicemail} voicemail | ${counts.unanswered} unanswered | ${counts.incomplete} incomplete`;
  const shown=calls.slice(0,100);
  const items=shown.map(call=>({
    time:display(call.created_at),caller:call.phone||'Number withheld / unavailable',
    route:`${call.queue} / ${call.store==='any'?'General':call.store}`,owner:call.owner||'Unassigned',
    result:outcome(call),callback:call.callback&&call.status!=='resolved'?'Yes':'No',
    reference:call.reference,url:`${config.base}/staff/enquiries/${call.id}`
  }));
  const queueText=Object.entries(queues).map(([k,v])=>`${k}: ${v}`).join(' | ')||'No calls logged.';
  const note='Call outcomes and outstanding callbacks reflect the records when this report was prepared. This report covers calls logged in the stated 24-hour window; it is not a transcript of conversations.';
  const truncated=calls.length>100?`Showing the first 100 of ${calls.length} calls. All calls are included in the totals; open the staff dashboard for the remaining records.`:'';
  const text=[`FORMTECH 3D PRINTING - DAILY CALL SUMMARY`,window,headline,`Outstanding callbacks for these calls: ${counts.callbacks}`,queueText,'',...items.map(i=>`${i.time} | ${i.caller} | ${i.route} | ${i.result} | Owner: ${i.owner} | Callback: ${i.callback}\n${i.reference}: ${i.url}`),truncated,note,`Staff dashboard: ${config.base}/staff`].filter(Boolean).join('\n');
  const rows=items.map(i=>`<tr><td>${esc(i.time)}<br><a href="${esc(i.url)}">${esc(i.reference)}</a></td><td>${esc(i.caller)}</td><td>${esc(i.route)}<br>${esc(i.owner)}</td><td>${esc(i.result)}<br>Callback: ${i.callback}</td></tr>`).join('');
  const body=`<h1>Daily call summary</h1><p>${esc(window)}</p><p><b>${esc(headline)}</b></p><p><b>${counts.callbacks}</b> outstanding callbacks for these calls.</p><p>${esc(queueText)}</p>${items.length?`<table><thead><tr><th>Time / reference</th><th>Caller</th><th>Department / owner</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table>`:'<p>No incoming calls were logged in this period.</p>'}<p>${esc(truncated)}</p><p>${esc(note)}</p><p><a href="${esc(config.base)}/staff">Open staff dashboard</a></p>`;
  const html=`<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px/1.6 Arial,sans-serif;color:#263d53;margin:24px}h1{color:#345578}a{color:#9e471c}table{border-collapse:collapse;width:100%}td,th{padding:10px;text-align:left;border-bottom:1px solid #ddd;vertical-align:top}th{background:#fff0e2}</style></head><body>${body}</body></html>`;
  return {counts,body,text,html,subject:`Formtech call summary - ${dateKey(end)} - ${calls.length} incoming calls`};
}
export function initSummaryDb(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS call_summary_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS call_summary_jobs (
      day TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      first_attempt_at INTEGER, next_attempt_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
      provider_id TEXT NOT NULL DEFAULT '', accepted_at TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT ''
    );`);
}
export function summaryStatus(db,config) {
  initSummaryDb(db);
  return {ready:summaryReady(config),enabled:!!config.summary?.enabled,
    activated:db.prepare('SELECT enabled_at FROM call_summary_settings WHERE id=1').get()?.enabled_at||'',
    last:db.prepare('SELECT day,status,attempts,accepted_at,error FROM call_summary_jobs ORDER BY created_at DESC LIMIT 1').get()};
}
export async function runCallSummary(db,config,fetcher=fetch,now=new Date()) {
  if(!summaryReady(config))return {status:'not_configured'};
  initSummaryDb(db);
  const cfg=config.summary,nowMs=now.getTime();
  db.prepare('INSERT OR IGNORE INTO call_summary_settings(id,enabled_at) VALUES(1,?)').run(now.toISOString());
  const enabledAt=Date.parse(db.prepare('SELECT enabled_at FROM call_summary_settings WHERE id=1').get().enabled_at);
  const slot=summarySlot(now,cfg.hour);
  // First activation starts at the next morning. Restarts catch up today's due
  // summary, but do not create a burst of reports for earlier missed days.
  if(slot.end.getTime()<=nowMs&&slot.end.getTime()>enabledAt&&!db.prepare('SELECT 1 FROM call_summary_jobs WHERE day=?').get(slot.key)) {
    const report=callReport(db,config,slot.start,slot.end);
    const payload=JSON.stringify({from:`Formtech <${cfg.from}>`,to:[cfg.to],subject:report.subject,text:report.text,html:report.html});
    const account=createHash('sha256').update(config.base+'|'+cfg.to).digest('hex').slice(0,20);
    db.prepare('INSERT OR IGNORE INTO call_summary_jobs(day,created_at,payload,idempotency_key) VALUES(?,?,?,?)')
      .run(slot.key,now.toISOString(),payload,`formtech-calls/${account}/${slot.key}`);
  }
  // Never retry beyond the provider's 24-hour deduplication window. A one-hour
  // margin covers request latency and clock differences; staff can review it.
  db.prepare("UPDATE call_summary_jobs SET status='needs_review',error='Retry window expired; check email provider before resending' WHERE status='pending' AND first_attempt_at IS NOT NULL AND first_attempt_at<=?").run(nowMs-23*3600000);
  const job=db.prepare("SELECT * FROM call_summary_jobs WHERE status='pending' AND next_attempt_at<=? AND lease_until<=? ORDER BY day LIMIT 1").get(nowMs,nowMs);
  if(!job)return {status:'idle'};
  const claim=db.prepare("UPDATE call_summary_jobs SET lease_until=?,attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,?) WHERE day=? AND status='pending' AND lease_until<=? AND next_attempt_at<=?").run(nowMs+60000,nowMs,job.day,nowMs,nowMs);
  if(!claim.changes)return {status:'busy'};
  try {
    const response=await fetcher('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(15000),
      headers:{Authorization:`Bearer ${cfg.apiKey}`,'Content-Type':'application/json','Idempotency-Key':job.idempotency_key},body:job.payload});
    if(!response.ok)throw Error(`Email provider HTTP ${response.status}; check email configuration`);
    const result=await response.json();
    if(!/^[a-zA-Z0-9_-]{1,128}$/.test(String(result.id||'')))throw Error('Email provider returned no message identifier');
    db.prepare("UPDATE call_summary_jobs SET status='accepted',provider_id=?,accepted_at=?,lease_until=0,error='',payload='' WHERE day=?").run(String(result.id),now.toISOString(),job.day);
    return {status:'accepted',day:job.day};
  } catch(error) {
    const delay=Math.min(60,5*2**Math.min(job.attempts,4))*60000;
    const message=error.message.startsWith('Email provider')?error.message:'Email delivery interrupted; retry scheduled';
    db.prepare('UPDATE call_summary_jobs SET lease_until=0,next_attempt_at=?,error=? WHERE day=?').run(nowMs+delay,message,job.day);
    return {status:'retry_pending',day:job.day};
  }
}

// One manual test per NZ date; repeated clicks reuse the frozen job.
export function queueTestSummary(db,config,now=new Date()) {
  if(!summaryReady(config))return {status:'not_configured'};
  initSummaryDb(db);
  const key='test:'+dateKey(now),cfg=config.summary;
  const existing=db.prepare('SELECT status FROM call_summary_jobs WHERE day=?').get(key);
  if(existing)return {status:existing.status};
  const report=callReport(db,config,new Date(now.getTime()-dayMs),now);
  const account=createHash('sha256').update(config.base+'|'+cfg.to).digest('hex').slice(0,20);
  const payload=JSON.stringify({from:`Formtech <${cfg.from}>`,to:[cfg.to],subject:'[TEST] '+report.subject,text:report.text,html:report.html});
  db.prepare('INSERT OR IGNORE INTO call_summary_jobs(day,created_at,payload,idempotency_key) VALUES(?,?,?,?)')
    .run(key,now.toISOString(),payload,`formtech-calls/${account}/${key}`);
  return {status:'pending'};
}
