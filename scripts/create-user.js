import {hashPassword} from '../core.js';
import {readFileSync} from 'node:fs';
const [username,role='agent']=process.argv.slice(2);
if(!/^[a-z0-9_-]{1,40}$/.test(username||'')||!['manager','agent','accounts'].includes(role)) {
  console.error('Usage: npm run user -- username manager|agent|accounts < password-file');process.exit(1);
}
if(process.stdin.isTTY) {
  console.error('Read the password securely into stdin. See README; do not put passwords in command arguments.');process.exit(1);
}
const password=readFileSync(0,'utf8').replace(/\r?\n$/,'');
if(password.length<14||password.length>256){console.error('Use a password of 14 to 256 characters');process.exit(1);}
console.log(JSON.stringify({username,role,passwordHash:hashPassword(password)}));
