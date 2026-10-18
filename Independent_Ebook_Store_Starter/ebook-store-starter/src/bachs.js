import {assert,decrypt,constantEqual,digest,limitedBytes} from './security.js';
import {settings,upstream,now} from './store.js';
import {corridorFor,minorUnits} from './markets.js';

const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
export function bachsCheckoutTarget(link,mode='live'){
  if(typeof link!=='string'||!['test','live'].includes(mode))return null;
  try{const u=new URL(link),trusted=u.hostname==='checkout.bachs.io'||mode==='test'&&u.hostname==='sandbox-checkout.bachs.io';return u.protocol==='https:'&&trusted&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&/^\/c\/[A-Za-z0-9_-]+\/?$/.test(u.pathname)?u:null;}catch{return null;}
}
export async function bachs(env,s,path,method='GET',body,mode=s.mode,idempotency){
  assert(['test','live'].includes(mode),503,'Payment setup is incomplete.');
  const key=await decrypt(env,s['bachs_'+mode]);assert(key,503,'Payment in this currency is temporarily unavailable. Please choose another currency.');
  const base=mode==='test'?'https://sandbox-api.bachs.io/v1/':'https://api.bachs.io/v1/';
  return upstream(env,base+path,{method,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',...(idempotency?{'Idempotency-Key':idempotency}:{})},body:body?JSON.stringify(body):undefined});
}
export async function startBachsCheckout(env,s,order,page){
  const corridor=corridorFor(order.currency);assert(corridor,400,'Choose an available currency at the top of the page.');
  const {response,data}=await bachs(env,s,'checkout-sessions','POST',{
    pricing:{currency:order.currency,amount:order.amount.toFixed(2)},billing_currency:order.currency,
    payment_method_types:[corridor],customer:{email:order.email,name:order.name},
    reference:order.ref,metadata:{order_ref:order.ref},success_url:page,cancel_url:page,expires_in_minutes:60
  },order.mode,'bookshop/'+order.ref);
  const messages={ACCOUNT_NOT_ACTIVATED:'This payment currency is not available yet. Please choose another currency.',ACCOUNT_PAYMENT_METHODS_RESTRICTED:'This payment currency is temporarily unavailable. Please choose another currency.',CHECKOUT_HAS_NO_PAYMENT_METHOD:'This payment currency is temporarily unavailable. Please choose another currency.',CHECKOUT_RESTRICTION_LEAVES_NO_PAYMENT_METHOD:'This payment currency is temporarily unavailable. Please choose another currency.'};
  assert(response.ok&&identifier(data.checkout_id),502,messages[data.error_code]||'We could not open payment. Please try again.');
  const target=bachsCheckoutTarget(data.checkout_url,order.mode);assert(target,502,'We could not open payment safely.');
  assert(!data.reference||data.reference===order.ref,502,'We could not match this payment to your order.');
  return {url:target.href,session:data.checkout_id};
}
function sessionIssue(order,session){
  if(session?.checkout_id!==order.provider_session||session?.reference!==order.ref)return 'reference_mismatch';
  if(session.currency!==order.currency||session.billing_currency&&session.billing_currency!==order.currency)return 'currency_mismatch';
  const expected=minorUnits(order.amount),paid=minorUnits(session.amount);
  if(expected===null||paid===null||expected!==paid)return 'amount_mismatch';
  return '';
}
export function bachsPaymentIssue(order,session){
  const identity=sessionIssue(order,session);if(identity)return identity;
  const status=String(session.status||'').toLowerCase(),payment=String(session.payment_status||'').toLowerCase(),charge=String(session.charge?.status||'').toLowerCase();
  if(session.charge&&session.charge.currency!==order.currency)return 'currency_mismatch';
  // The selected method is optional provider metadata. Checkout creation already
  // restricts the allowed methods; fulfilment requires the verified money below
  // and the signed, matching success event in readBachsConfirmation.
  // A partial payment can remain unresolved even after its checkout expires.
  if(charge==='underpaid')return 'underpaid';
  if(status==='expired')return 'expired';
  if(status==='cancelled')return 'cancelled';
  if(['failed','expired'].includes(charge)||payment==='failed')return 'failed';
  if(['canceled','cancelled'].includes(payment))return status==='open'?'failed':'cancelled';
  if(status!=='completed'||payment!=='succeeded')return 'not_successful';
  if(!identifier(session.charge?.payment_id))return 'transaction_invalid';
  if(!['succeeded','accepted','overpaid'].includes(charge))return 'not_successful';
  const received=minorUnits(session.charge.amount),expected=minorUnits(order.amount);if(received===null)return 'amount_mismatch';if(received<expected)return 'underpaid';
  // ACCEPTED may describe a partial amount accepted by the provider, not full collection.
  if(charge==='accepted')return 'needs_review';
  return 'paid';
}
export async function readBachsConfirmation(env,order){
  if(!identifier(order.provider_session))return {code:'awaiting_webhook'};
  const {response,data}=await bachs(env,await settings(env),'checkout-sessions/'+encodeURIComponent(order.provider_session),'GET',undefined,order.mode);
  if(!response.ok&&response.status!==404)throw new Error('Payment confirmation is temporarily unavailable.');
  if(!response.ok)return {code:'not_found'};
  const code=bachsPaymentIssue(order,data),result={code,checkout_open:!sessionIssue(order,data)&&String(data.status).toLowerCase()==='open',provider_status:String(data.payment_status||data.status||'').slice(0,40),amount:Number.isFinite(Number(data.amount))?Number(data.amount):null,currency:String(data.currency||'').slice(0,8)};
  if(code==='paid'){
    const proof=await env.DB.prepare("SELECT event_id FROM bachs_webhook_events WHERE order_ref=? AND mode=? AND checkout_id=? AND event_type IN ('checkout.completed','collection.succeeded') LIMIT 1").bind(order.ref,order.mode,order.provider_session).first();
    if(proof)result.provider_id='bachs:'+data.charge.payment_id;else result.code='awaiting_webhook';
  }
  return result;
}
export async function validBachsSignature(raw,headers,secret,clock=now()){
  if(!secret)return false;
  const v2=headers.get('X-Bachs-Signature-V2');let timestamp,signatures=[];
  if(v2){
    const parts=v2.split(',').map(p=>p.trim().split('='));
    const times=parts.filter(([k])=>k==='t');if(times.length!==1)return false;
    timestamp=times[0][1];signatures=parts.filter(([k])=>k==='v1').map(([,v])=>v);
  }else{timestamp=headers.get('X-Bachs-Timestamp');signatures=[headers.get('X-Bachs-Signature')];}
  if(!/^\d{9,12}$/.test(timestamp||'')||Math.abs(clock-Number(timestamp))>300||!signatures.length||signatures.length>5)return false;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+'.'+raw)));
  const expected=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return signatures.some(s=>typeof s==='string'&&/^[a-f0-9]{64}$/i.test(s)&&constantEqual(expected,s.toLowerCase()));
}
export async function receiveBachsWebhook(env,req,mode){
  assert(['test','live'].includes(mode),404,'Webhook not found.');
  const s=await settings(env),secret=await decrypt(env,s['bachs_webhook_'+mode]);
  const bytes=await limitedBytes(req,64000),raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  assert(await validBachsSignature(raw,req.headers,secret),401,'Webhook signature did not match.');
  let event;try{event=JSON.parse(raw);}catch{}assert(event&&identifier(event.id),400,'Please check the webhook payload.');
  if(!['checkout.completed','collection.succeeded','collection.failed','collection.underpaid','checkout.expired'].includes(event.type))return null;
  const checkoutId=event.data?.checkout_id;if(checkoutId==null)return null;assert(identifier(checkoutId),400,'Please check the checkout reference.');
  let order=await env.DB.prepare("SELECT * FROM orders WHERE provider='bachs' AND provider_session=? AND mode=?").bind(checkoutId,mode).first();
  if(!order){
    // Also recover a checkout whose create response was interrupted. Its verified
    // reference must identify an existing Bachs order in the same environment.
    const {response,data}=await bachs(env,s,'checkout-sessions/'+encodeURIComponent(checkoutId),'GET',undefined,mode);
    assert(response.ok||response.status===404,502,'Payment confirmation needs another attempt.');
    if(!response.ok||!identifier(data.reference))return null;
    order=await env.DB.prepare("SELECT * FROM orders WHERE ref=? AND provider='bachs' AND mode=?").bind(data.reference,mode).first();
    if(!order||order.provider_session&&order.provider_session!==checkoutId)return null;
    if(sessionIssue({...order,provider_session:checkoutId},data))return null;
    await env.DB.prepare("UPDATE orders SET provider_session=? WHERE ref=? AND provider='bachs' AND provider_session IS NULL").bind(checkoutId,order.ref).run();order={...order,provider_session:checkoutId};
  }
  const payloadHash=await digest(raw),existing=await env.DB.prepare('SELECT payload_hash FROM bachs_webhook_events WHERE event_id=? AND mode=?').bind(event.id,mode).first();
  assert(!existing||constantEqual(existing.payload_hash,payloadHash),400,'That event reference has already been used.');
  await env.DB.prepare('INSERT OR IGNORE INTO bachs_webhook_events(event_id,mode,checkout_id,order_ref,event_type,payload_hash,received_at) VALUES(?,?,?,?,?,?,?)').bind(event.id,mode,checkoutId,order.ref,event.type,payloadHash,now()).run();
  return order;
}
