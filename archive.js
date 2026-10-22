// Archive locally without destroying call history. HubSpot closure is a durable job.
export function archiveEnquiry(db,id,author,reason,closeHubspot=false,now=new Date()) {
  const time=now.toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const changed=db.prepare("UPDATE enquiries SET archived_at=?,archive_reason=?,status='resolved',callback=0,updated_at=?,hubspot_close_state=CASE WHEN ? THEN CASE WHEN hubspot_close_state='done' THEN 'done' ELSE 'pending' END ELSE hubspot_close_state END WHERE id=? AND deleted_at='' AND (archived_at='' OR (? AND hubspot_close_state=''))")
      .run(time,reason,time,closeHubspot?1:0,id,closeHubspot?1:0);
    if(changed.changes)db.prepare('INSERT INTO notes(enquiry_id,author,created_at,body) VALUES(?,?,?,?)').run(id,author,time,reason+(closeHubspot?' HubSpot closure queued.':''));
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}

export async function syncClosedTickets(db,config,fetcher=fetch,now=new Date()) {
  if(!config.hubspot?.token)return;
  const seconds=Math.floor(now.getTime()/1000);
  const items=db.prepare("SELECT * FROM enquiries WHERE deleted_at='' AND hubspot_close_state='pending' AND hubspot_ticket_id<>'' AND hubspot_close_attempt<? ORDER BY hubspot_close_attempt,id LIMIT 10").all(seconds-60);
  const request=(path,options={})=>fetcher('https://api.hubapi.com'+path,{...options,signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${config.hubspot.token}`,'Content-Type':'application/json'}});
  for(const item of items) {
    db.prepare('UPDATE enquiries SET hubspot_close_attempt=? WHERE id=?').run(seconds,item.id);
    try {
      const path='/crm/v3/objects/tickets/'+encodeURIComponent(item.hubspot_ticket_id);
      const response=await request(path+'?properties=hs_pipeline,hs_pipeline_stage');
      if(!response.ok)throw Error('read');
      const ticket=await response.json();
      if(String(ticket.id)!==item.hubspot_ticket_id||ticket.archived||!ticket.properties?.hs_pipeline)throw Error('ticket');
      const stagesResponse=await request('/crm/v3/pipelines/tickets/'+encodeURIComponent(ticket.properties.hs_pipeline)+'/stages');
      if(!stagesResponse.ok)throw Error('stages');
      const stages=(await stagesResponse.json()).results;
      if(!Array.isArray(stages))throw Error('stages');
      const closed=stages.filter(s=>!s.archived&&s.metadata?.ticketState==='CLOSED').sort((a,b)=>a.displayOrder-b.displayOrder);
      if(!closed.length)throw Error('no closed stage');
      if(!closed.some(s=>String(s.id)===ticket.properties.hs_pipeline_stage)) {
        const patched=await request(path,{method:'PATCH',body:JSON.stringify({properties:{hs_pipeline_stage:String(closed[0].id)}})});
        if(!patched.ok)throw Error('patch');
      }
      db.prepare("UPDATE enquiries SET hubspot_close_state='done',hubspot_close_error='' WHERE id=?").run(item.id);
    }catch {
      db.prepare('UPDATE enquiries SET hubspot_close_error=? WHERE id=?').run('HubSpot closure pending; check ticket and pipeline permissions. Automatic retry scheduled.',item.id);
    }
  }
}
