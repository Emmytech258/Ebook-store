import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {build} from 'esbuild';
import mfPackage from 'miniflare';
import {hashPassword,hashPortalPassword,checkPortalPassword,decrypt,digest} from '../src/security.js';
import {totpCode,issueSession} from '../src/portal-security.js';
const {Miniflare,convertV4MiniflareOptions}=mfPackage;
const root=new URL('../',import.meta.url).pathname,origin='https://store.example.invalid';
const password='only-for-security-regression-test';
const env={CONFIG_KEY:'security-regression-only-configuration-secret-over-32-characters'};
let mf,db,basePassword,cookie,csrf,serial=0;

async function api(path,{method='GET',data,auth=false,headers={},secure=true}={}){
  const h={...(method!=='GET'?{Origin:origin}:{}),...(auth?{Cookie:cookie,'X-BS-CSRF':csrf}:{}),...headers};
  if(data)h['Content-Type']='application/json';
  const response=await mf.dispatchFetch((secure?origin:origin.replace('https:','http:'))+'/books/api/'+path,{method,headers:h,body:data?JSON.stringify(data):undefined,redirect:'manual'});
  let result;try{result=await response.json();}catch{result={};}await response.waitUntil?.();
  return {response,data:result};
}
async function login(extra={},headers={}){
  const r=await api('admin/login',{method:'POST',data:{username:'owner',password,...extra},headers});
  if(r.response.ok){cookie=r.response.headers.get('Set-Cookie').split(';')[0];csrf=r.data.csrf;}return r;
}
function appCode(secret,offset=0){
  // Independent implementation for enrollment tests, using Node crypto.
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='';for(const c of secret)bits+=alphabet.indexOf(c).toString(2).padStart(5,'0');
  const bytes=Buffer.from(bits.match(/.{8}/g).map(b=>parseInt(b,2))),counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)+offset));
  const h=createHmac('sha1',bytes).update(counter).digest(),at=h[19]&15;
  return String((h.readUInt32BE(at)&0x7fffffff)%1000000).padStart(6,'0');
}
async function enroll(){
  const start=await api('admin/security/enroll',{method:'POST',auth:true,data:{current_password:password}});assert.equal(start.response.status,200,JSON.stringify(start.data));
  const enabled=await api('admin/security/enable',{method:'POST',auth:true,data:{current_password:password,security_code:appCode(start.data.secret)}});assert.equal(enabled.response.status,200,JSON.stringify(enabled.data));
  cookie=enabled.response.headers.get('Set-Cookie').split(';')[0];csrf=enabled.data.csrf;
  return {secret:start.data.secret,codes:enabled.data.recovery_codes};
}
before(async()=>{
  const bundled=await build({entryPoints:[root+'tests/harness-worker.js'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  mf=new Miniflare(convertV4MiniflareOptions({name:'security-regression',cf:false,telemetry:{enabled:false},modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-10-10',bindings:{...env,PUBLIC_ORIGIN:origin,AUTHOR_INITIAL_PASSWORD:password},d1Databases:['DB'],r2Buckets:['FILES'],assets:{directory:root+'public',binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true},assetConfig:{html_handling:'none',not_found_handling:'none'}},outboundService:()=>Response.json({})}));
  db=await mf.getD1Database('DB');for(const file of (await readdir(root+'migrations')).filter(x=>x.endsWith('.sql')).sort())await db.exec(await readFile(root+'migrations/'+file,'utf8'));
  await api('admin/session');basePassword=(await db.prepare("SELECT value FROM settings WHERE key='author_password'").first()).value;
});
beforeEach(async()=>{
  await db.batch([db.prepare('DELETE FROM sessions'),db.prepare('DELETE FROM limits'),db.prepare('DELETE FROM author_recovery_codes'),db.prepare("UPDATE settings SET value='' WHERE key='author_totp'"),db.prepare("UPDATE settings SET value='-1' WHERE key='mfa_last_counter'"),db.prepare("UPDATE settings SET value=? WHERE key='author_password'").bind(basePassword)]);
  assert.equal((await login({}, {'CF-Connecting-IP':'198.51.100.'+(++serial)})).response.status,200);
});
after(async()=>await mf?.dispose());

test('Stronger password hashing uses the runtime pepper and transparently upgrades old logins',async()=>{
  const hash=await hashPortalPassword(env,password);assert.match(hash,/^v2\.100000\./);assert.notEqual(hash,await hashPortalPassword(env,password));
  assert.equal(await checkPortalPassword(env,password,hash),true);assert.equal(await checkPortalPassword(env,'incorrect',hash),false);
  assert.equal(await checkPortalPassword({CONFIG_KEY:'different-security-test-secret-more-than-32-characters'},password,hash),false);
  const legacy=await hashPassword(password);await db.prepare("UPDATE settings SET value=? WHERE key='author_password'").bind(legacy).run();
  assert.equal((await login({password:'wrong'})).response.status,401);assert.equal((await db.prepare("SELECT value FROM settings WHERE key='author_password'").first()).value,legacy);
  assert.equal((await login()).response.status,200);assert.match((await db.prepare("SELECT value FROM settings WHERE key='author_password'").first()).value,/^v2\./);
  const upgraded=(await db.prepare("SELECT value FROM settings WHERE key='author_password'").first()).value;assert.equal(upgraded.split('.')[2],legacy.split('.')[0]);assert.equal(await checkPortalPassword(env,password,upgraded),true);
  const tooShort=await api('admin/password',{method:'POST',auth:true,data:{current_password:password,new_password:'short-password'}});assert.equal(tooShort.response.status,400);
});

test('Authenticator calculation matches the published RFC 6238 SHA-1 vectors',async()=>{
  const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for(const [time,expected] of [[59,'287082'],[1111111109,'081804'],[1111111111,'050471'],[1234567890,'005924'],[2000000000,'279037'],[20000000000,'353130']])assert.equal(await totpCode(secret,Math.floor(time/30)),expected);
});

test('Sensitive settings require the current password and refuse another website origin',async()=>{
  const original=(await api('admin/settings',{auth:true})).data.support_email;
  assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{support_email:'owner@example.com'}})).response.status,403);
  assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{support_email:'owner@example.com',current_password:'incorrect'}})).response.status,403);
  assert.equal((await api('admin/settings',{auth:true})).data.support_email,original);
  assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{public_origin:'https://attacker.example',current_password:password}})).response.status,400);
  assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{support_email:'security-test@example.com',current_password:password}})).response.status,200);
  assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{typography:'classic'}})).response.status,200);
  assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{resend_key:'re_fake_security_test_only',current_password:password}})).response.status,200);
  const saved=(await api('admin/settings',{auth:true})).data;assert.equal(saved.has_resend_key,true);assert.equal(saved.resend_key,undefined);
});

