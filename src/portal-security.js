import {assert,constantEqual,randomToken,digest,encrypt,decrypt,sign,checkPortalPassword} from './security.js';
import {now,rateLimit,saveSettings} from './store.js';

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export async function authorSession(env,req,required=true){
  const token=req.headers.get('Cookie')?.match(/(?:^|;\s*)__Secure-bs_author=([A-Za-z0-9_-]+)/)?.[1];
  const row=token?await env.DB.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').bind(await digest(token),now()).first():null;
  assert(row||!required,401,'Please sign in to your author portal.');return row;
}
export async function authorizeTestAccess(env,req,mode){
  if(mode==='test')assert(await authorSession(env,req,false),403,'Test checkout and test downloads require you to sign in to the author portal in this browser. Live customers do not need an account.');
}
export function newTotpSecret(){
  const bytes=crypto.getRandomValues(new Uint8Array(20));let bits=0,value=0,out='';
  for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){bits-=5;out+=alphabet[(value>>>bits)&31];}}
  return out;
}
function base32Bytes(secret){
  let bits=0,value=0;const out=[];
  for(const char of secret){const n=alphabet.indexOf(char);assert(n>=0,500,'Authenticator configuration needs attention.');value=(value<<5)|n;bits+=5;if(bits>=8){bits-=8;out.push((value>>>bits)&255);}}
  return new Uint8Array(out);
}
export async function totpCode(secret,counter){
  const bytes=new Uint8Array(8);new DataView(bytes.buffer).setBigUint64(0,BigInt(counter));
  const key=await crypto.subtle.importKey('raw',base32Bytes(secret),{name:'HMAC',hash:'SHA-1'},false,['sign']);
  const mac=new Uint8Array(await crypto.subtle.sign('HMAC',key,bytes)),offset=mac[19]&15;
  return String((new DataView(mac.buffer).getUint32(offset)&0x7fffffff)%1000000).padStart(6,'0');
}
export async function matchTotp(secret,code,time=now()){
  if(!/^\d{6}$/.test(String(code||'')))return null;
  const current=Math.floor(time/30);let matched=null;
  for(const counter of [current-1,current,current+1])if(constantEqual(await totpCode(secret,counter),code))matched=counter;
  return matched;
}
export const recoveryHash=(env,code)=>sign(env,'portal-recovery/v1/'+String(code||'').replace(/[\s-]/g,'').toUpperCase());
export async function secondFactor(env,s,code){
  if(!s.author_totp)return;
  const counter=await matchTotp(await decrypt(env,s.author_totp),String(code||'').trim());
  let claimed=false;
  if(counter!==null){
    const result=await env.DB.prepare("UPDATE settings SET value=? WHERE key='mfa_last_counter' AND CAST(value AS INTEGER)<?").bind(String(counter),counter).run();claimed=Boolean(result.meta.changes);
  }else if(/^[A-Za-z0-9\s-]{12,40}$/.test(String(code||''))){
    claimed=Boolean(await env.DB.prepare('DELETE FROM author_recovery_codes WHERE code_hash=? RETURNING code_hash').bind(await recoveryHash(env,code)).first());
  }
  assert(claimed,403,'Enter a fresh authenticator code or an unused recovery code. A code can only be used once.');
}
export async function reauthenticate(env,s,auth,data){
  await rateLimit(env,'reauth/'+auth.token_hash,8,300);
  assert(await checkPortalPassword(env,data.current_password,s.author_password),403,'Enter your current password to confirm this security change.');
  if(s.author_totp){await rateLimit(env,'author-second-factor',20,300);await secondFactor(env,s,data.security_code);}
}
export async function issueSession(env,expected){
  const token=randomToken(),csrf=randomToken();
  const clause=expected?" WHERE (SELECT value FROM settings WHERE key='author_password')=? AND COALESCE((SELECT value FROM settings WHERE key='author_totp'),'')=?":'';
  const args=[await digest(token),csrf,now()+3600,...(expected?[expected.author_password,expected.author_totp||'']:[])];
  const result=await env.DB.prepare('INSERT INTO sessions(token_hash,csrf,expires_at) SELECT ?,?,?'+clause).bind(...args).run();
  assert(result.meta.changes,401,'Your sign-in details changed. Please sign in again.');
  return {token,csrf};
}
export async function replaceRecoveryCodes(env){
  const codes=Array.from({length:8},()=>Array.from(crypto.getRandomValues(new Uint8Array(10)),b=>b.toString(16).padStart(2,'0')).join('').toUpperCase().match(/.{1,5}/g).join('-'));
  await env.DB.batch([env.DB.prepare('DELETE FROM author_recovery_codes'),...await Promise.all(codes.map(async code=>env.DB.prepare('INSERT INTO author_recovery_codes(code_hash,created_at) VALUES(?,?)').bind(await recoveryHash(env,code),now())))]);
  return codes;
}
export async function prepareTotp(env,auth){
  const secret=newTotpSecret();
  await env.DB.prepare('UPDATE sessions SET pending_totp=?,pending_totp_expires=? WHERE token_hash=?').bind(await encrypt(env,secret),now()+600,auth.token_hash).run();
  return secret;
}
export async function activateTotp(env,auth,code){
  assert(auth.pending_totp&&auth.pending_totp_expires>now(),400,'Start authenticator setup again. This setup code has expired.');
  const counter=await matchTotp(await decrypt(env,auth.pending_totp),String(code||'').trim());
  assert(counter!==null,403,'Enter the current six digit code from your authenticator app.');
  // Only the session that created this enrollment may claim it, once.
  const claimed=await env.DB.prepare('UPDATE sessions SET pending_totp=NULL,pending_totp_expires=NULL WHERE token_hash=? AND pending_totp=? RETURNING token_hash').bind(auth.token_hash,auth.pending_totp).first();
  assert(claimed,403,'Start authenticator setup again.');
  await saveSettings(env,{author_totp:auth.pending_totp,mfa_last_counter:String(counter)});
  return replaceRecoveryCodes(env);
}
