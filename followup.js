import {createHash} from 'node:crypto';
import {esc} from './core.js';
const fiveHours=5*3600000;
export function initFollowups(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS followup_jobs (
    enquiry_id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', payload TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, recipient TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    first_attempt_at INTEGER, next_attempt_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
    accepted_at TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT ''
  )`);
}
export function needsFollowup(item,config,now) {
  if(item.channel!=='phone'||!item.callback||item.status!=='new'||item.deleted_at||item.archived_at)return false;
  if(Date.parse(item.created_at)>now- fiveHours)return false;
  // Don't guess progress when HubSpot is unavailable or its cached state is stale.
  if(item.hubspot_ticket_id&&(item.hubspot_sync_error||item.hubspot_checked_at*1000<now-180000||item.hubspot_stage!==config.hubspot.stage))return false;
  return true;
}
export async function runFollowups(db,config,fetcher=fetch,now=new Date()) {
  if(!config.followupEnabled||!config.summary?.apiKey||!config.summary.from)return;
  initFollowups(db);
  const time=now.getTime();
  const items=db.prepare("SELECT * FROM enquiries WHERE channel='phone' AND callback=1 AND status='new' AND deleted_at='' AND archived_at='' AND created_at<=? AND id NOT IN (SELECT enquiry_id FROM followup_jobs) ORDER BY created_at LIMIT 50").all(new Date(time-fiveHours).toISOString());
  for(const item of items) {
    if(!needsFollowup(item,config,time))continue;
    const recipient=item.store==='auckland'?'martin@formtech.co.nz':'jason@formtech.co.nz';
    const location=item.store==='auckland'?'Auckland':item.store==='christchurch'?'Christchurch':'General / location not selected';
    const url=`${config.base}/staff/enquiries/${item.id}`;
    const text=`A callback has been waiting at least five hours without a recorded status change.\n\nReference: ${item.reference}\nLocation: ${location}\nCaller: ${item.name||'Unknown'}\nPhone: ${item.phone||'Unavailable'}\nEnquiry: ${item.subject}\n\nPlease follow up and update the status or mark the callback complete.\n${url}`;
    const payload=JSON.stringify({from:`Formtech <${config.summary.from}>`,to:[recipient],subject:`Callback overdue - ${location} - ${item.reference}`,text,html:`<h1>Callback needs follow-up</h1><p style="white-space:pre-line">${esc(text)}</p><p><a href="${esc(url)}">Open enquiry</a></p>`});
    const key=createHash('sha256').update(config.base+'|'+item.reference).digest('hex');
    db.prepare('INSERT OR IGNORE INTO followup_jobs(enquiry_id,payload,idempotency_key,recipient) VALUES(?,?,?,?)').run(item.id,payload,`formtech-followup/${key}`,recipient);
  }
  db.prepare("UPDATE followup_jobs SET status='needs_review',error='Retry window expired; check provider before resending' WHERE status='pending' AND first_attempt_at<=?").run(time-23*3600000);
  const jobs=db.prepare("SELECT * FROM followup_jobs WHERE status='pending' AND next_attempt_at<=? AND lease_until<=? ORDER BY enquiry_id LIMIT 10").all(time,time);
  for(const job of jobs) {
    const item=db.prepare('SELECT * FROM enquiries WHERE id=?').get(job.enquiry_id);
    if(!item||item.deleted_at||item.archived_at||!item.callback||item.status!=='new'||(item.hubspot_stage&&item.hubspot_stage!==config.hubspot.stage)) {
      db.prepare("UPDATE followup_jobs SET status='cancelled',payload='' WHERE enquiry_id=? AND status='pending'").run(job.enquiry_id);continue;
    }
    if(!needsFollowup(item,config,time))continue;
    const claimed=db.prepare("UPDATE followup_jobs SET lease_until=?,first_attempt_at=COALESCE(first_attempt_at,?),attempts=attempts+1 WHERE enquiry_id=? AND status='pending' AND lease_until<=?").run(time+60000,time,item.id,time);
    if(!claimed.changes)continue;
    try {
      const response=await fetcher('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${config.summary.apiKey}`,'Content-Type':'application/json','Idempotency-Key':job.idempotency_key},body:job.payload});
      if(!response.ok)throw Error('Provider rejected request');
      const result=await response.json();if(!result.id)throw Error('Missing message identifier');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("UPDATE followup_jobs SET status='accepted',accepted_at=?,payload='',error='',lease_until=0 WHERE enquiry_id=?").run(now.toISOString(),item.id);
        db.prepare('INSERT INTO notes(enquiry_id,author,created_at,body) VALUES(?,?,?,?)').run(item.id,'Callback reminder',now.toISOString(),`Five-hour reminder accepted by email provider for ${job.recipient}. Inbox delivery is not confirmed.`);
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
    }catch {
      db.prepare('UPDATE followup_jobs SET next_attempt_at=?,lease_until=0,error=? WHERE enquiry_id=?').run(time+Math.min(60,5*2**Math.min(job.attempts,4))*60000,'Email delivery not confirmed; retry scheduled',item.id);
    }
  }
}