test('Enrollment stays off until a verified code and never exposes the active secret later',async()=>{
  assert.equal((await api('admin/security/enroll',{method:'POST',auth:true,data:{}})).response.status,403);
  const start=await api('admin/security/enroll',{method:'POST',auth:true,data:{current_password:password}});assert.equal(start.response.status,200);assert.match(start.data.secret,/^[A-Z2-7]{32}$/);
  assert.equal((await api('admin/settings',{auth:true})).data.mfa_enabled,false);
  const row=await db.prepare('SELECT pending_totp FROM sessions WHERE token_hash=?').bind(await digest(cookie.split('=')[1])).first();assert.notEqual(row.pending_totp,start.data.secret);assert.equal(await decrypt(env,row.pending_totp),start.data.secret);
  assert.equal((await api('admin/security/enable',{method:'POST',auth:true,data:{current_password:password,security_code:'wrong'}})).response.status,403);
  await db.prepare('UPDATE sessions SET pending_totp_expires=1').run();
  assert.equal((await api('admin/security/enable',{method:'POST',auth:true,data:{current_password:password,security_code:appCode(start.data.secret)}})).response.status,400);
  const oldCookie=cookie,{secret,codes}=await enroll();assert.equal(codes.length,8);assert.equal(new Set(codes).size,8);
  const saved=(await api('admin/settings',{auth:true})).data;assert.equal(saved.mfa_enabled,true);assert.equal(JSON.stringify(saved).includes(secret),false);
  assert.equal((await api('admin/session',{headers:{Cookie:oldCookie}})).data.authenticated,false);
  assert.equal((await api('admin/login',{method:'POST',data:{username:'owner',password}})).response.status,403);
  const recovery=await db.prepare('SELECT code_hash FROM author_recovery_codes').all();for(const code of codes)assert.equal(JSON.stringify(recovery).includes(code),false);
});

