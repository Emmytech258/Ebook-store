const te = new TextEncoder();
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
export const randomToken = (length=32) => b64(crypto.getRandomValues(new Uint8Array(length)));
export function b64(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
export function unb64(str) { return Uint8Array.from(atob(str.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0)); }
export async function digest(text) { return b64(new Uint8Array(await crypto.subtle.digest('SHA-256',te.encode(text)))); }
async function secretKey(env, algorithm) {
  if (!env.CONFIG_KEY || env.CONFIG_KEY.length < 32) throw new Error('Store secrets need configuration.');
  const bytes=await crypto.subtle.digest('SHA-256',te.encode(env.CONFIG_KEY));
  return crypto.subtle.importKey('raw',bytes,algorithm,false,algorithm==='AES-GCM'?['encrypt','decrypt']:['sign','verify']);
}
export async function encrypt(env, text) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},await secretKey(env,'AES-GCM'),te.encode(text));
  return b64(iv)+'.'+b64(new Uint8Array(encrypted));
}
export async function decrypt(env, value) {
  if(!value) return '';
  const [iv,data]=value.split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv)},await secretKey(env,'AES-GCM'),unb64(data)));
}
export async function sign(env, message) {
  const key=await secretKey(env,{name:'HMAC',hash:'SHA-256'});
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC',key,te.encode(message))));
}
export async function verifySignature(env, message, signature) {
  try { return crypto.subtle.verify('HMAC',await secretKey(env,{name:'HMAC',hash:'SHA-256'}),unb64(signature),te.encode(message)); } catch { return false; }
}
export async function hashPassword(password, salt=randomToken(16), iterations=100000) {
  const key=await crypto.subtle.importKey('raw',te.encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations,salt:unb64(salt)},key,256);
  return salt+'.'+b64(new Uint8Array(bits));
}
// The pepper stays in a Worker secret, separate from the database backup.
export async function hashPortalPassword(env,password,salt=randomToken(16)) {
  // Production Workers currently caps PBKDF2 at 100,000 even when local workerd allows more.
  const derived=await hashPassword(password,salt,100000);
  return pepperPasswordHash(env,derived);
}
export async function pepperPasswordHash(env,derived){return 'v2.100000.'+derived.split('.')[0]+'.'+await sign(env,'portal-password/v2/100000/'+derived);}
export async function checkPortalPassword(env,password,hash) {
  if(typeof password!=='string'||password.length>256||!hash)return false;
  if(!hash.startsWith('v2.'))return checkPassword(password,hash);
  const parts=hash.split('.');if(parts.length!==4||parts[1]!=='100000')return false;
  return constantEqual(await hashPortalPassword(env,password,parts[2]),hash);
}
export async function checkPassword(password, hash) {
  if(!hash)return false;
  const calculated=await hashPassword(password,hash.split('.')[0]);
  return constantEqual(calculated,hash);
}
export function constantEqual(a,b) {
  const x=te.encode(String(a||'')), y=te.encode(String(b||''));let diff=x.length^y.length;
  for(let i=0;i<Math.max(x.length,y.length);i++)diff|=(x[i]||0)^(y[i]||0);
  return diff===0;
}
export function json(data,status=200,headers={}) { return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}}); }
export class HttpError extends Error { constructor(status,message,data) { super(message);this.status=status;this.data=data; } }
export function assert(condition,status,message,data) { if(!condition)throw new HttpError(status,message,data); }
export function sameOrigin(req) {
  const origin=req.headers.get('Origin');
  assert(!origin||origin===new URL(req.url).origin,403,'Please use the form on this website.');
  assert(req.headers.get('Sec-Fetch-Site')!=='cross-site',403,'Please use the form on this website.');
}
export async function limitedBytes(req,max) {
  assert(Number(req.headers.get('Content-Length')||0)<=max,413,'The file is too large.');
  const reader=req.body?.getReader();if(!reader)return new Uint8Array();
  const chunks=[];let total=0;
  while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>max){await reader.cancel();throw new HttpError(413,'The file is too large.');}chunks.push(value);}
  const result=new Uint8Array(total);let at=0;for(const chunk of chunks){result.set(chunk,at);at+=chunk.length;}return result;
}
export async function bodyJson(req,max=200000) {
  try{return JSON.parse(new TextDecoder().decode(await limitedBytes(req,max)));}catch(e){if(e instanceof HttpError)throw e;throw new HttpError(400,'Please check the submitted details.');}
}
const allowedTags=new Set('p br strong b em i u s ul ol li h1 h2 h3 h4 span div blockquote'.split(' '));
const color=v=>/^(#[a-f0-9]{3,8}|(?:rgb|rgba)\([0-9., %]+\)|[a-z]{3,20})$/i.test(v)&&!['inherit','expression','url','javascript'].includes(v.toLowerCase());
export function sanitizeHtml(value) {
  const html=String(value||'').slice(0,100000).replace(/<(script|style|iframe|object|svg|math)[\s\S]*?<\/\1\s*>/gi,'');
  return html.split(/(<[^>]*>)/g).map(part=>{
    if(!part.startsWith('<'))return part.replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const m=part.match(/^<\s*(\/?)\s*([a-z0-9]+)([^>]*)>$/i);if(!m||!allowedTags.has(m[2].toLowerCase()))return '';
    const tag=m[2].toLowerCase();if(m[1])return tag==='br'?'':`</${tag}>`;
    const sm=m[3].match(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i), styles=[];
    for(const rule of (sm?(sm[1]||sm[2]||''):'').split(';')){
      const colon=rule.indexOf(':');if(colon<0)continue;
      const key=rule.slice(0,colon).trim().toLowerCase(), val=rule.slice(colon+1).trim();
      if(['color','background-color'].includes(key)&&color(val))styles.push(key+':'+val);
      if(key==='font-size'&&/^(?:[1-9]|[1-4][0-9]|50)(?:px|pt)$/.test(val))styles.push(key+':'+val);
      if(key==='text-align'&&/^(left|center|right)$/.test(val))styles.push(key+':'+val);
    }
    return `<${tag}${styles.length?' style="'+escapeHtml(styles.join(';'))+'"':''}>`;
  }).join('');
}
export function webpDimensions(bytes) {
  const str=(a,n)=>new TextDecoder().decode(bytes.subarray(a,a+n));
  if(bytes.length<30||str(0,4)!=='RIFF'||str(8,4)!=='WEBP')return null;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let at=12;at+8<=bytes.length;){
    const kind=str(at,4),n=view.getUint32(at+4,true),start=at+8;if(start+n>bytes.length)return null;
    if(kind==='VP8X'&&n>=10)return {width:1+bytes[start+4]+(bytes[start+5]<<8)+(bytes[start+6]<<16),height:1+bytes[start+7]+(bytes[start+8]<<8)+(bytes[start+9]<<16)};
    if(kind==='VP8 '&&n>=10&&bytes[start+3]===157&&bytes[start+4]===1&&bytes[start+5]===42)return {width:view.getUint16(start+6,true)&16383,height:view.getUint16(start+8,true)&16383};
    if(kind==='VP8L'&&n>=5&&bytes[start]===47){const bits=view.getUint32(start+1,true);return {width:(bits&16383)+1,height:((bits>>>14)&16383)+1};}
    at=start+n+(n%2);
  }return null;
}
export function csvCell(value) { let str=String(value??'');if(/^[\s]*[=+\-@]/.test(str))str="'"+str;return '"'+str.replace(/"/g,'""')+'"'; }
