// Durable handoff of every active enquiry queue to HubSpot tickets.
// A unique ticket property prevents duplicate tickets after an ambiguous timeout.
export async function syncEnquiries(db,config,fetcher=fetch) {
  const hs=config.hubspot;
  if(!hs?.token||!hs.pipeline||!hs.stage)return;
  const now=Math.floor(Date.now()/1000);
  const items=db.prepare(`SELECT * FROM enquiries WHERE deleted_at=''
    AND hubspot_ticket_id='' AND hubspot_attempt_at<?
    AND (channel<>'phone' OR updated_at<=?) ORDER BY id LIMIT 10`).all(now-60,new Date(Date.now()-300000).toISOString());
  const request=async(path,options={})=>fetcher('https://api.hubapi.com'+path,{
    ...options,signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${hs.token}`,'Content-Type':'application/json'}});
  if(!items.length)return;
  // Refuse ticket creation unless server-side uniqueness is confirmed.
  try {
    const response=await request(`/crm/v3/properties/tickets/${encodeURIComponent(hs.referenceProperty)}`);
    if(!response.ok||(await response.json()).hasUniqueValue!==true)throw Error('Unique property missing');
  } catch {
    for(const item of items)db.prepare('UPDATE enquiries SET hubspot_error=?,hubspot_attempt_at=? WHERE id=?')
      .run('HubSpot setup required: verify the unique reference property and API permissions',now,item.id);
    return;
  }
  for(const item of items) {
    db.prepare('UPDATE enquiries SET hubspot_attempt_at=? WHERE id=?').run(now,item.id);
    try {
      let response=await request(`/crm/v3/objects/tickets/${encodeURIComponent(item.reference)}?idProperty=${encodeURIComponent(hs.referenceProperty)}`);
      if(response.status===404) {
        const content=[`Formtech reference: ${item.reference}`,`Channel: ${item.channel}`,`Name: ${item.name}`,
          `Email: ${item.email}`,`Phone: ${item.phone}`,`Store: ${item.store}`,`Queue: ${item.queue}`,`Local owner: ${item.owner||'Unassigned'}`,item.message,
          item.channel==='phone'?`Call: ${item.external_key}; state: ${item.call_status}; callback needed: ${item.callback?'yes':'no'}; recording ID: ${item.recording_sid||'none'}`:'',
          `Call/enquiry details: ${config.base}/staff/enquiries/${item.id}`].filter(Boolean).join('\n');
        response=await request('/crm/v3/objects/tickets',{method:'POST',body:JSON.stringify({properties:{
          subject:`[${item.reference}] ${item.subject}`,content,hs_pipeline:hs.pipeline,
          hs_pipeline_stage:hs.stage,[hs.referenceProperty]:item.reference}})});
      }
      if(!response.ok)throw Error(`HubSpot HTTP ${response.status}; check integration configuration and retry`);
      const result=await response.json();
      if(!/^\d+$/.test(String(result.id)))throw Error('HubSpot returned no valid ticket ID');
      db.prepare("UPDATE enquiries SET hubspot_ticket_id=?,hubspot_error='' WHERE id=?").run(String(result.id),item.id);
    } catch(error) {
      // No provider response bodies, tokens or customer details are put in logs.
      db.prepare('UPDATE enquiries SET hubspot_error=? WHERE id=?').run(
        error.message.startsWith('HubSpot')?error.message:'HubSpot delivery interrupted; will retry',item.id);
    }
  }
}

// Read HubSpot ownership/status back into the local workspace. Never delete a ticket.
export async function syncTicketProgress(db,config,fetcher=fetch,now=new Date()) {
  const hs=config.hubspot;
  if(!hs?.token||!hs.pipeline||!hs.stage)return;
  const seconds=Math.floor(now.getTime()/1000);
  const items=db.prepare("SELECT id,hubspot_ticket_id FROM enquiries WHERE deleted_at='' AND archived_at='' AND hubspot_ticket_id<>'' AND hubspot_checked_at<? ORDER BY hubspot_checked_at,id LIMIT 50").all(seconds-60);
  if(!items.length)return;
  for(const item of items)db.prepare('UPDATE enquiries SET hubspot_checked_at=? WHERE id=?').run(seconds,item.id);
  try {
    const response=await fetcher('https://api.hubapi.com/crm/v3/objects/tickets/batch/read',{
      method:'POST',signal:AbortSignal.timeout(15000),
      headers:{Authorization:`Bearer ${hs.token}`,'Content-Type':'application/json'},
      body:JSON.stringify({properties:['hubspot_owner_id','hs_pipeline_stage','hs_pipeline'],inputs:items.map(i=>({id:i.hubspot_ticket_id}))})
    });
    if(!response.ok)throw Error('Could not check HubSpot ticket progress; retry scheduled');
    const body=await response.json();
    if(!Array.isArray(body.results))throw Error('Invalid HubSpot progress response; retry scheduled');
    const results=new Map(body.results.map(r=>[String(r.id),r]));
    for(const item of items) {
      const result=results.get(item.hubspot_ticket_id),props=result?.properties;
      if(!props||result.archived||typeof props.hs_pipeline_stage!=='string'||typeof props.hs_pipeline!=='string'||!Object.hasOwn(props,'hubspot_owner_id')) {
        db.prepare('UPDATE enquiries SET hubspot_sync_error=? WHERE id=?').run('Ticket progress unavailable; kept in active enquiries',item.id);continue;
      }
      const owner=typeof props.hubspot_owner_id==='string'?props.hubspot_owner_id.trim():'',stage=props.hs_pipeline_stage;
      const archive=/^[1-9][0-9]*$/.test(owner)&&props.hs_pipeline===hs.pipeline&&stage!==''&&stage!==hs.stage;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("UPDATE enquiries SET hubspot_owner_id=?,hubspot_stage=?,hubspot_sync_error='' WHERE id=? AND deleted_at=''").run(owner,stage,item.id);
        if(archive) {
          const updated=db.prepare("UPDATE enquiries SET archived_at=? WHERE id=? AND deleted_at='' AND archived_at=''").run(now.toISOString(),item.id);
          if(updated.changes)db.prepare('INSERT INTO notes(enquiry_id,author,created_at,body) VALUES(?,?,?,?)').run(item.id,'HubSpot sync',now.toISOString(),`Archived after HubSpot ticket ${item.hubspot_ticket_id} was assigned to owner ${owner} and moved from New to stage ${stage}.`);
        }
        db.exec('COMMIT');
      } catch(error){db.exec('ROLLBACK');throw error;}
    }
  } catch {
    for(const item of items)db.prepare('UPDATE enquiries SET hubspot_sync_error=? WHERE id=?').run('Unable to check HubSpot ticket progress; retry scheduled',item.id);
  }
}
