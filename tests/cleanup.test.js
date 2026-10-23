import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,insertEnquiry} from '../core.js';
import {cleanupCalls} from '../scripts/archive-existing-calls.js';
test('one-time call cleanup preserves messages, recordings, notes, recent calls and other channels',()=>{
 const db=openDatabase(':memory:');
 const add=(fields={})=>{const i=insertEnquiry(db,{channel:'phone',queue:'general',subject:'Call',...fields});db.prepare("UPDATE enquiries SET created_at='2026-10-20T00:00:00Z',updated_at='2026-10-20T00:00:00Z' WHERE id=?").run(i.id);return i.id;};
 const answered=add({message:'Answered call text'});db.prepare('UPDATE enquiries SET accepted=1 WHERE id=?').run(answered);
 const empty=add();const text=add({message:'Please call me'});
 const recording=add();db.prepare("UPDATE enquiries SET recording_sid='RE123' WHERE id=?").run(recording);
 const transcript=add();db.prepare("UPDATE enquiries SET voicemail_transcript='Hello' WHERE id=?").run(transcript);
 const note=add();db.prepare("INSERT INTO notes(enquiry_id,author,created_at,body) VALUES(?,'jason','2026-10-20','Follow up')").run(note);
 const web=add({channel:'web'});const recent=add();db.prepare("UPDATE enquiries SET updated_at='2026-10-23T02:30:00Z' WHERE id=?").run(recent);
 const deleted=add();db.prepare("UPDATE enquiries SET deleted_at='2026-10-21' WHERE id=?").run(deleted);
 const r=cleanupCalls(db);assert.deepEqual(r,{answered:1,empty:1,total:2});
 for(const id of [answered,empty]) {const row=db.prepare('SELECT * FROM enquiries WHERE id=?').get(id);assert.ok(row.archived_at);assert.equal(row.hubspot_close_state,'');assert.equal(row.deleted_at,'');}
 for(const id of [text,recording,transcript,note,web,recent,deleted])assert.equal(db.prepare('SELECT archived_at FROM enquiries WHERE id=?').get(id).archived_at,'');
 assert.equal(cleanupCalls(db).alreadyApplied,true);assert.equal(db.prepare('SELECT count(*) n FROM maintenance_archive_snapshots').get().n,2);db.close();
});
