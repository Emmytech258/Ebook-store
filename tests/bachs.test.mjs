import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import mfPackage from 'miniflare';
import {bachsCheckoutTarget,bachsPaymentIssue,validBachsSignature} from '../src/bachs.js';
import {COUNTRY_CURRENCIES,SHOP_CURRENCIES,minorUnits} from '../src/markets.js';
import {initialize} from '../src/store.js';
const {Miniflare,convertV4MiniflareOptions}=mfPackage;
const root=new URL('../',import.meta.url).pathname,origin='https://store.example.invalid';
const secrets={test:'whsec_sandbox_bachs_signing_secret',live:'whsec_live_bachs_signing_secret'};
const rates={NGN:1,GHS:.008,KES:.09,MWK:1.3,RWF:1.1,TZS:1.9,UGX:2.5,XAF:.45,XOF:.45,ZMW:.017,USD:.0007};
const sessions=new Map(),flwTransactions=new Map(),starts=[],messages=[];
let portalPassword='only-for-test-initial-password';
let mf,db,nonce,cookie,csrf,books,sequence=0,requestId=0,eventId=0,reads=0,readFails=false,holdBachsRead=null,flwReadFails=false,flwSequence=50000,createResponseLost=false,linkOverride=null;
const reply=(body,status=200)=>Response.json(body,{status});
async function external(req){
  const u=new URL(req.url);
  if(u.hostname==='open.er-api.com')return reply({result:'success',base_code:'NGN',time_last_update_unix:Math.floor(Date.now()/1000),rates});
  if(u.hostname==='api.resend.com'){messages.push({body:await req.json(),idempotency:req.headers.get('Idempotency-Key')});return reply({id:'receipt_'+messages.length});}
  if(u.hostname==='api.flutterwave.com'){
    if(u.pathname==='/v3/payments'){const body=await req.json();starts.push({provider:'flutterwave',body});return reply({status:'success',data:{link:'https://'+(req.headers.get('Authorization').startsWith('Bearer FLWSECK_TEST-')?'checkout-v2.dev-flutterwave.com':'checkout.flutterwave.com')+'/v3/hosted/pay/'+body.tx_ref}});}
    if(flwReadFails)return reply({status:'error'},503);
    const id=u.pathname.match(/^\/v3\/transactions\/(\d+)\/verify$/)?.[1];
    const tx=id?flwTransactions.get(id):[...flwTransactions.values()].reverse().find(t=>t.tx_ref===u.searchParams.get('tx_ref'));
    return tx?reply({status:'success',data:tx}):reply({status:'error'},404);
  }
  if(['api.bachs.io','sandbox-api.bachs.io'].includes(u.hostname)){
    const mode=u.hostname==='sandbox-api.bachs.io'?'test':'live';
    assert.equal(req.headers.get('Authorization'),'Bearer '+(mode==='test'?'sk_sandbox_test_key_value':'sk_live_test_key_value'));
    if(u.pathname==='/v1/checkout-sessions'&&req.method==='POST'){
      const body=await req.json(),id='chk_'+(++sequence);starts.push({provider:'bachs',mode,body,idempotency:req.headers.get('Idempotency-Key')});
      sessions.set(id,{checkout_id:id,status:'open',payment_status:'requires_payment_method',amount:body.pricing.amount,currency:body.pricing.currency,billing_currency:body.billing_currency,reference:body.reference,payment_method:body.payment_method_types[0],charge:null,mode,body});
      if(createResponseLost)return reply({detail:'Interrupted response'},503);
      return reply({checkout_id:id,checkout_url:linkOverride||'https://'+(mode==='test'?'sandbox-checkout.bachs.io':'checkout.bachs.io')+'/c/token_'+sequence,status:'open',reference:body.reference},201);
    }
    if(u.pathname==='/v1/checkout-sessions')return reply({data:[]});
    if(u.pathname.startsWith('/v1/checkout-sessions/')){reads++;if(readFails)return reply({detail:'Temporary outage'},503);const session=sessions.get(u.pathname.split('/').pop()),snapshot=session?structuredClone(session):null;if(holdBachsRead){const hold=holdBachsRead;holdBachsRead=null;await hold();}return snapshot?.mode===mode?reply(snapshot):reply({detail:'Not found'},404);}
  }
  throw new Error('Unexpected external request '+u.hostname+u.pathname);
}
async function api(path,{method='GET',data,raw,auth=false,publicPost=false,headers={},country='NG'}={}){
  if(path==='admin/settings'&&auth&&method==='POST')data={current_password:portalPassword,...data};
  const h={...(publicPost&&cookie?{Cookie:cookie}:{}),...(auth?{Cookie:cookie,'X-BS-CSRF':csrf}:{}),...(publicPost?{'X-BS-Nonce':nonce}:{}),...headers};
  if(data)h['Content-Type']='application/json';if(method!=='GET')h.Origin=origin;
  const response=await mf.dispatchFetch(origin+'/books/api/'+path,{method,headers:h,cf:{country},body:raw??(data?JSON.stringify(data):undefined)});
  const result=await response.json();await response.waitUntil?.();return {response,data:result};
}
async function login(password='only-for-test-initial-password'){
  const {response,data}=await api('admin/login',{method:'POST',data:{username:'owner',password}});assert.equal(response.status,200,JSON.stringify(data));cookie=response.headers.get('set-cookie').split(';')[0];csrf=data.csrf;portalPassword=password;
}
async function configure(data){const r=await api('admin/settings',{method:'POST',auth:true,data});assert.equal(r.response.status,200,JSON.stringify(r.data));}
async function order(currency='GHS',country='GH',ids=books.slice(0,2).map(b=>b.id)){
  const catalog=(await api('catalog',{country})).data;nonce=catalog.nonce;
  const amount=Math.round(ids.reduce((sum,id)=>sum+catalog.books.find(b=>b.id===id).prices[currency],0)*100)/100;
  const r=await api('checkout',{method:'POST',publicPost:true,country,headers:{'CF-Connecting-IP':'198.51.100.'+(++requestId)},data:{name:'Test Reader',email:'reader@example.com',country,currency,books:ids,expected_amount:amount,consent:true}});
  const row=r.data.ref?await db.prepare('SELECT * FROM orders WHERE ref=?').bind(r.data.ref).first():null;
  const back=r.data.return_url||starts.findLast(s=>s.provider==='flutterwave'&&s.body.tx_ref===row?.ref)?.body.redirect_url;
  const key=back?new URL(back).searchParams.get('k'):null;
  return {...r,row,key,amount};
}
function complete(o,changes={}){
  const saved=sessions.get(o.row.provider_session),value={...saved,status:'completed',payment_status:'succeeded',charge:{payment_id:'pay_'+saved.checkout_id,status:'succeeded',amount:saved.amount,currency:saved.currency},...changes};sessions.set(saved.checkout_id,value);return value;
}
async function deliver(o,{mode=o.row.mode,type='checkout.completed',id='evt_'+(++eventId),timestamp=Math.floor(Date.now()/1000),signature,changes={}}={}){
  const raw=JSON.stringify({id,type,data:{checkout_id:o.row.provider_session,...changes}}),digest=createHmac('sha256',secrets[mode]).update(timestamp+'.'+raw).digest('hex');
  return api('bachs/webhook/'+mode,{method:'POST',raw,headers:{'X-Bachs-Signature-V2':signature??'t='+timestamp+',v1='+digest}});
}
async function verify(o,extra={}){return api('verify',{method:'POST',publicPost:true,data:{ref:o.row.ref,key:o.key,...extra}});}
function flwPayment(o,changes={}){
  const tx={id:++flwSequence,tx_ref:o.row.ref,amount:o.row.amount,currency:o.row.currency,status:'successful',...changes};flwTransactions.set(String(tx.id),tx);return tx;
}
async function flwWebhook(o,tx,extra={}){return api('webhook',{method:'POST',headers:{'verif-hash':'flutterwave_webhook_secret'},data:{event:'charge.completed',data:{id:tx.id,tx_ref:o.row.ref,status:'successful'},...extra}});}
before(async()=>{
  const bundled=await build({entryPoints:[root+'tests/harness-worker.js'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  mf=new Miniflare(convertV4MiniflareOptions({name:'bachs-bookshop-test',cf:false,telemetry:{enabled:false},modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-10-10',bindings:{CONFIG_KEY:'only-a-test-config-key-over-thirty-two-characters',PUBLIC_ORIGIN:origin,AUTHOR_INITIAL_PASSWORD:'only-for-test-initial-password'},d1Databases:['DB'],r2Buckets:['FILES'],assets:{directory:root+'public',binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true},assetConfig:{html_handling:'none',not_found_handling:'none'}},outboundService:external}));
  db=await mf.getD1Database('DB');for(const name of (await readdir(root+'migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(root+'migrations/'+name,'utf8'));
  const catalog=(await api('catalog')).data;books=catalog.books;nonce=catalog.nonce;await login();
  await configure({mode:'test',currencies:SHOP_CURRENCIES,flutterwave_test:'FLWSECK_TEST-test_key_value',flutterwave_live:'FLWSECK-test_key_value',webhook_secret:'flutterwave_webhook_secret',bachs_test:'sk_sandbox_test_key_value',bachs_live:'sk_live_test_key_value',bachs_webhook_test:secrets.test,bachs_webhook_live:secrets.live,resend_key:'re_test_email_key_value',from_email:'support@example.invalid'});
  for(const b of books.slice(0,2)){
    const uploaded=await api('admin/upload?kind=pdf',{method:'POST',auth:true,raw:'%PDF-1.7\n'+b.title+'\n%%EOF'});assert.equal(uploaded.response.status,200);
    const updated=await api('admin/books',{method:'POST',auth:true,data:{...b,pdf_key:uploaded.data.key}});assert.equal(updated.response.status,200);
  }
});
after(async()=>{await mf?.dispose();});

test('Fresh installs require a private initial password and existing stores keep their saved login',async()=>{
  for(const password of [undefined,'short','x'.repeat(257)]){
    const DB={prepare:()=>({first:async()=>null})};
    await assert.rejects(initialize({DB,AUTHOR_INITIAL_PASSWORD:password}),/private initial author password/);
  }
  const DB={prepare:()=>({first:async()=>({value:'1'})})};
  await assert.doesNotReject(initialize({DB}));
});

test('Every requested currency reaches the correct gateway with a frozen local amount',async()=>{
  for(const [country,currency] of Object.entries(COUNTRY_CURRENCIES)){
    const c=(await api('catalog',{country})).data;assert.equal(c.currency,currency,country);assert.ok(c.currencies.includes(currency));
  }
  for(const currency of SHOP_CURRENCIES){
    const o=await order(currency);assert.equal(o.response.status,200,JSON.stringify(o.data));const request=starts.at(-1);
    assert.equal(o.row.provider,currency==='NGN'?'flutterwave':'bachs');assert.equal(o.row.currency,currency);assert.equal(o.row.amount,o.amount);
    if(currency==='NGN'){assert.equal(request.body.payment_options,'card,banktransfer,ussd');continue;}
    assert.equal(o.data.mode,'test');assert.equal(new URL(o.data.checkout_url).hostname,'sandbox-checkout.bachs.io');assert.equal(request.provider,'bachs');assert.equal(request.body.pricing.currency,currency);assert.equal(Number(request.body.pricing.amount),o.amount);assert.equal(request.body.billing_currency,currency);assert.deepEqual(request.body.payment_method_types,['MOMO_'+currency]);
    assert.equal(request.body.reference,o.row.ref);assert.equal(request.body.customer.phone_number,undefined);assert.equal(request.body.product_cart,undefined);assert.equal(request.idempotency,'bookshop/'+o.row.ref);
    assert.equal(new URL(request.body.success_url).origin,origin);assert.equal(new URL(request.body.cancel_url).origin,origin);assert.equal(new URL(request.body.cancel_url).pathname,'/books/payment-cancelled.html');assert.equal(request.body.cancel_url.includes('k='),false);
  }
});
test('A browser return or a completed API session cannot deliver books without a signed webhook',async()=>{
  const o=await order('KES','KE');complete(o);const previousReads=reads;
  const result=await verify(o,{checkout_id:'chk_another',status:'successful'});assert.equal(result.data.status,'pending');assert.equal(result.data.books,undefined);assert.equal(reads,previousReads+1);
  assert.equal((await db.prepare('SELECT status FROM orders WHERE ref=?').bind(o.row.ref).first()).status,'pending');
});
test('Invalid, stale, future and wrong-environment webhook signatures cannot mark an order paid',async()=>{
  const o=await order();complete(o);
  for(const opts of [{signature:'t=123,v1='+'0'.repeat(64)},{timestamp:Math.floor(Date.now()/1000)-301},{timestamp:Math.floor(Date.now()/1000)+301}])assert.equal((await deliver(o,opts)).response.status,401);
  const raw=JSON.stringify({id:'evt_wrong_mode',type:'checkout.completed',data:{checkout_id:o.row.provider_session}}),t=Math.floor(Date.now()/1000),signature=createHmac('sha256',secrets.test).update(t+'.'+raw).digest('hex');
  const wrong=await api('bachs/webhook/live',{method:'POST',raw,headers:{'X-Bachs-Timestamp':String(t),'X-Bachs-Signature':signature}});assert.equal(wrong.response.status,401);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM bachs_webhook_events WHERE order_ref=?').bind(o.row.ref).first()).count,0);
});
test('Signed confirmation releases each PDF and ZIP and sends one receipt across both success events',async()=>{
  const o=await order(),prior=messages.length;complete(o);
  const first=await deliver(o,{id:'evt_duplicate'});assert.equal(first.response.status,200,JSON.stringify(first.data));
  assert.equal((await deliver(o,{id:'evt_duplicate'})).response.status,200);assert.equal((await deliver(o,{type:'collection.succeeded'})).response.status,200);
  const result=await verify(o);assert.equal(result.data.status,'paid');assert.equal(result.data.amount,o.amount);assert.equal(result.data.currency,'GHS');assert.equal(result.data.books.length,2);assert.equal(messages.length,prior+1);
  assert.match(messages.at(-1).body.html,/Download all your books/);assert.equal(messages.at(-1).body.to[0],'reader@example.com');
  for(const b of result.data.books){const response=await mf.dispatchFetch(b.download_url,{headers:{Cookie:cookie}});assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'application/pdf');assert.match(await response.text(),/%PDF-1.7/);}
  const zip=await mf.dispatchFetch(result.data.all_download_url,{headers:{Cookie:cookie}});assert.equal(zip.status,200);assert.equal(zip.headers.get('Content-Type'),'application/zip');assert.equal(new DataView(await zip.arrayBuffer()).getUint32(0,true),0x04034b50);
  const {results}=await db.prepare('SELECT count FROM book_purchase_counts WHERE book_id IN (?,?)').bind(books[0].id,books[1].id).all();assert.ok(results.every(r=>r.count===0));
});
test('Mismatched references, currencies, totals and actual underpayments never release books',async()=>{
  const cases=[{checkout_id:'chk_another'},{reference:'ANOTHER_ORDER'},{currency:'KES'},{billing_currency:'KES'},{amount:'0.01'}];
  for(const changes of cases){const o=await order();complete(o,changes);await deliver(o);const r=await verify(o);assert.equal(r.data.status,'pending');assert.equal(r.data.books,undefined);}
  const o=await order();const value=complete(o);value.charge={...value.charge,status:'accepted',amount:(o.amount-.01).toFixed(2)};await deliver(o);assert.equal((await verify(o)).data.status,'underpaid');
});

test('Optional method metadata never replaces the required Bachs money and identity checks',()=>{
  const saved={ref:'BS-zambia-regression',provider_session:'chk_zambia',currency:'ZMW',amount:50.39};
  const verified={checkout_id:saved.provider_session,reference:saved.ref,currency:'ZMW',billing_currency:'ZMW',amount:'50.39',status:'COMPLETED',payment_status:'SUCCEEDED',charge:{payment_id:'pay_zambia',status:'SUCCEEDED',amount:'50.39',currency:'ZMW'}};
  for(const method of [undefined,null,'MOMO_ZMW','MOBILE_MONEY','MOMO_KES','CARD']){
    const session={...verified,payment_method:method};assert.equal(bachsPaymentIssue(saved,session),'paid',String(method));
    const invalid=[
      [{checkout_id:'chk_other'},'reference_mismatch'],[{reference:'BS-other'},'reference_mismatch'],
      [{currency:'KES'},'currency_mismatch'],[{billing_currency:'KES'},'currency_mismatch'],
      [{amount:'50.38'},'amount_mismatch'],[{charge:{...verified.charge,currency:'KES'}},'currency_mismatch'],
      [{charge:{...verified.charge,amount:'50.38'}},'underpaid'],[{charge:{...verified.charge,amount:null}},'amount_mismatch'],
      [{status:'open'},'not_successful'],[{payment_status:'processing'},'not_successful'],
      [{charge:{...verified.charge,payment_id:null}},'transaction_invalid'],
      [{charge:{...verified.charge,status:'failed'}},'failed'],[{charge:{...verified.charge,status:'accepted'}},'needs_review']
    ];
    for(const [change,code] of invalid)assert.equal(bachsPaymentIssue(saved,{...session,...change}),code,JSON.stringify(change));
  }
});

test('Full Bachs payments with missing or differently labelled methods still require signed success before delivery',async()=>{
  for(const method of [undefined,null,'MOBILE_MONEY','MOMO_KES','CARD']){
    const o=await order('ZMW','ZM',[books[0].id]),prior=messages.length;
    complete(o,{payment_method:method});
    let result=await verify(o);assert.equal(result.data.status,'pending');assert.equal(result.data.books,undefined);assert.equal(messages.length,prior);
    const notified=await deliver(o,{type:'collection.succeeded',changes:{payment_method_details:null}});assert.equal(notified.response.status,200);
    result=await verify(o);assert.equal(result.data.status,'paid');assert.equal(result.data.books.length,1);assert.equal(messages.length,prior+1);
    assert.equal((await deliver(o,{type:'checkout.completed'})).response.status,200);assert.equal(messages.length,prior+1);
  }
});

test('An accepted Bachs charge cannot masquerade as full payment or prompt another full charge',async()=>{
 const o=await order(),value=complete(o);value.charge.status='accepted';await deliver(o,{type:'collection.succeeded'});
 const result=await verify(o);assert.equal(result.data.status,'review');assert.equal(result.data.books,undefined);assert.equal(result.data.resume_url,'');assert.deepEqual(result.data.retry_books,[]);
 assert.match(result.data.message,/Do not start another payment/);assert.equal((await db.prepare('SELECT status FROM orders WHERE ref=?').bind(o.row.ref).first()).status,'review');
 value.charge.status='failed';value.payment_status='failed';await deliver(o,{type:'collection.failed'});assert.equal((await verify(o)).data.status,'review');
 value.charge.status='succeeded';value.payment_status='succeeded';await deliver(o);assert.equal((await verify(o)).data.status,'paid');
});
test('Webhook processing returns an error during provider outages and succeeds on a safe redelivery',async()=>{
  const o=await order();complete(o);readFails=true;
  try{assert.equal((await deliver(o,{id:'evt_recover_outage'})).response.status,500);}finally{readFails=false;}
  assert.equal((await deliver(o,{id:'evt_recover_outage'})).response.status,200);assert.equal((await verify(o)).data.status,'paid');
});
test('A lost create response is recovered only through a signed event and its verified order reference',async()=>{
  createResponseLost=true;let o;
  try{o=await order();assert.equal(o.response.status,502);}finally{createResponseLost=false;}
  const saved=[...sessions.values()].at(-1),row=await db.prepare('SELECT * FROM orders WHERE ref=?').bind(saved.reference).first();assert.equal(row.provider_session,null);
  saved.status='completed';saved.payment_status='succeeded';saved.charge={payment_id:'pay_recovered',status:'succeeded',amount:saved.amount,currency:saved.currency};
  const result=await deliver({row:{...row,provider_session:saved.checkout_id}});assert.equal(result.response.status,200,JSON.stringify(result.data));
  const recovered=await db.prepare('SELECT status,provider_session FROM orders WHERE ref=?').bind(row.ref).first();assert.equal(recovered.status,'paid');assert.equal(recovered.provider_session,saved.checkout_id);
});
test('Bachs secrets stay encrypted and private; unsafe hosted checkout links are refused',async()=>{
  const config=(await api('admin/settings',{auth:true})).data;assert.equal(config.has_bachs_test,true);assert.equal(config.bachs_test,undefined);assert.equal(config.bachs_webhook_test,undefined);
  const publicConfig=JSON.stringify((await api('catalog')).data);assert.equal(publicConfig.includes('sk_sandbox'),false);assert.equal(publicConfig.includes(secrets.test),false);
  assert.notEqual((await db.prepare("SELECT value FROM settings WHERE key='bachs_test'").first()).value,'sk_sandbox_test_key_value');
  assert.equal((await api('admin/bachs/check',{method:'POST',data:{mode:'test'}})).response.status,401);assert.equal((await api('admin/bachs/check',{method:'POST',auth:true,data:{mode:'test'}})).response.status,200);
  linkOverride='https://checkout.bachs.io.evil.example/c/steal';try{assert.equal((await order()).response.status,502);}finally{linkOverride=null;}
});
test('Live Bachs payments use the live API and add each purchased book once',async()=>{
  const change=await api('admin/password',{method:'POST',auth:true,data:{current_password:'only-for-test-initial-password',new_password:'test-live-portal-password',username:'owner'}});assert.equal(change.response.status,200);await login('test-live-portal-password');
  await configure({mode:'live'});const o=await order('XOF','BJ');assert.equal(o.response.status,200);assert.equal(starts.at(-1).mode,'live');assert.equal(o.data.mode,'live');assert.equal(new URL(o.data.checkout_url).hostname,'checkout.bachs.io');complete(o);
  await deliver(o,{id:'evt_live_once'});await deliver(o,{id:'evt_live_once'});assert.equal((await verify(o)).data.status,'paid');
  for(const b of books.slice(0,2)){const count=await db.prepare('SELECT count FROM book_purchase_counts WHERE book_id=?').bind(b.id).first();assert.equal(count.count,1);}
});
test('Trusted Bachs targets, decimal comparisons and rotating webhook signatures reject ambiguous input',async()=>{
  assert.ok(bachsCheckoutTarget('https://checkout.bachs.io/c/token_123'));
  for(const u of ['http://checkout.bachs.io/c/token','https://checkout.bachs.io.evil.example/c/token','https://evil.example/c/token','https://a:b@checkout.bachs.io/c/token','https://checkout.bachs.io:8443/c/token','https://checkout.bachs.io/c/token?redirect=evil','https://checkout.bachs.io/other/token'])assert.equal(bachsCheckoutTarget(u),null,u);
  assert.equal(minorUnits('12.34'),1234n);for(const value of ['12.345','1e2','NaN',NaN,-1])assert.equal(minorUnits(value),null);
  const raw='{"data":"é"}',time=Math.floor(Date.now()/1000),signature=createHmac('sha256',secrets.test).update(time+'.'+raw).digest('hex'),headers=new Headers({'X-Bachs-Signature-V2':'t='+time+',v1='+'0'.repeat(64)+',v1='+signature});
  assert.equal(await validBachsSignature(raw,headers,secrets.test),true);assert.equal(await validBachsSignature(raw+' ',headers,secrets.test),false);
});

test('Sandbox checkout URLs are trusted only for test orders and the shop allows their popup frame',async()=>{
  const sandbox='https://sandbox-checkout.bachs.io/c/test_token_123';
  assert.ok(bachsCheckoutTarget(sandbox,'test'));assert.ok(bachsCheckoutTarget('https://checkout.bachs.io/c/legacy_test_token','test'));
  for(const mode of ['live','setup','unknown'])assert.equal(bachsCheckoutTarget(sandbox,mode),null,mode);
  assert.equal(bachsCheckoutTarget(sandbox),null);
  for(const url of ['http://sandbox-checkout.bachs.io/c/test','https://sandbox-checkout.bachs.io.evil.example/c/test','https://user:secret@sandbox-checkout.bachs.io/c/test','https://sandbox-checkout.bachs.io:8443/c/test','https://sandbox-checkout.bachs.io/c/test?redirect=evil','https://sandbox-checkout.bachs.io/c/test#fragment','https://sandbox-checkout.bachs.io/other/test'])assert.equal(bachsCheckoutTarget(url,'test'),null,url);
  const response=await mf.dispatchFetch(origin+'/books/'),policy=response.headers.get('Content-Security-Policy');
  assert.match(policy,/frame-src 'self' https:\/\/checkout\.bachs\.io https:\/\/sandbox-checkout\.bachs\.io;/);
});

test('A Bachs failed attempt stays retryable and its event cannot authorize a later payment',async()=>{
  await configure({mode:'test'});const o=await order(),prior=messages.length;
  const s=sessions.get(o.row.provider_session);s.payment_status='failed';s.charge={payment_id:'pay_failed_attempt',status:'failed',amount:s.amount,currency:s.currency};
  assert.equal((await deliver(o,{type:'collection.failed',id:'evt_failed_attempt'})).response.status,200);
  let result=await verify(o);assert.equal(result.data.status,'failed');assert.equal(result.data.resume_url,o.row.checkout_url);assert.deepEqual(result.data.retry_books,[]);assert.equal(result.data.books,undefined);
  complete(o);result=await verify(o);assert.notEqual(result.data.status,'paid');assert.equal(result.data.books,undefined);assert.equal(messages.length,prior);
  await deliver(o,{type:'collection.succeeded'});assert.equal((await verify(o)).data.status,'paid');assert.equal(messages.length,prior+1);
  await deliver(o,{type:'collection.failed'});assert.equal((await verify(o)).data.status,'paid');assert.equal(messages.length,prior+1);
});
test('Bachs expiry and cancellation offer a fresh checkout and a delayed success can still recover',async()=>{
  await configure({mode:'test'});
  for(const status of ['expired','cancelled']){
    const o=await order('XOF','BJ'),s=sessions.get(o.row.provider_session);s.status=status;
    if(status==='expired')await deliver(o,{type:'checkout.expired'});
    let result=await verify(o);assert.equal(result.data.status,status);assert.equal(result.data.resume_url,'');assert.deepEqual(result.data.retry_books,books.slice(0,2).map(b=>b.id));assert.equal(result.data.currency,'XOF');assert.equal(result.data.books,undefined);
    complete(o);await deliver(o);result=await verify(o);assert.equal(result.data.status,'paid');
  }
});
test('Bachs partial payments survive expiry or another failed attempt without prompting a second full payment',async()=>{
  await configure({mode:'test'});const o=await order(),s=sessions.get(o.row.provider_session);
  s.payment_status='processing';s.charge={payment_id:'pay_partial',status:'underpaid',amount:(o.amount/2).toFixed(2),currency:s.currency};
  await deliver(o,{type:'collection.underpaid'});let result=await verify(o);
  assert.equal(result.data.status,'underpaid');assert.equal(result.data.resume_url,'');assert.deepEqual(result.data.retry_books,[]);assert.equal(result.data.books,undefined);
  s.status='expired';await deliver(o,{type:'checkout.expired'});assert.equal((await verify(o)).data.status,'underpaid');
  s.status='open';s.payment_status='failed';s.charge.status='failed';await deliver(o,{type:'collection.failed'});assert.equal((await verify(o)).data.status,'underpaid');
  complete(o);await deliver(o);assert.equal((await verify(o)).data.status,'paid');
});
test('Failed, expired and partial Bachs orders receive no payment reminders and cron recovers delayed success',async()=>{
  await configure({mode:'test'});
  const orders=[];
  for(const kind of ['failed','expired','underpaid']){
    const o=await order(),s=sessions.get(o.row.provider_session);orders.push(o);
    if(kind==='expired')s.status='expired';else{s.payment_status=kind==='failed'?'failed':'processing';s.charge={payment_id:'pay_'+kind,status:kind,amount:kind==='underpaid'?(o.amount/2).toFixed(2):s.amount,currency:s.currency};}
    await deliver(o,{type:kind==='expired'?'checkout.expired':'collection.'+kind});
    await db.prepare('UPDATE orders SET created_at=?,last_check_at=0 WHERE ref=?').bind(Math.floor(Date.now()/1000)-1000,o.row.ref).run();
  }
  const prior=messages.length;await mf.dispatchFetch(origin+'/__test_cron');
  assert.equal(messages.length,prior);
  for(const o of orders)assert.equal((await db.prepare('SELECT reminder_sent_at FROM orders WHERE ref=?').bind(o.row.ref).first()).reminder_sent_at,null);
  const o=orders[0];complete(o);readFails=true;
  try{assert.equal((await deliver(o)).response.status,500);}finally{readFails=false;}
  await db.prepare('UPDATE orders SET last_check_at=0 WHERE ref=?').bind(o.row.ref).run();await mf.dispatchFetch(origin+'/__test_cron');
  assert.equal((await db.prepare('SELECT status FROM orders WHERE ref=?').bind(o.row.ref).first()).status,'paid');assert.equal(messages.length,prior+1);
});
test('A slow stale Bachs failure cannot overwrite a concurrent verified success',async()=>{
  await configure({mode:'test'});const o=await order(),s=sessions.get(o.row.provider_session),prior=messages.length;
  s.payment_status='failed';s.charge={payment_id:'pay_stale_failed',status:'failed',amount:s.amount,currency:s.currency};
  let signal,release;const started=new Promise(resolve=>{signal=resolve;});
  holdBachsRead=async()=>{signal();await new Promise(resolve=>{release=resolve;});};
  const slow=verify(o);await started;
  complete(o);await deliver(o);release();const result=await slow;
  assert.equal(result.data.status,'paid');assert.equal((await db.prepare('SELECT status FROM orders WHERE ref=?').bind(o.row.ref).first()).status,'paid');assert.equal(messages.length,prior+1);
});
test('Flutterwave verifies failed, expired, cancelled and underpaid charges instead of trusting webhook claims',async()=>{
  await configure({mode:'test'});
  for(const status of ['failed','expired','cancelled','underpaid']){
    const o=await order('NGN','NG'),tx=flwPayment(o,{status:status==='underpaid'?'successful':status,...(status==='underpaid'?{amount:o.amount/2}:{})}),prior=messages.length;
    assert.equal((await flwWebhook(o,tx)).response.status,200);
    const result=await verify(o);assert.equal(result.data.status,status);assert.equal(result.data.books,undefined);assert.equal(messages.length,prior);
    assert.equal((await db.prepare('SELECT status FROM orders WHERE ref=?').bind(o.row.ref).first()).status,status);
    if(status==='failed')assert.equal(result.data.resume_url,o.row.checkout_url);else assert.equal(result.data.resume_url,'');
    if(status==='underpaid')assert.deepEqual(result.data.retry_books,[]);
    const sales=await api('admin/sales?status='+status+'&search='+encodeURIComponent(o.row.ref),{auth:true});
    assert.equal(sales.data.orders.length,1);assert.equal(sales.data.orders[0].provider,'flutterwave');assert.ok(sales.data.orders[0].payment_message);assert.ok(sales.data.orders[0].last_check_at);
  }
});
test('Flutterwave retries provider outages and ignores unrelated event types',async()=>{
  await configure({mode:'test'});const o=await order('NGN','NG'),tx=flwPayment(o);
  assert.equal((await flwWebhook(o,tx,{event:'transfer.completed'})).response.status,200);assert.equal((await db.prepare('SELECT status FROM orders WHERE ref=?').bind(o.row.ref).first()).status,'pending');
  flwReadFails=true;try{assert.equal((await flwWebhook(o,tx)).response.status,500);}finally{flwReadFails=false;}
  assert.equal((await flwWebhook(o,tx)).response.status,200);assert.equal((await verify(o)).data.status,'paid');
});
test('Flutterwave recovers later successful attempts and accepts a verified overpayment',async()=>{
  await configure({mode:'test'});const o=await order('NGN','NG'),failed=flwPayment(o,{status:'failed'});
  await flwWebhook(o,failed);assert.equal((await verify(o)).data.status,'failed');
  const success=flwPayment(o,{amount:o.amount+1});await flwWebhook(o,failed);
  assert.equal((await verify(o)).data.status,'paid');assert.equal((await db.prepare('SELECT provider_id FROM orders WHERE ref=?').bind(o.row.ref).first()).provider_id,String(success.id));
  const late=await order('NGN','NG');flwPayment(late,{status:'failed'});await verify(late);flwPayment(late);
  await db.prepare('UPDATE orders SET last_check_at=0 WHERE ref=?').bind(late.row.ref).run();await mf.dispatchFetch(origin+'/__test_cron');
  assert.equal((await db.prepare('SELECT status FROM orders WHERE ref=?').bind(late.row.ref).first()).status,'paid');
});
test('Failure webhooks cannot change another order and live Flutterwave duplicates count each book once',async()=>{
  await configure({mode:'test'});const wrong=await order('NGN','NG'),tx=flwPayment(wrong,{tx_ref:'ANOTHER_ORDER',status:'failed'});
  await flwWebhook(wrong,tx);assert.equal((await verify(wrong)).data.status,'pending');
  await configure({mode:'live'});const before=await db.prepare('SELECT count FROM book_purchase_counts WHERE book_id=?').bind(books[0].id).first();
  const o=await order('NGN','NG'),failed=flwPayment(o,{status:'failed'});await flwWebhook(o,failed);
  const success=flwPayment(o);await flwWebhook(o,success);await flwWebhook(o,success);await flwWebhook(o,failed);
  const after=await db.prepare('SELECT count FROM book_purchase_counts WHERE book_id=?').bind(books[0].id).first();
  assert.equal(after.count,before.count+1);assert.equal((await verify(o)).data.status,'paid');await configure({mode:'test'});
});


test('A stale failed check cannot erase a concurrent partial payment or its support instructions',async()=>{
  await configure({mode:'test'});const o=await order(),s=sessions.get(o.row.provider_session);
  s.payment_status='failed';s.charge={payment_id:'pay_old_failed',status:'failed',amount:s.amount,currency:s.currency};
  let signal,release;const started=new Promise(resolve=>{signal=resolve;});holdBachsRead=async()=>{signal();await new Promise(resolve=>{release=resolve;});};
  const slow=verify(o);await started;
  sessions.set(o.row.provider_session,{...s,payment_status:'processing',charge:{payment_id:'pay_partial_race',status:'underpaid',amount:(o.amount/2).toFixed(2),currency:s.currency}});
  await deliver(o,{type:'collection.underpaid'});release();const result=await slow;
  assert.equal(result.data.status,'underpaid');assert.equal(result.data.resume_url,'');assert.deepEqual(result.data.retry_books,[]);
  const row=await db.prepare('SELECT status,payment_code FROM orders WHERE ref=?').bind(o.row.ref).first();assert.equal(row.status,'underpaid');assert.equal(row.payment_code,'underpaid');
  const checked=await api('admin/orders/'+o.row.ref+'/check',{method:'POST',auth:true,data:{}});assert.equal(checked.data.confirmation.code,'underpaid');assert.match(checked.data.confirmation.message,/Contact support/);
});


test('Cleanup keeps unresolved partial payments and missing success confirmations while removing old unpaid checkouts',async()=>{
  await configure({mode:'test'});const partial=await order(),s=sessions.get(partial.row.provider_session);
  s.payment_status='processing';s.charge={payment_id:'pay_keep_partial',status:'underpaid',amount:(partial.amount/2).toFixed(2),currency:s.currency};await deliver(partial,{type:'collection.underpaid'});
  const waiting=await order();complete(waiting);assert.notEqual((await verify(waiting)).data.status,'paid');
  const unpaid=await order();for(const o of [partial,waiting,unpaid])await db.prepare('UPDATE orders SET created_at=? WHERE ref=?').bind(Math.floor(Date.now()/1000)-31*86400,o.row.ref).run();
  await mf.dispatchFetch(origin+'/__test_cron');
  assert.equal((await db.prepare('SELECT status FROM orders WHERE ref=?').bind(partial.row.ref).first()).status,'underpaid');
  assert.equal((await db.prepare('SELECT payment_code FROM orders WHERE ref=?').bind(waiting.row.ref).first()).payment_code,'awaiting_webhook');
  assert.equal(await db.prepare('SELECT status FROM orders WHERE ref=?').bind(unpaid.row.ref).first(),null);
});

test('The server refuses sandbox links for live orders and resumes a sandbox order with its saved test mode',async()=>{
  await db.prepare('DELETE FROM limits').run();await configure({mode:'live'});
  linkOverride='https://sandbox-checkout.bachs.io/c/test_mode_only';
  try{const denied=await order();assert.equal(denied.response.status,502);assert.match(denied.data.message,/could not open payment safely/);assert.equal(denied.row,null);}finally{linkOverride=null;}
  await configure({mode:'test'});const o=await order('TZS','TZ');assert.equal(o.response.status,200,JSON.stringify(o.data));assert.equal(o.data.mode,'test');assert.equal(new URL(o.data.checkout_url).hostname,'sandbox-checkout.bachs.io');
  await configure({mode:'live'});const waiting=await verify(o);assert.equal(waiting.data.status,'pending');assert.equal(waiting.data.mode,'test');assert.equal(waiting.data.resume_url,o.data.checkout_url);assert.equal(waiting.data.books,undefined);
  complete(o);assert.equal((await verify(o)).data.books,undefined);await deliver(o);assert.equal((await verify(o)).data.status,'paid');
  await configure({mode:'test'});
});

test('The recovery migration only queues unpaid Bachs orders with a matching signed success record',async()=>{
  const stamp=Math.floor(Date.now()/1000),cases=[
    {queue:true},{status:'paid'},{provider:'flutterwave'},{code:'amount_mismatch'},
    {proof:false},{eventMode:'test'},{eventCheckout:'chk_unrelated'},
    {eventType:'collection.failed'},{eventType:'checkout.expired'},
    {eventOrder:0}
  ],rows=[];
  for(const [index,entry] of cases.entries()){
    const row={ref:'BS-migration-'+index,session:'chk_migration_'+index,status:entry.status||'pending',provider:entry.provider||'bachs',code:entry.code||'method_mismatch',...entry};rows.push(row);
    await db.prepare('INSERT INTO orders(ref,key_hash,key_enc,name,email,amount,currency,items,status,mode,created_at,provider,provider_session,payment_code,last_check_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(row.ref,'test-hash','test-encrypted-key','Migration fixture','fixture@example.com',50.39,'ZMW','[]',row.status,'live',stamp,row.provider,row.session,row.code,stamp).run();
    if(row.proof!==false)await db.prepare('INSERT INTO bachs_webhook_events(event_id,mode,checkout_id,order_ref,event_type,payload_hash,received_at) VALUES(?,?,?,?,?,?,?)').bind('evt_migration_'+index,row.eventMode||'live',row.eventCheckout||row.session,row.eventOrder===undefined?row.ref:rows[row.eventOrder].ref,row.eventType||'collection.succeeded','test-signed-payload-hash',stamp).run();
  }
  try{
    await db.exec(await readFile(root+'migrations/0008_recheck_bachs_confirmations.sql','utf8'));
    for(const row of rows){const current=await db.prepare('SELECT status,payment_code,last_check_at FROM orders WHERE ref=?').bind(row.ref).first();assert.equal(current.status,row.status);assert.equal(current.payment_code,row.code);assert.equal(current.last_check_at,row.queue?0:stamp,row.ref);}
  }finally{
    await db.prepare("DELETE FROM bachs_webhook_events WHERE event_id LIKE 'evt_migration_%'").run();
    await db.prepare("DELETE FROM orders WHERE ref LIKE 'BS-migration-%'").run();
  }
});

test('A stuck live ZMW sale recovers through verification, sends its PDF and counts once without paying again',async()=>{
  await db.prepare('DELETE FROM limits').run();await configure({mode:'live'});
  const book=books[0],countBefore=(await db.prepare('SELECT count FROM book_purchase_counts WHERE book_id=?').bind(book.id).first()).count;
  const paid=await order('ZMW','ZM',[book.id]),duplicate=await order('ZMW','ZM',[book.id]),unsigned=await order('ZMW','ZM',[book.id]);
  // Save the already-delivered signed notification while the API is still pending,
  // then reproduce the old verifier's stored rejection of the completed session.
  assert.equal((await deliver(paid,{type:'collection.succeeded',id:'evt_stuck_zmw',changes:{payment_method_details:null}})).response.status,200);
  complete(paid,{payment_method:null});complete(unsigned,{payment_method:null});
  sessions.get(duplicate.row.provider_session).status='expired';await deliver(duplicate,{type:'checkout.expired'});
  const stamp=Math.floor(Date.now()/1000);
  for(const o of [paid,unsigned])await db.prepare("UPDATE orders SET payment_code='method_mismatch',last_check_at=? WHERE ref=?").bind(stamp,o.row.ref).run();
  // Keep other fixtures out of this cron batch so the exact once-only effects are visible.
  await db.prepare('UPDATE orders SET last_check_at=? WHERE ref!=?').bind(stamp,paid.row.ref).run();
  const prior=messages.length,checkoutCount=starts.length;
  await db.exec(await readFile(root+'migrations/0008_recheck_bachs_confirmations.sql','utf8'));
  assert.equal((await db.prepare('SELECT last_check_at FROM orders WHERE ref=?').bind(paid.row.ref).first()).last_check_at,0);
  assert.equal((await db.prepare('SELECT last_check_at FROM orders WHERE ref=?').bind(unsigned.row.ref).first()).last_check_at,stamp);
  const cron=await mf.dispatchFetch(origin+'/__test_cron');assert.equal(cron.status,200);
  const saved=await db.prepare('SELECT * FROM orders WHERE ref=?').bind(paid.row.ref).first();assert.equal(saved.status,'paid');assert.equal(saved.payment_code,'paid');assert.ok(saved.email_sent_at);assert.equal(saved.provider_id,'bachs:pay_'+paid.row.provider_session);
  assert.equal(messages.length,prior+1);assert.equal(starts.length,checkoutCount);assert.match(messages.at(-1).body.html,/\(PDF\)/);assert.match(messages.at(-1).body.html,/private download page/);
  const result=await verify(paid);assert.equal(result.data.status,'paid');assert.equal(result.data.books.length,1);
  const file=await mf.dispatchFetch(result.data.books[0].download_url);assert.equal(file.status,200);assert.equal(file.headers.get('Content-Type'),'application/pdf');assert.match(await file.text(),/%PDF-1.7/);
  await deliver(paid,{type:'collection.succeeded',id:'evt_stuck_zmw',changes:{payment_method_details:null}});await deliver(paid,{type:'checkout.completed'});await mf.dispatchFetch(origin+'/__test_cron');
  assert.equal(messages.length,prior+1);assert.equal((await db.prepare('SELECT count FROM book_purchase_counts WHERE book_id=?').bind(book.id).first()).count,countBefore+1);
  assert.equal((await db.prepare('SELECT status FROM orders WHERE ref=?').bind(duplicate.row.ref).first()).status,'expired');
  const notPaid=await verify(unsigned);assert.equal(notPaid.data.status,'pending');assert.equal(notPaid.data.books,undefined);assert.equal(messages.length,prior+1);
  await configure({mode:'test'});
});
