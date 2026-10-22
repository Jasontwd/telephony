// Recover completed Twilio transcripts if callback delivery was missed.
// This reads existing results; it does not purchase or request new transcription.
export async function recoverTranscripts(db,config,fetcher=fetch,now=new Date()) {
  if(!/^AC[a-fA-F0-9]{32}$/.test(config.account||'')||!config.token)return;
  const seconds=Math.floor(now.getTime()/1000);
  const items=db.prepare("SELECT id,recording_sid FROM enquiries WHERE deleted_at='' AND channel='phone' AND recording_sid<>'' AND voicemail_transcript='' AND transcription_checked_at<? ORDER BY transcription_checked_at,id LIMIT 10").all(seconds-300);
  for(const item of items) {
    db.prepare('UPDATE enquiries SET transcription_checked_at=? WHERE id=?').run(seconds,item.id);
    if(!/^RE[a-fA-F0-9]{32}$/.test(item.recording_sid))continue;
    try {
      const response=await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${config.account}/Recordings/${item.recording_sid}/Transcriptions.json?PageSize=50`,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Basic '+Buffer.from(config.account+':'+config.token).toString('base64')}});
      if(!response.ok)throw Error(`Twilio transcript lookup HTTP ${response.status}; check recording access`);
      const body=await response.json();if(!Array.isArray(body.transcriptions))throw Error('Twilio returned no transcription list');
      const records=body.transcriptions.filter(t=>t.account_sid===config.account&&t.recording_sid===item.recording_sid);
      const transcript=records.find(t=>t.status==='completed'&&typeof t.transcription_text==='string'&&t.transcription_text.trim()&&/^TR[a-fA-F0-9]{32}$/.test(t.sid||''));
      if(transcript) {
        db.prepare("UPDATE enquiries SET voicemail_transcript=?,transcription_sid=?,transcription_status='completed',transcription_error='' WHERE id=? AND recording_sid=? AND voicemail_transcript='' AND deleted_at=''").run(transcript.transcription_text.slice(0,12000),transcript.sid,item.id,item.recording_sid);
      } else {
        const message=records.some(t=>t.status==='failed')?'Twilio could not transcribe this recording. Listen to the audio.':'No completed transcript is available from Twilio yet. Short or silent recordings may not produce text.';
        db.prepare("UPDATE enquiries SET transcription_error=? WHERE id=? AND voicemail_transcript=''").run(message,item.id);
      }
    } catch(error) {
      const message=error.message?.startsWith('Twilio ')?error.message:'Twilio transcription lookup interrupted; will retry';
      db.prepare("UPDATE enquiries SET transcription_error=? WHERE id=? AND voicemail_transcript=''").run(message,item.id);
    }
  }
}
