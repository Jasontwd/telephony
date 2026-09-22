import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {checkPassword, loadConfig} from '../core.js';

test('offline staff helper produces hashes accepted by production authentication', async () => {
  const html=readFileSync(new URL('../tools/create-staff-login.html',import.meta.url),'utf8');
  const scripts=[...html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  const context=vm.createContext({setTimeout,clearTimeout,TextEncoder,crypto:webcrypto,Uint8Array,ArrayBuffer,Promise});
  vm.runInContext(scripts[0]+scripts[1],context);
  for(const password of ['test-only-password-2026','Unicode-test-ā🔒-2026']) {
    const users=await context.buildStaffUser(password);
    assert(checkPassword(password,users[0].passwordHash));
    assert(!checkPassword(password+'wrong',users[0].passwordHash));
    loadConfig({NODE_ENV:'production',PUBLIC_BASE_URL:'https://telephony-kidzwq.fly.dev',
      SESSION_SECRET:'test-only-secret-for-validation-123456789',STAFF_USERS_JSON:JSON.stringify(users)});
  }
  await assert.rejects(()=>context.buildStaffUser('short'));
});

test('Martin helper adds an Agent without replacing Jason or granting accounts access', async () => {
  const {hashPassword,openDatabase,insertEnquiry}=await import('../core.js');
  const {createApp}=await import('../server.js');
  const html=readFileSync(new URL('../tools/create-martin-login.html',import.meta.url),'utf8');
  const scripts=[...html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  const context=vm.createContext({setTimeout,clearTimeout,TextEncoder,crypto:webcrypto,Uint8Array,ArrayBuffer,Promise});
  vm.runInContext(scripts[0]+scripts[1],context);
  const password='Martin-test-only-password-2026';
  const agentUsers=await context.buildStaffUser(password);
  assert.equal(agentUsers[0].username,'martin');assert.equal(agentUsers[0].role,'agent');
  const primary=[{username:'jason',role:'manager',passwordHash:hashPassword('Jason-test-only-password')}];
  const env={SESSION_SECRET:'test-only-secret-12345678901234567890',STAFF_USERS_JSON:JSON.stringify(primary),STAFF_AGENT_USERS_JSON:JSON.stringify(agentUsers)};
  const config=loadConfig(env);
  assert.deepEqual(config.users[0],primary[0]);assert.equal(config.users.length,2);
  assert.throws(()=>loadConfig({...env,STAFF_AGENT_USERS_JSON:JSON.stringify([{...agentUsers[0],role:'manager'}])}));
  assert.throws(()=>loadConfig({...env,STAFF_AGENT_USERS_JSON:JSON.stringify([{...agentUsers[0],username:'jason'}])}));
  assert.throws(()=>loadConfig({...env,STAFF_AGENT_USERS_JSON:'{}'}));
  const app=createApp(config,openDatabase(':memory:'));
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;config.base=base;
  try {
    const page=await fetch(base+'/login');const cookie=page.headers.get('set-cookie').split(';')[0];
    const csrf=(await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
    const login=await fetch(base+'/login',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,username:'martin',password}),redirect:'manual'});
    assert.equal(login.status,303);
    const session=login.headers.get('set-cookie').split(';')[0];
    const allowed=insertEnquiry(app.db,{channel:'web',queue:'sales',store:'auckland',subject:'Auckland agent check'});
    const restricted=insertEnquiry(app.db,{channel:'web',queue:'accounts',subject:'Accounts access check'});
    for(const [id,status] of [[allowed.id,200],[restricted.id,404]])assert.equal((await fetch(base+'/staff/enquiries/'+id,{headers:{Cookie:session}})).status,status);
  } finally {await new Promise(r=>app.server.close(r));app.db.close();}
});
