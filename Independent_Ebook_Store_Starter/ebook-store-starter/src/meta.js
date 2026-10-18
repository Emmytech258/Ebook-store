import {assert,encrypt,decrypt,randomToken} from './security.js';
import {now,settings,originFor,upstream} from './store.js';
const API_VERSION='v26.0';
const browserEvents=new Set(['PageView','ViewContent','AddToCart','InitiateCheckout']);
export const purchaseEventId=ref=>'purchase-'+ref;
export const metaActive=s=>s.mode==='live'&&s.meta_enabled==='1'&&Boolean(s.meta_access_token)&&/^\d{5,30}$/.test(s.pixel_id||'');
export async function sha256Hex(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export function attribution(req,context={}){
  const result={},ip=req.headers.get('CF-Connecting-IP'),ua=req.headers.get('User-Agent');
  if(ip&&/^[a-f0-9:.]{3,45}$/i.test(ip))result.client_ip_address=ip;
  if(ua)result.client_user_agent=ua.slice(0,500);
  for(const key of ['fbp','fbc']){
    const cookie=req.headers.get('Cookie')?.match(new RegExp('(?:^|;\\s*)_'+key+'=([^;]+)'))?.[1];
    const value=String(context?.[key]||cookie||'');
    if(/^fb\.\d{1,2}\.\d{10,16}\.[A-Za-z0-9_-]{1,300}$/.test(value))result[key]=value;
  }
  return result;
}
function event(s,env,name,id,user,custom,path,time=now()){
  return {event_name:name,event_time:time,event_id:id,action_source:'website',event_source_url:originFor(env,s)+path,user_data:user,...(custom?{custom_data:custom}:{})};
}
async function insertStatement(env,s,payload,orderRef){
  const encrypted=await encrypt(env,JSON.stringify(payload));
  const sql=orderRef?"INSERT OR IGNORE INTO meta_events(id,pixel_id,payload,created_at,next_attempt_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM orders WHERE ref=? AND status='paid' AND mode='live')":'INSERT OR IGNORE INTO meta_events(id,pixel_id,payload,created_at,next_attempt_at) VALUES(?,?,?,?,?)';
  const args=[payload.event_id,s.pixel_id,encrypted,now(),now()];if(orderRef)args.push(orderRef);
  return env.DB.prepare(sql).bind(...args);
}
export async function purchaseStatement(env,s,order,time){
  if(order.mode!=='live'||!metaActive(s))return null;
  let user={};try{if(order.meta_user_data)user=JSON.parse(await decrypt(env,order.meta_user_data));}catch{}
  user.em=[await sha256Hex(order.email.trim().toLowerCase())];
  const items=JSON.parse(order.items),custom={value:order.amount,currency:order.currency,content_type:'product',content_ids:items.map(i=>i.id),contents:items.map(i=>({id:i.id,quantity:1,item_price:i.amount})),num_items:items.length};
  return insertStatement(env,s,event(s,env,'Purchase',purchaseEventId(order.ref),user,custom,'/books/checkout/',time),order.ref);
}
export async function browserEvent(env,req,data){
  assert(browserEvents.has(data.event),400,'This tracking event is not allowed.');
  assert(typeof data.event_id==='string'&&/^[A-Za-z0-9_-]{8,120}$/.test(data.event_id),400,'Please check the tracking event.');
  const s=await settings(env);if(!metaActive(s))return {ok:true};
  const path=String(data.path||'/books/');
  assert(/^\/books\/(?:[a-z0-9-]{1,100}\/)?$/.test(path)&&!/^\/books\/(?:download|author|api)\//.test(path),400,'This page does not support public tracking.');
  const ids=Array.isArray(data.data?.content_ids)?[...new Set(data.data.content_ids)].slice(0,50):[];
  assert(ids.every(id=>typeof id==='string'&&/^[a-z0-9][a-z0-9-]{0,99}$/.test(id)),400,'Please check the tracked books.');
  const custom=ids.length?{content_ids:ids,content_type:'product',num_items:ids.length}:undefined;
  if(custom&&['NGN','KES','UGX','USD'].includes(data.data?.currency)&&Number.isFinite(data.data?.value)&&data.data.value>=0&&data.data.value<1e9){custom.currency=data.data.currency;custom.value=data.data.value;}
  await (await insertStatement(env,s,event(s,env,data.event,data.event_id,attribution(req,data.context),custom,path))).run();
  return {ok:true};
}
async function send(env,s,pixel,payload,testCode){
  const token=await decrypt(env,s.meta_access_token);
  const {response,data}=await upstream(env,'https://graph.facebook.com/'+API_VERSION+'/'+pixel+'/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:[payload],access_token:token,...(testCode?{test_event_code:testCode}:{})})});
  // Provider responses may echo request data. Store only a numeric error code.
  const code=Number.isInteger(data.error?.code)?data.error.code:response.status;
  assert(response.ok&&Number(data.events_received)>=1,502,'Meta did not accept this event (code '+code+'). Check your Pixel ID and API token.');
}
export async function testMeta(env,req){
  const s=await settings(env);assert(s.pixel_id&&s.meta_access_token,400,'Save your Pixel ID and Conversions API token first.');
  assert(s.meta_test_code,400,'Add the Test Event Code from Meta Events Manager and save it before sending a test.');
  await send(env,s,s.pixel_id,event(s,env,'PageView','test-'+randomToken(15),attribution(req),undefined,'/books/'),s.meta_test_code);
  return {ok:true,message:'Meta accepted the test. Check Test Events in Meta Events Manager.'};
}
export async function flushMeta(env,limit=5){
  await env.DB.prepare('DELETE FROM meta_events WHERE created_at<?').bind(now()-604800).run();
  const s=await settings(env);if(!metaActive(s))return;
  const t=now(),{results}=await env.DB.prepare('SELECT * FROM meta_events WHERE sent_at IS NULL AND attempts<12 AND next_attempt_at<=? AND lock_at<? AND created_at>? AND pixel_id=? ORDER BY created_at LIMIT ?').bind(t,t-90,t-604800,s.pixel_id,limit).all();
  for(const row of results){
    const claim=await env.DB.prepare('UPDATE meta_events SET lock_at=?,attempts=attempts+1 WHERE id=? AND sent_at IS NULL AND lock_at<? AND next_attempt_at<=?').bind(t,row.id,t-90,t).run();if(!claim.meta.changes)continue;
    try{await send(env,s,row.pixel_id,JSON.parse(await decrypt(env,row.payload)));await env.DB.prepare('UPDATE meta_events SET sent_at=?,payload=?,lock_at=0,error=NULL WHERE id=?').bind(now(),'',row.id).run();}
    catch(error){const safe=/^Meta did not accept/.test(error.message)?error.message:'Meta delivery needs another attempt.';await env.DB.prepare('UPDATE meta_events SET lock_at=0,next_attempt_at=?,error=? WHERE id=?').bind(now()+Math.min(3600,60*2**Math.min(row.attempts,6)),safe,row.id).run();}
  }
}
