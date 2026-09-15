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