test('Authenticator codes and recovery codes cannot be reused, including concurrent logins',async()=>{
  const {secret,codes}=await enroll();
  await db.prepare("UPDATE settings SET value='-1' WHERE key='mfa_last_counter'").run();
  const code=appCode(secret),attempts=await Promise.all([login({security_code:code},{'CF-Connecting-IP':'198.51.100.180'}),login({security_code:code},{'CF-Connecting-IP':'198.51.100.181'})]);
  assert.deepEqual(attempts.map(x=>x.response.status).sort(),[200,403]);
  assert.equal((await login({security_code:codes[0]})).response.status,200);
  assert.equal((await login({security_code:codes[0]})).response.status,403);
  assert.equal((await login({security_code:codes[1],password:'incorrect'})).response.status,401);
  assert.equal((await login({security_code:codes[1]})).response.status,200);
});

test('MFA also protects settings, password changes, recovery replacement and disable actions',async()=>{
  const {codes}=await enroll();
  assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{from_name:'Changed sender',current_password:password}})).response.status,403);
  assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{from_name:'Changed sender',current_password:password,security_code:codes[0]}})).response.status,200);
  assert.equal((await api('admin/password',{method:'POST',auth:true,data:{current_password:password,new_password:'new-only-for-security-test'}})).response.status,403);
  const replaced=await api('admin/security/recovery',{method:'POST',auth:true,data:{current_password:password,security_code:codes[1]}});assert.equal(replaced.response.status,200);
  cookie=replaced.response.headers.get('Set-Cookie').split(';')[0];csrf=replaced.data.csrf;
  assert.equal((await login({security_code:codes[2]})).response.status,403);
  const disabled=await api('admin/security/disable',{method:'POST',auth:true,data:{current_password:password,security_code:replaced.data.recovery_codes[0]}});assert.equal(disabled.response.status,200);
  cookie=disabled.response.headers.get('Set-Cookie').split(';')[0];csrf=disabled.data.csrf;
  assert.equal((await api('admin/settings',{auth:true})).data.mfa_enabled,false);assert.equal((await db.prepare('SELECT count(*) AS n FROM author_recovery_codes').first()).n,0);
  assert.equal((await login()).response.status,200);
});

test('All-device logout requires reauthentication and invalidates every session',async()=>{
  const oldCookie=cookie;assert.equal((await login()).response.status,200);
  assert.equal((await api('admin/security/signout-all',{method:'POST',auth:true,data:{}})).response.status,403);
  assert.equal((await api('admin/security/signout-all',{method:'POST',auth:true,data:{current_password:password}})).response.status,200);
  assert.equal((await api('admin/session',{auth:true})).data.authenticated,false);assert.equal((await api('admin/session',{headers:{Cookie:oldCookie}})).data.authenticated,false);
});

test('A login cannot issue a session after its checked password or MFA settings change',async()=>{
  await assert.rejects(issueSession({...env,DB:db},{author_password:'old-password-hash',author_totp:''}),/sign-in details changed/);
  await db.prepare("UPDATE settings SET value='changed-mfa-value' WHERE key='author_totp'").run();
  await assert.rejects(issueSession({...env,DB:db},{author_password:basePassword,author_totp:''}),/sign-in details changed/);
});

