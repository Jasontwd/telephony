import {pathToFileURL} from 'node:url';
import {openDatabase} from '../core.js';

// One-time, app-only cleanup requested 23 October 2026. A fixed cutoff keeps
// later calls and in-flight recording callbacks out of this historical sweep.
const batch='archive-existing-calls-2026-10-23';
const cutoff='2026-10-23T02:18:00.000Z';
export function cleanupCalls(db,now=new Date()) {
  db.exec(`CREATE TABLE IF NOT EXISTS maintenance_batches (name TEXT PRIMARY KEY, receipt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS maintenance_archive_snapshots (batch TEXT NOT NULL,enquiry_id INTEGER NOT NULL,previous_json TEXT NOT NULL,PRIMARY KEY(batch,enquiry_id));`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing=db.prepare('SELECT receipt FROM maintenance_batches WHERE name=?').get(batch);
    if(existing){db.exec('COMMIT');return {...JSON.parse(existing.receipt),alreadyApplied:true};}
    const items=db.prepare(`SELECT * FROM enquiries e WHERE channel='phone' AND deleted_at='' AND archived_at='' AND created_at<=? AND updated_at<=?
      AND (accepted=1 OR call_status='answered' OR
        (trim(message)='' AND trim(voicemail_transcript)='' AND recording_sid='' AND trim(next_action)=''
         AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.enquiry_id=e.id)))`).all(cutoff,cutoff);
    const time=now.toISOString();let answered=0,empty=0;
    for(const item of items) {
      const isAnswered=!!item.accepted||item.call_status==='answered';
      const reason=isAnswered?'Historical cleanup: answered call':'Historical cleanup: no text or voice message';
      db.prepare('INSERT INTO maintenance_archive_snapshots VALUES(?,?,?)').run(batch,item.id,JSON.stringify({archived_at:item.archived_at,archive_reason:item.archive_reason,status:item.status,callback:item.callback,updated_at:item.updated_at}));
      db.prepare("UPDATE enquiries SET archived_at=?,archive_reason=?,status='resolved',callback=0,updated_at=? WHERE id=?").run(time,reason,time,item.id);
      db.prepare('INSERT INTO notes(enquiry_id,author,created_at,body) VALUES(?,?,?,?)').run(item.id,'Requested cleanup',time,reason+'. Archived in the app only; history retained.');
      if(isAnswered)answered++;else empty++;
    }
    const receipt={answered,empty,total:items.length};
    const archived=db.prepare('SELECT count(*) n FROM maintenance_archive_snapshots s JOIN enquiries e ON e.id=s.enquiry_id WHERE s.batch=? AND e.archived_at<>\'\'').get(batch).n;
    if(archived!==receipt.total)throw Error('Archive verification failed');
    db.prepare('INSERT INTO maintenance_batches VALUES(?,?)').run(batch,JSON.stringify(receipt));
    db.exec('COMMIT');return receipt;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const db=openDatabase(process.env.DB_PATH||'/data/formtech.sqlite');
  try {console.log('ARCHIVE_CLEANUP_RESULT '+JSON.stringify(cleanupCalls(db)));}finally{db.close();}
}
