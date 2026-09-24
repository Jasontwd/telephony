import {loadSummaryConfig} from './call-summary.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const queues = ['sales', 'support', 'orders', 'accounts', 'general'];
export const stores = ['auckland', 'christchurch', 'any'];
export const statuses = ['new', 'in_progress', 'waiting', 'resolved'];
export const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const equal = (a = '', b = '') => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export const hmac = (key, value) => createHmac('sha256', key).update(value).digest('hex');
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function checkPassword(password, hash) {
  const [salt, expected] = (hash || '').split(':');
  return !!salt && !!expected && equal(scryptSync(password, salt, 64).toString('hex'), expected);
}
export function signature(token, url, params) {
  // Twilio form webhook algorithm: all keys, sorted; unique sorted values per key.
  let value = url;
  for (const key of [...new Set(params.keys())].sort()) {
    for (const item of [...new Set(params.getAll(key))].sort()) value += key + item;
  }
  return createHmac('sha1', token).update(value).digest('base64');
}
export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true});
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS enquiries (
      id INTEGER PRIMARY KEY, reference TEXT NOT NULL UNIQUE,
      external_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      channel TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '', queue TEXT NOT NULL, store TEXT NOT NULL DEFAULT 'any',
      subject TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new', next_action TEXT NOT NULL DEFAULT '',
      due_at TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT '',
      quote_value REAL, call_status TEXT NOT NULL DEFAULT '', accepted INTEGER NOT NULL DEFAULT 0,
      callback INTEGER NOT NULL DEFAULT 0, recording_sid TEXT NOT NULL DEFAULT '',
      hubspot_ticket_id TEXT NOT NULL DEFAULT '', hubspot_error TEXT NOT NULL DEFAULT '',
      hubspot_attempt_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, enquiry_id INTEGER NOT NULL,
      author TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL,
      csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS enquiry_queue_status ON enquiries(queue,status);
    CREATE INDEX IF NOT EXISTS notes_enquiry ON notes(enquiry_id);
    PRAGMA user_version=1;`);
  if(!db.prepare('PRAGMA table_info(enquiries)').all().some(c=>c.name==='deleted_at'))
    db.exec("ALTER TABLE enquiries ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''");
  for(const [name,type] of Object.entries({archived_at:"TEXT NOT NULL DEFAULT ''",hubspot_owner_id:"TEXT NOT NULL DEFAULT ''",hubspot_stage:"TEXT NOT NULL DEFAULT ''",hubspot_checked_at:"INTEGER NOT NULL DEFAULT 0",hubspot_sync_error:"TEXT NOT NULL DEFAULT ''"})) {
    if(!db.prepare('PRAGMA table_info(enquiries)').all().some(c=>c.name===name))db.exec(`ALTER TABLE enquiries ADD COLUMN ${name} ${type}`);
  }
  return db;
}
export function insertEnquiry(db, item) {
  const time = new Date().toISOString();
  const key = item.external_key || null;
  const reference = 'FT-' + randomBytes(6).toString('hex').toUpperCase();
  db.prepare(`INSERT INTO enquiries(reference, external_key, created_at, updated_at,
    channel, name, email, phone, queue, store, subject, message, owner, callback)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(external_key) DO NOTHING`).run(
    reference,key,time,time,item.channel,item.name||'',item.email||'',item.phone||'',
    item.queue,item.store||'any',item.subject,item.message||'',item.owner||'',item.callback||0);
  return key ? db.prepare('SELECT * FROM enquiries WHERE external_key=?').get(key)
    : db.prepare('SELECT * FROM enquiries WHERE reference=?').get(reference);
}
export function limited(db, key, max, seconds) {
  const now = Math.floor(Date.now()/1000);
  db.prepare('DELETE FROM limits WHERE expires < ?').run(now);
  const row = db.prepare(`INSERT INTO limits VALUES(?,1,?) ON CONFLICT(key)
    DO UPDATE SET hits=hits+1 RETURNING hits`).get(key,now+seconds);
  return row.hits > max;
}
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const secret = env.SESSION_SECRET || (production ? '' : randomBytes(32).toString('hex'));
  if (secret.length < 32) throw Error('SESSION_SECRET must contain at least 32 characters');
  const base = (env.PUBLIC_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
  const parsed = new URL(base);
  if (parsed.origin !== base || (production && parsed.protocol !== 'https:')) throw Error('PUBLIC_BASE_URL must be an HTTPS origin in production');
  const primaryUsers = JSON.parse(env.STAFF_USERS_JSON || '[]');
  const agentUsers = JSON.parse(env.STAFF_AGENT_USERS_JSON || '[]');
  if (!Array.isArray(primaryUsers) || !Array.isArray(agentUsers) ||
    agentUsers.some(u => !u || u.role !== 'agent')) throw Error('Invalid staff user configuration');
  const users = [...primaryUsers, ...agentUsers];
  if (!Array.isArray(users) || users.some(u => !u || !/^[a-z0-9_-]{1,40}$/.test(u.username) ||
    !['manager','agent','accounts'].includes(u.role) || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(u.passwordHash)) ||
    new Set(users.map(u=>u.username)).size !== users.length) throw Error('Invalid STAFF_USERS_JSON');
  if (production && !users.some(u=>u.role==='manager')) throw Error('Configure at least one manager');
  const defaults = {
    auckland: {1:['09:00','17:00'],2:['09:00','17:00'],3:['09:00','17:00'],4:['09:00','17:00'],5:['09:00','17:00'],6:['11:00','15:00']},
    christchurch: {1:['10:00','17:00'],2:['10:00','17:00'],3:['10:00','17:00'],4:['10:00','17:00'],5:['10:00','17:00']},
    general: {1:['09:00','17:00'],2:['09:00','17:00'],3:['09:00','17:00'],4:['09:00','17:00'],5:['09:00','17:00']}
  };
  const hours = env.HOURS_JSON ? JSON.parse(env.HOURS_JSON) : defaults;
  for (const name of ['auckland','christchurch','general']) {
    if (!hours[name] || Object.entries(hours[name]).some(([day,times]) => !/^[0-6]$/.test(day) || !Array.isArray(times) || times.length!==2 || times.some(t=>!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) || times[0]>=times[1])) throw Error('Invalid HOURS_JSON');
  }
  const routes = {
    '1': {label:'Auckland sales and demos',queue:'sales',store:'auckland',owner:'martin',env:'AUCKLAND'},
    '2': {label:'Christchurch sales and demos',queue:'sales',store:'christchurch',owner:'jason',env:'CHRISTCHURCH'},
    '3': {label:'Technical support and repairs',queue:'support',store:'any',owner:'',env:'SUPPORT'},
    '4': {label:'Orders and deliveries',queue:'orders',store:'any',owner:'',env:'ORDERS'},
    '5': {label:'Accounts and payments',queue:'accounts',store:'any',owner:'',env:'ACCOUNTS'}
  };
  for (const route of Object.values(routes)) {
    route.phone = env[`${route.env}_PHONE`] || '';
    route.backup = env[`${route.env}_BACKUP_PHONE`] || '';
    for (const phone of [route.phone,route.backup]) if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) throw Error('Phone destinations must use E.164 format');
  }
  if (env.PUBLIC_PHONE && !/^\+[1-9]\d{7,14}$/.test(env.PUBLIC_PHONE)) throw Error('PUBLIC_PHONE must use E.164 format');
  const enabled = env.TELEPHONY_ENABLED === 'true';
  if (enabled && (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.PUBLIC_PHONE || env.HOURS_CONFIRMED !== 'true')) throw Error('Confirm phone credentials, public number and hours before enabling calls');
  return {followupEnabled:env.FOLLOWUP_EMAIL_ENABLED==='true',summary:loadSummaryConfig(env),production,secret,base,users,hours,routes,enabled,publicPhone:env.PUBLIC_PHONE||'',
    token:env.TWILIO_AUTH_TOKEN||'',account:env.TWILIO_ACCOUNT_SID||'',
    hubspot: {token:env.HUBSPOT_ACCESS_TOKEN||'',pipeline:env.HUBSPOT_TICKET_PIPELINE||'',
      stage:env.HUBSPOT_TICKET_STAGE||'',referenceProperty:env.HUBSPOT_REFERENCE_PROPERTY||'formtech_reference',
      portal:env.HUBSPOT_PORTAL_ID||''},
    emailSecret:env.EMAIL_WEBHOOK_SECRET||'',closed:(env.CLOSED_DATES||'').split(','),
    dbPath:env.DB_PATH||'./data/formtech.sqlite'};
}
export function isOpen(config, store, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-NZ', {timeZone:'Pacific/Auckland',
    year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
    .formatToParts(date).map(p=>[p.type,p.value]));
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday);
  if (config.closed.includes(`${parts.year}-${parts.month}-${parts.day}`)) return false;
  const range = config.hours[store === 'any' ? 'general' : store]?.[day];
  const time = `${parts.hour}:${parts.minute}`;
  return !!range && time >= range[0] && time < range[1];
}
export const canSee = (user, item) => user.role === 'manager' || (user.role === 'accounts' ? item.queue === 'accounts' : item.queue !== 'accounts');
