// Durable handoff of new support enquiries. HubSpot owns support resolution.
// A unique ticket property prevents duplicate tickets after an ambiguous timeout.
export async function syncSupport(db,config,fetcher=fetch) {
  const hs=config.hubspot;
  if(!hs?.token||!hs.pipeline||!hs.stage)return;
  const now=Math.floor(Date.now()/1000);
  const items=db.prepare(`SELECT * FROM enquiries WHERE deleted_at='' AND queue='support' AND channel IN ('web','phone')
    AND hubspot_ticket_id='' AND hubspot_attempt_at<? ORDER BY id LIMIT 10`).all(now-60);
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
    // Let phone events and recording callbacks settle before creating the ticket.
    if(item.channel==='phone'&&Date.parse(item.updated_at)>Date.now()-300000)continue;
    db.prepare('UPDATE enquiries SET hubspot_attempt_at=? WHERE id=?').run(now,item.id);
    try {
      let response=await request(`/crm/v3/objects/tickets/${encodeURIComponent(item.reference)}?idProperty=${encodeURIComponent(hs.referenceProperty)}`);
      if(response.status===404) {
        const content=[`Formtech reference: ${item.reference}`,`Channel: ${item.channel}`,`Name: ${item.name}`,
          `Email: ${item.email}`,`Phone: ${item.phone}`,`Store: ${item.store}`,item.message,
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