test('CSRF, origin checks and secure cookies cover the new security routes',async()=>{
  const r=await login();assert.match(r.response.headers.get('Set-Cookie'),/^__Secure-bs_author=/);assert.match(r.response.headers.get('Set-Cookie'),/HttpOnly; SameSite=Strict/);assert.match(r.response.headers.get('Set-Cookie'),/; Secure/);
  assert.equal((await api('admin/security/enroll',{method:'POST',headers:{Cookie:cookie},data:{current_password:password}})).response.status,403);
  assert.equal((await api('admin/security/enroll',{method:'POST',auth:true,headers:{Origin:'https://attacker.example'},data:{current_password:password}})).response.status,403);
  assert.equal((await api('admin/security/enroll',{method:'POST',auth:true,headers:{'Sec-Fetch-Site':'cross-site'},data:{current_password:password}})).response.status,403);
  assert.equal((await api('admin/session',{headers:{Cookie:cookie.replace('__Secure-bs_author','bs_author')}})).data.authenticated,false);
});

test('Repeated failed logins and sensitive-action guesses are throttled',async()=>{
  for(let i=0;i<8;i++)assert.equal((await login({password:'incorrect'},{'CF-Connecting-IP':'203.0.113.40'})).response.status,401);
  assert.equal((await login({}, {'CF-Connecting-IP':'203.0.113.40'})).response.status,429);
  for(let i=0;i<8;i++)assert.equal((await api('admin/security/signout-all',{method:'POST',auth:true,data:{current_password:'incorrect'}})).response.status,403);
  assert.equal((await api('admin/security/signout-all',{method:'POST',auth:true,data:{current_password:password}})).response.status,429);
});

test('Private pages reject framing and outside scripts, and plain HTTP never accepts a login',async()=>{
  for(const path of ['/books/author/','/books/download/','/books/api/admin/session']){
    const r=await mf.dispatchFetch(origin+path);assert.equal(r.status,200);const csp=r.headers.get('Content-Security-Policy');assert.match(csp,/script-src 'self';/);assert.match(csp,/frame-ancestors 'none'/);assert.equal(csp.includes('facebook'),false);assert.equal(csp.includes('bachs.io'),false);assert.equal(r.headers.get('X-Frame-Options'),'DENY');assert.match(r.headers.get('Cache-Control'),/no-store/);assert.equal(r.headers.get('Strict-Transport-Security'),'max-age=31536000');
  }
  const frame=await mf.dispatchFetch(origin+'/books/pixel-frame.html');assert.match(frame.headers.get('Content-Security-Policy'),/sandbox allow-scripts/);assert.equal(frame.headers.has('X-Frame-Options'),false);
  const cancelled=await mf.dispatchFetch(origin+'/books/payment-cancelled.html'),cancelledCsp=cancelled.headers.get('Content-Security-Policy'),cancelledBody=await cancelled.text();
  assert.equal(cancelled.status,200);assert.equal(cancelled.headers.has('X-Frame-Options'),false);assert.match(cancelledCsp,/frame-ancestors [^;]*https:\/\/checkout\.bachs\.io [^;]*https:\/\/sandbox-checkout\.bachs\.io/);assert.match(cancelledCsp,/default-src 'none'/);assert.match(cancelledCsp,new RegExp('script-src '+origin.replace(/[.]/g,'[.]')+';'));assert.equal(cancelledCsp.includes('unsafe-eval'),false);assert.equal(cancelled.headers.get('Cache-Control'),'no-store');assert.equal((cancelledBody.match(/<script/g)||[]).length,1);assert.match(cancelledBody,/<script src="\/books\/payment-cancelled\.js" defer><\/script>/);assert.equal(/href=|[?]k=|ref=/.test(cancelledBody),false);
  const cancelledScript=await mf.dispatchFetch(origin+'/books/payment-cancelled.js'),cancelledJs=await cancelledScript.text();assert.equal(cancelledScript.status,200);assert.match(cancelledJs,/postMessage\(\{source:'bs-payment-cancelled'\},location\.origin\)/);assert.equal(/ref|key|email|localStorage|cookie|fetch/i.test(cancelledJs.replace(/\/\/.*$/gm,'')),false);
  const insecure=await api('admin/login',{method:'POST',secure:false,data:{username:'owner',password}});assert.equal(insecure.response.status,400);assert.equal(insecure.response.headers.has('Set-Cookie'),false);
  const redirect=await mf.dispatchFetch('http://store.example.invalid/books/author/',{redirect:'manual'});assert.equal(redirect.status,308);assert.equal(redirect.headers.get('Location'),origin+'/books/author/');
});
