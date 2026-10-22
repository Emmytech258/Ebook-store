import {createHash} from 'node:crypto';
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import mfPackage from 'miniflare';
import {downloadUrl} from '../src/payments.js';
const {Miniflare,convertV4MiniflareOptions}=mfPackage;
const root=new URL('../',import.meta.url).pathname,origin='https://store.example.invalid';
let portalPassword='only-for-test-initial-password';
let mf,db,files,nonce,cookie,csrf,books,sequence=1000,emailFails=false,staleRates=false,fxMultiplier=1,metaFails=false,checkoutLinkOverride=null;
const metaRequests=[];
const payments=new Map(),transactions=new Map(),emails=[],pdfA='%PDF-1.7\nOriginal purchased book A\n%%EOF',pdfB='%PDF-1.7\nOriginal purchased book B\n%%EOF';
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
async function external(req){
 const u=new URL(req.url);
 if(u.host==='open.er-api.com')return reply({result:'success',base_code:'NGN',time_last_update_unix:Math.floor(Date.now()/1000)-(staleRates?259200:0),rates:{NGN:1,USD:.0007*fxMultiplier,KES:.09*fxMultiplier,UGX:2.5*fxMultiplier,GHS:.008*fxMultiplier,MWK:1.3*fxMultiplier,RWF:1.1*fxMultiplier,TZS:1.9*fxMultiplier,XAF:.45*fxMultiplier,XOF:.45*fxMultiplier,ZMW:.017*fxMultiplier}});
 if(u.host==='graph.facebook.com'){const body=await req.json();metaRequests.push(body);assert.equal(u.pathname,'/v26.0/1234567890/events');return metaFails?reply({error:{code:190,message:'Token '+body.access_token+' failed'}},503):reply({events_received:1});}
 if(u.host==='api.resend.com'){if(emailFails)return reply({message:'Mail temporarily unavailable'},503);emails.push({body:await req.json(),idempotency:req.headers.get('Idempotency-Key')});return reply({id:'mail-'+emails.length});}
 if(['api.bachs.io','sandbox-api.bachs.io'].includes(u.host)){
  assert.match(req.headers.get('Authorization'),/^Bearer sk_(sandbox|live)_/);
  if(u.pathname==='/v1/checkout-sessions'&&req.method==='POST'){const body=await req.json(),p={...body,amount:Number(body.pricing.amount),currency:body.pricing.currency,redirect_url:body.success_url,provider:'bachs'};payments.set(body.reference,p);return reply({checkout_id:'chk_'+body.reference,checkout_url:'https://checkout.bachs.io/c/'+body.reference,status:'open',reference:body.reference},201);}
  return reply({data:[]});
 }
 if(u.host==='api.flutterwave.com'){
  assert.match(req.headers.get('Authorization'),/^Bearer FLWSECK(?:_TEST)?-/);
  if(u.pathname==='/v3/payments'){const p=await req.json();payments.set(p.tx_ref,p);return reply({status:'success',data:{link:checkoutLinkOverride||'https://'+(req.headers.get('Authorization').startsWith('Bearer FLWSECK_TEST-')?'checkout-v2.dev-flutterwave.com':'checkout.flutterwave.com')+'/v3/hosted/pay/'+p.tx_ref}});}
  const byId=u.pathname.match(/^\/v3\/transactions\/(\d+)\/verify$/);
  const tx=byId?transactions.get(byId[1]):[...transactions.values()].find(t=>t.tx_ref===u.searchParams.get('tx_ref'));
  return tx?reply({status:'success',data:tx}):reply({status:'error',message:'No transaction'},404);
 }
 throw new Error('Unexpected external request: '+u.host);
}
async function call(path,{method='GET',data,raw,headers={},auth=false,publicPost=false,country}={}){
 const h={...((publicPost||path.startsWith('/books/api/download?'))&&cookie?{Cookie:cookie}:{}),...(auth?{Cookie:cookie,'X-BS-CSRF':csrf}:{}),...(publicPost?{'X-BS-Nonce':nonce}:{}),...headers};
 if(method!=='GET')h.Origin=origin;
 if(data!==undefined)h['Content-Type']='application/json';
 return mf.dispatchFetch(origin+path,{method,redirect:'manual',headers:h,cf:{country:country||data?.country||'NG'},body:raw??(data!==undefined?JSON.stringify(data):undefined)});
}
async function api(path,options={}){if(path==='admin/settings'&&options.auth&&options.method==='POST')options={...options,data:{current_password:portalPassword,...options.data}};const response=await call('/books/api/'+path,options);const data=await response.json();if(typeof response.waitUntil==='function')await response.waitUntil();return {response,data};}
async function login(password='only-for-test-initial-password'){const {response,data}=await api('admin/login',{method:'POST',data:{username:'owner',password}});assert.equal(response.status,200,JSON.stringify(data));cookie=response.headers.get('set-cookie').split(';')[0];csrf=data.csrf;portalPassword=password;return response;}
async function makeOrder(ids=books.slice(0,2).map(b=>b.id),name='Test Buyer',country='NG',options={}){
 const currency={NG:'NGN',GH:'GHS',KE:'KES',UG:'UGX'}[country]||'USD';
 const fresh=(await api('catalog')).data;nonce=fresh.nonce;
 const expected_amount=ids.reduce((n,id)=>n+fresh.books.find(b=>b.id===id).prices[currency],0);
 const {response,data}=await api('checkout',{method:'POST',publicPost:true,headers:options.headers||{},data:{name,email:'buyer@example.com',meta_context:options.meta_context||{},meta_consent:options.meta_consent!==false,country,books:ids,expected_amount:Math.round(expected_amount*100)/100,consent:true}});
 assert.equal(response.status,200,JSON.stringify(data));
 const p=payments.get(data.ref),q=new URL(p.redirect_url).searchParams;
 assert.equal(new URL(p.redirect_url).origin,origin);assert.equal(new URL(p.redirect_url).pathname,'/books/download/');
 return {ref:data.ref,key:q.get('k'),payment:p};
}
function paid(order,changes={}){const tx={id:++sequence,status:'successful',tx_ref:order.ref,amount:order.payment.amount,currency:order.payment.currency,customer:{email:'buyer@example.com'},...changes};transactions.set(String(tx.id),tx);return tx;}
async function verify(order,extra={}){return api('verify',{method:'POST',publicPost:true,data:{ref:order.ref,key:order.key,...extra}});}
async function updateBook(book,extra={}){const {response,data}=await api('admin/books',{method:'POST',auth:true,data:{...book,...extra}});assert.equal(response.status,200,JSON.stringify(data));return data;}
before(async()=>{
 const bundled=await build({entryPoints:[root+'tests/harness-worker.js'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
 mf=new Miniflare(convertV4MiniflareOptions({name:'bookshop-test',cf:false,telemetry:{enabled:false},modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-10-10',bindings:{CONFIG_KEY:'test-only-encryption-key-at-least-thirty-two-characters',PUBLIC_ORIGIN:origin,AUTHOR_INITIAL_PASSWORD:'only-for-test-initial-password'},d1Databases:['DB'],r2Buckets:['FILES'],assets:{directory:root+'public',binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true},assetConfig:{html_handling:'none',not_found_handling:'none'}},outboundService:external}));
 db=await mf.getD1Database('DB');files=await mf.getR2Bucket('FILES');for(const file of (await readdir(root+'migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(root+'migrations/'+file,'utf8'));
 const catalog=(await api('catalog')).data;books=catalog.books;nonce=catalog.nonce;
});
after(async()=>{await mf?.dispose();});
test('Own-domain pages, compressed images and public catalog work without exposing private files',async()=>{
 assert.equal(books.length,5);for(const b of books){assert.equal(b.price_ngn,3500);assert.ok(b.description_html.length>1000);assert.equal(b.available,false);assert.equal(b.pdf_key,undefined);const r=await call('/books/'+b.slug+'/');assert.equal(r.status,200);assert.match(await r.text(),new RegExp(b.id));}
 for(const path of ['/books/','/books/author/','/books/checkout/','/books/download/','/books/contact/','/books/privacy/','/books/tracking.js','/books/assets/placeholder.svg']){const r=await call(path);assert.equal(r.status,200,path);assert.equal(r.headers.get('Referrer-Policy'),'no-referrer');}
 const bare=await call('/books');assert.equal(bare.status,308);assert.equal(bare.headers.get('location'),origin+'/books/');
 assert.equal((await call('/books/pdfs/private.pdf')).status,404);assert.ok((await call('/books/api/cover/../pdfs/test.pdf')).status>=400);
 const catalog=(await api('catalog')).data;assert.equal(catalog.pixel_id,'1234567890');assert.equal(catalog.checkout_enabled,false);assert.equal(catalog.books[0].prices.KES,315);assert.equal(catalog.books[0].prices.UGX,8750);assert.equal(catalog.books[0].prices.USD,null);assert.equal(catalog.books[0].prices.GHS,28);
});
test('Portal sign-in, encrypted settings, origin checks and CSRF protect all changes',async()=>{
 assert.equal((await api('admin/books')).response.status,401);
 const wrong=await api('admin/login',{method:'POST',data:{username:'owner',password:'wrong'}});assert.equal(wrong.response.status,401);
 const response=await login();assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);assert.match(response.headers.get('set-cookie'),/Secure/);
 const noCsrf=await api('admin/settings',{method:'POST',headers:{Cookie:cookie},data:{mode:'test'}});assert.equal(noCsrf.response.status,403);
 const foreign=await mf.dispatchFetch(origin+'/books/api/admin/settings',{method:'POST',headers:{Origin:'https://evil.example',Cookie:cookie,'X-BS-CSRF':csrf,'Content-Type':'application/json'},body:'{}'});assert.equal(foreign.status,403);
 const config={mode:'test',currencies:['NGN','GHS','KES','UGX','USD'],bachs_test:'sk_sandbox_secret_test_value',bachs_live:'sk_live_secret_live_value',bachs_webhook_test:'whsec_test_secret_value',bachs_webhook_live:'whsec_live_secret_value',flutterwave_test:'FLWSECK_TEST-secret-test-value',flutterwave_live:'FLWSECK-secret-live-value',webhook_secret:'test-webhook-secret-value',resend_key:'re_test-email-secret-value',from_email:'books@store.example.invalid',support_email:'support@example.invalid'};
 assert.equal((await api('admin/settings',{method:'POST',auth:true,data:config})).response.status,200);
 const get=(await api('admin/settings',{auth:true})).data;assert.equal(get.has_test_key,true);assert.equal(get.flutterwave_test,undefined);assert.equal(get.has_resend_key,true);
 const encrypted=await db.prepare("SELECT value FROM settings WHERE key='flutterwave_test'").first();assert.notEqual(encrypted.value,config.flutterwave_test);assert.equal(encrypted.value.includes('secret-test-value'),false);
 assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{mode:'live'}})).response.status,400);
 assert.equal((await api('admin/password',{method:'POST',auth:true,data:{current_password:'only-for-test-initial-password',new_password:'a-secure-test-password',username:'owner'}})).response.status,200);
 assert.equal((await api('admin/books',{auth:true})).response.status,401);await login('a-secure-test-password');
});
test('Uploads, new books, rich formatting, editable slugs and archive work through the portal',async()=>{
 assert.equal((await api('admin/upload?kind=pdf',{method:'POST',auth:true,raw:'not a pdf'})).response.status,400);
 const cover=await api('admin/upload?kind=cover',{method:'POST',auth:true,raw:await readFile(root+'tests/fixtures/cover.webp')});assert.equal(cover.response.status,200);assert.ok(cover.data.width<=1280);
 assert.equal((await call(cover.data.url)).status,200);
 const a=await api('admin/upload?kind=pdf',{method:'POST',auth:true,raw:pdfA}),b=await api('admin/upload?kind=pdf',{method:'POST',auth:true,raw:pdfB});assert.equal(a.response.status,200);assert.equal(b.response.status,200);
 let full=(await api('admin/books',{auth:true})).data.books;
 await updateBook(full[0],{pdf_key:a.data.key});await updateBook(full[1],{pdf_key:b.data.key});
 const newBook=await api('admin/books',{method:'POST',auth:true,data:{title:'Test added book',slug:'test-added-book',price_ngn:5000,active:true,pdf_key:a.data.key,image_url:cover.data.url,cross_sell:[books[0].id],description_html:'<h2 style="color:#174c3c">A new heading</h2><p><strong>Bold</strong> and <em>italic</em> <span style="background-color:#fff100;font-size:24px" onclick="alert(1)">highlight</span></p><script>alert(1)</script>'}});assert.equal(newBook.response.status,200);const id=newBook.data.id;
 let catalog=(await api('catalog')).data;assert.equal(catalog.books.length,6);const added=catalog.books.find(x=>x.id===id);assert.equal(added.available,true);assert.match(added.description_html,/font-size:24px/);assert.equal(/onclick|script|alert/.test(added.description_html),false);assert.equal(added.prices.NGN,5000);assert.equal(added.starting_sales,0);assert.equal(added.sold_count,0);
 await updateBook(added,{slug:'test-updated-book'});const oldLink=await call('/books/test-added-book/');assert.equal(oldLink.status,301);assert.equal(oldLink.headers.get('location'),origin+'/books/test-updated-book/');assert.equal((await call('/books/test-updated-book/')).status,200);
 assert.equal((await api('admin/books',{method:'POST',auth:true,data:{...added,slug:'author'}})).response.status,400);
 assert.equal((await api('admin/books',{method:'POST',auth:true,data:{title:'Duplicate',slug:books[0].slug,price_ngn:3500}})).response.status,409);
 books=(await api('catalog')).data.books;
});
test('Flutterwave sandbox links work in test mode and stay blocked in live mode',async()=>{
 const headers={'CF-Connecting-IP':'198.51.100.12'},order=await makeOrder([books[0].id],'Test Buyer','NG',{headers});
 const row=await db.prepare('SELECT checkout_url,mode FROM orders WHERE ref=?').bind(order.ref).first();assert.equal(row.mode,'test');assert.equal(new URL(row.checkout_url).hostname,'checkout-v2.dev-flutterwave.com');
 try{
  await api('admin/settings',{method:'POST',auth:true,data:{mode:'live'}});checkoutLinkOverride='https://checkout-v2.dev-flutterwave.com/v3/hosted/pay/test-link';
  const fresh=(await api('catalog')).data;nonce=fresh.nonce;
  const result=await api('checkout',{method:'POST',publicPost:true,headers,data:{name:'Test Buyer',email:'buyer@example.com',country:'NG',books:[books[0].id],expected_amount:3500,consent:true}});
  assert.equal(result.response.status,502);assert.equal(result.data.message,'We could not open payment safely.');assert.equal(result.data.checkout_url,undefined);
 }finally{checkoutLinkOverride=null;await api('admin/settings',{method:'POST',auth:true,data:{mode:'test'}});}
});
test('Server prices reject tampering; country currencies use fresh rates and no invented fallback',async()=>{
 const r=await api('checkout',{method:'POST',publicPost:true,data:{name:'Test Buyer',email:'buyer@example.com',country:'NG',books:[books[0].id],expected_amount:1,consent:true}});assert.equal(r.response.status,409);assert.equal(r.data.data.books[0].prices.NGN,3500);
 assert.equal((await api('checkout',{method:'POST',publicPost:true,data:{name:'Test Buyer',email:'buyer@example.com',country:'NG',books:[books[0].id,books[0].id],expected_amount:7000,consent:true}})).response.status,400);
 for(const [country,currency,total] of [['KE','KES',315],['UG','UGX',8750],['US','USD',2.45]]){const order=await makeOrder([books[0].id],'Test Buyer',country);assert.equal(order.payment.currency,currency);assert.equal(order.payment.amount,total);}
 staleRates=true;await db.prepare("DELETE FROM cache WHERE key IN ('fx','fx_refresh_lock')").run();let c=(await api('catalog')).data;assert.equal(c.books[0].prices.USD,null);assert.equal(c.books[0].prices.NGN,3500);staleRates=false;await db.prepare("DELETE FROM cache WHERE key IN ('fx','fx_refresh_lock')").run();
});
test('Exchange-rate prices stay fixed between midnight/noon updates even when the provider rate changes',async()=>{
 const initial=(await api('catalog')).data.books[0].prices.USD;const locked=await makeOrder([books[0].id],'Test Buyer','NG');
 // A saved pre-migration USD order must still use its original Flutterwave provider.
 const stored=await db.prepare('SELECT items FROM orders WHERE ref=?').bind(locked.ref).first(),legacyItems=JSON.parse(stored.items).map(i=>({...i,amount:initial}));
 await db.prepare("UPDATE orders SET currency='USD',amount=?,items=? WHERE ref=?").bind(initial,JSON.stringify(legacyItems),locked.ref).run();locked.payment.currency='USD';locked.payment.amount=initial;fxMultiplier=2;
 for(let i=0;i<3;i++)assert.equal((await api('catalog')).data.books[0].prices.USD,initial);
 const t=Math.floor(Date.now()/1000),previousWindow=(Math.floor(t/43200)-1)*43200;
 await db.prepare("UPDATE cache SET updated_at=? WHERE key='fx'").bind(previousWindow).run();await db.prepare("DELETE FROM cache WHERE key='fx_refresh_lock'").run();
 assert.equal((await api('catalog')).data.books[0].prices.USD,initial*2);paid(locked);const confirmed=await verify(locked);assert.equal(confirmed.data.status,'paid');assert.equal(confirmed.data.amount,initial);fxMultiplier=3;
 assert.equal((await api('catalog')).data.books[0].prices.USD,initial*2);
 fxMultiplier=1,metaFails=false;
const metaRequests=[];await db.prepare("DELETE FROM cache WHERE key IN ('fx','fx_refresh_lock')").run();await api('catalog');
});
let purchased,receipt;
test('Payment must match reference, successful status, full amount and currency before any PDF is released',async()=>{
 purchased=await makeOrder([books[0].id,books[1].id,books.find(b=>b.slug==='test-updated-book').id]);const base=paid(purchased);transactions.delete(String(base.id));
 assert.equal((await verify({...purchased,key:'wrong-private-key'})).response.status,403);
 assert.equal((await verify(purchased)).data.status,'pending');
 for(const change of [{amount:1},{currency:'USD'},{tx_ref:'ANOTHER-ORDER'},{id:'invalid-id'},{status:'failed'}]){await db.prepare("UPDATE orders SET status='pending' WHERE ref=?").bind(purchased.ref).run();transactions.set(String(base.id),{...base,...change});const r=await verify(purchased,{transaction_id:base.id});assert.equal(r.data.status,change.amount===1?'underpaid':change.status==='failed'?'failed':'pending');assert.equal(r.data.books,undefined);}
 transactions.set(String(base.id),{...base,customer:{email:'provider-billing@example.com'}});emailFails=true;let result=await verify(purchased,{transaction_id:base.id});assert.equal(result.response.status,200);assert.equal(result.data.status,'paid');assert.equal(result.data.books.length,3);assert.equal(result.data.amount,12000);assert.equal(result.data.email_accepted,false);receipt=result.data;emailFails=false;
 assert.equal((await api('review',{method:'POST',publicPost:true,data:{ref:purchased.ref,key:purchased.key,book:books[0].id,display_name:'Reader',rating:5,message:'A useful book to read.',consent:true}})).response.status,403);
 const corrupt=new URL(receipt.books[0].download_url);corrupt.searchParams.set('book',books[2].id);assert.equal((await call(corrupt.pathname+corrupt.search)).status,403);
 const expired=new URL(receipt.books[0].download_url);expired.searchParams.set('e','1');assert.equal((await call(expired.pathname+expired.search)).status,403);
 const file=await call(new URL(receipt.books[0].download_url).pathname+new URL(receipt.books[0].download_url).search);assert.equal(file.status,200);assert.equal(await file.text(),pdfA);assert.match(file.headers.get('content-disposition'),/^attachment/);
});
test('Multi-book ZIP opens correctly; purchases retain their original PDF after replacement or archiving',async()=>{
 const u=new URL(receipt.all_download_url),zip=await call(u.pathname+u.search);assert.equal(zip.status,200);assert.equal(zip.headers.get('content-type'),'application/zip');
 const dir=await mkdtemp(join(tmpdir(),'bookshop-zip-test-'));try{const path=join(dir,'books.zip');await writeFile(path,new Uint8Array(await zip.arrayBuffer()));const output=execFileSync('python',['-c','import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps([z.read(n).decode() for n in z.namelist()]))',path],{encoding:'utf8'});assert.deepEqual(JSON.parse(output),[pdfA,pdfB,pdfA]);}finally{await rm(dir,{recursive:true,force:true});}
 let full=(await api('admin/books',{auth:true})).data.books;const replacement=await api('admin/upload?kind=pdf',{method:'POST',auth:true,raw:'%PDF-1.7\nA replacement edition\n%%EOF'});await updateBook(full[0],{pdf_key:replacement.data.key});
 assert.equal((await api('admin/books/'+books[0].id,{method:'DELETE',auth:true})).response.status,200);assert.equal((await api('catalog')).data.books.some(b=>b.id===books[0].id),false);
 const r=await verify(purchased);assert.equal(r.data.books[0].can_review,true);const old=new URL(r.data.books[0].download_url);assert.equal(await (await call(old.pathname+old.search)).text(),pdfA);
 await updateBook(full[0],{active:true});
});
test('Only downloaded purchases can review; ratings are real and support can hide them',async()=>{
 const data={ref:purchased.ref,key:purchased.key,book:books[1].id,display_name:'Test Reader',rating:5,message:'A useful practical book.',consent:true};assert.equal((await api('review',{method:'POST',publicPost:true,data})).response.status,200);
 data.rating=4;data.message='Updated after reading the book.';assert.equal((await api('review',{method:'POST',publicPost:true,data})).response.status,200);
 const catalog=(await api('catalog')).data,reviews=catalog.books.find(b=>b.id===books[1].id).reviews;assert.equal(reviews.count,1);assert.equal(reviews.average,4);assert.equal(reviews.items[0].email,undefined);
 const admin=(await api('admin/reviews',{auth:true})).data;assert.equal((await api('admin/reviews/'+admin.reviews[0].id,{method:'DELETE',auth:true})).response.status,200);assert.equal((await api('catalog')).data.books.find(b=>b.id===books[1].id).reviews.count,0);
});
test('Scheduled work retries receipt email, sends one book-specific reminder, and recovers paid orders without a webhook',async()=>{
 await call('/__test_cron');assert.equal(emails.filter(e=>e.idempotency==='receipt/'+purchased.ref).length,1);await call('/__test_cron');assert.equal(emails.filter(e=>e.idempotency==='receipt/'+purchased.ref).length,1);
 const order=await makeOrder();await db.prepare('UPDATE orders SET created_at=?,last_check_at=NULL WHERE ref=?').bind(Math.floor(Date.now()/1000)-1000,order.ref).run();await call('/__test_cron');const reminders=emails.filter(e=>e.idempotency==='reminder/'+order.ref);assert.equal(reminders.length,1);for(const b of books.slice(0,2))assert.ok(reminders[0].body.html.includes(b.title));assert.ok(reminders[0].body.html.includes('/books/download/?ref='+encodeURIComponent(order.ref)+'&amp;k=')||reminders[0].body.html.includes('/books/download/?ref='+encodeURIComponent(order.ref)+'&k='));assert.ok(!reminders[0].body.html.includes('checkout.flutterwave.com'));const aged=await verify(order);assert.equal(aged.data.status,'pending');assert.equal(aged.data.resume_url,'');assert.deepEqual(aged.data.retry_books,books.slice(0,2).map(b=>b.id));assert.match(aged.data.message,/expired/);await call('/__test_cron');assert.equal(emails.filter(e=>e.idempotency==='reminder/'+order.ref).length,1);
 paid(order);await db.prepare('UPDATE orders SET last_check_at=0 WHERE ref=?').bind(order.ref).run();await call('/__test_cron');assert.equal((await db.prepare('SELECT status FROM orders WHERE ref=?').bind(order.ref).first()).status,'paid');assert.equal(emails.filter(e=>e.idempotency==='receipt/'+order.ref).length,1);
 const disabled=await makeOrder([books[1].id]);await api('admin/settings',{method:'POST',auth:true,data:{reminder_enabled:false}});paid(disabled);await db.prepare('UPDATE orders SET created_at=?,last_check_at=0 WHERE ref=?').bind(Math.floor(Date.now()/1000)-1000,disabled.ref).run();await call('/__test_cron');assert.equal((await db.prepare('SELECT status FROM orders WHERE ref=?').bind(disabled.ref).first()).status,'paid');assert.equal(emails.filter(e=>e.idempotency==='reminder/'+disabled.ref).length,0);
});
test('Webhook rejects a false secret; sales filter/export are private and protect spreadsheet cells',async()=>{
 assert.equal((await api('webhook',{method:'POST',data:{data:{tx_ref:purchased.ref,id:123}},headers:{'verif-hash':'wrong'}})).response.status,401);
 assert.equal((await api('webhook',{method:'POST',data:{data:{tx_ref:purchased.ref,id:123}},headers:{'verif-hash':'test-webhook-secret-value'}})).response.status,200);
 assert.equal((await api('admin/sales')).response.status,401);
 const hostile=await makeOrder([books[1].id],'=SUM(1,2)');paid(hostile);assert.equal((await verify(hostile)).data.status,'paid');const sales=(await api('admin/sales?status=paid&search=buyer%40example.com',{auth:true})).data;assert.ok(sales.orders.length>=3);assert.equal(sales.orders[0].key_enc,undefined);assert.equal(sales.orders[0].items,undefined);
 const exported=await call('/books/api/admin/export?search=SUM',{auth:true});assert.equal(exported.status,200);const csv=await exported.text();assert.match(csv,/"'=SUM\(1,2\)"/);assert.match(csv,/UTC/);
});

test('Conversions API token stays encrypted and private, test events need a saved code, and text styles validate',async()=>{
 assert.equal((await api('admin/test-meta',{method:'POST',data:{}})).response.status,401);
 assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{meta_enabled:true}})).response.status,400);
 assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{typography:'unknown'}})).response.status,400);
 const token='EAATest-meta-token-private-1234';
 assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{meta_access_token:token,meta_enabled:true,typography:'clean'}})).response.status,200);
 const saved=(await api('admin/settings',{auth:true})).data;assert.equal(saved.has_meta_token,true);assert.equal(saved.meta_access_token,undefined);assert.equal(saved.typography,'clean');
 const encrypted=await db.prepare("SELECT value FROM settings WHERE key='meta_access_token'").first();assert.equal(encrypted.value.includes(token),false);
 const catalog=(await api('catalog')).data;assert.equal(catalog.typography,'clean');assert.equal(catalog.conversions_api_enabled,true);assert.equal(JSON.stringify(catalog).includes(token),false);
 assert.equal((await api('admin/test-meta',{method:'POST',auth:true,data:{}})).response.status,400);
 assert.equal((await api('admin/test-meta',{method:'POST',headers:{Cookie:cookie},data:{}})).response.status,403);
 await api('admin/settings',{method:'POST',auth:true,data:{meta_test_code:'META_TEST_1'}});
 const r=await api('admin/test-meta',{method:'POST',auth:true,data:{},headers:{'CF-Connecting-IP':'102.89.1.2','User-Agent':'Test browser'}});assert.equal(r.response.status,200);assert.equal(metaRequests.at(-1).test_event_code,'META_TEST_1');assert.equal(metaRequests.at(-1).data[0].event_name,'PageView');
 const before=metaRequests.length;await api('events',{method:'POST',publicPost:true,data:{event:'PageView',event_id:'test-pageview-123',path:'/books/'}});assert.equal(metaRequests.length,before);assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM meta_events').first()).count,0);
 assert.equal((await api('events',{method:'POST',publicPost:true,data:{event:'Purchase',event_id:'forged-purchase-123',path:'/books/'}})).response.status,400);
});
let liveOrder,failedMetaEvent;
test('A verified live purchase adds one count per book and sends one deduplicated server event with hashed email',async()=>{
 assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{mode:'live'}})).response.status,200);
 const before=(await api('counts')).data.books;for(const b of before)assert.equal(b.purchase_count,0);
 const fbp='fb.1.1791650000000.123456789',fbc='fb.1.1791650000000.adclick123';
 liveOrder=await makeOrder([books[0].id,books[1].id],'Live Buyer','NG',{headers:{'CF-Connecting-IP':'102.89.1.2','User-Agent':'Reader browser'},meta_context:{fbp,fbc}});
 assert.equal(liveOrder.payment.customer.phonenumber,undefined);
 const tx=paid(liveOrder,{amount:1});assert.equal((await verify(liveOrder)).data.status,'underpaid');assert.equal(metaRequests.filter(r=>r.data[0].event_name==='Purchase').length,0);
 transactions.set(String(tx.id),{...tx,amount:liveOrder.payment.amount});
 const results=await Promise.all([verify(liveOrder),verify(liveOrder)]);for(const result of results){assert.equal(result.data.status,'paid');assert.equal(result.data.meta_event_id,'purchase-'+liveOrder.ref);}
 await call('/__test_cron');
 const sent=metaRequests.filter(r=>r.data[0].event_id==='purchase-'+liveOrder.ref);assert.equal(sent.length,1);assert.equal(sent[0].test_event_code,undefined);
 const event=sent[0].data[0];assert.equal(event.user_data.em[0],createHash('sha256').update('buyer@example.com').digest('hex'));assert.equal(event.user_data.client_ip_address,'102.89.1.2');assert.equal(event.user_data.client_user_agent,'Reader browser');assert.equal(event.user_data.fbp,fbp);assert.equal(event.user_data.fbc,fbc);assert.equal(event.event_source_url,origin+'/books/checkout/');assert.equal(event.custom_data.value,liveOrder.payment.amount);assert.equal(event.custom_data.currency,'NGN');assert.equal(JSON.stringify(event).includes(liveOrder.key),false);
 const counts=(await api('counts')).data.books;for(const id of [books[0].id,books[1].id]){const b=counts.find(b=>b.id===id);assert.equal(b.purchase_count,1);assert.equal(b.sold_count,1001);}
 await verify(liveOrder);assert.equal((await api('counts')).data.books.find(b=>b.id===books[0].id).purchase_count,1);
 const book=(await api('admin/books',{auth:true})).data.books.find(b=>b.id===books[0].id);await updateBook(book,{starting_sales:2000});assert.equal((await api('counts')).data.books.find(b=>b.id===book.id).sold_count,2001);
});
test('A failed Meta request leaves the payment paid and retries the same ID and time without counting the sale again',async()=>{
 const order=await makeOrder([books[1].id]);paid(order);metaFails=true;
 const r=await verify(order);assert.equal(r.data.status,'paid');assert.ok(r.data.books[0].download_url);
 await call('/__test_cron');
 const queued=await db.prepare('SELECT * FROM meta_events WHERE id=?').bind('purchase-'+order.ref).first();assert.equal(queued.sent_at,null);assert.ok(queued.attempts>=1);assert.equal(queued.error.includes('EAATest'),false);assert.equal(queued.payload.includes('buyer@example.com'),false);
 const requests=metaRequests.filter(r=>r.data[0].event_id==='purchase-'+order.ref);failedMetaEvent=requests[0].data[0];
 metaFails=false;await db.prepare('UPDATE meta_events SET next_attempt_at=0 WHERE id=?').bind(queued.id).run();await call('/__test_cron');
 const sent=await db.prepare('SELECT * FROM meta_events WHERE id=?').bind(queued.id).first();assert.ok(sent.sent_at);assert.equal(sent.payload,'');
 const retried=metaRequests.filter(r=>r.data[0].event_id===queued.id);assert.equal(retried.length,2);assert.equal(retried[1].data[0].event_time,failedMetaEvent.event_time);
 await call('/__test_cron');assert.equal(metaRequests.filter(r=>r.data[0].event_id===queued.id).length,2);assert.equal((await api('counts')).data.books.find(b=>b.id===books[1].id).purchase_count,2);
});
test('Server tracking rejects fabricated purchases and private page addresses, deduplicates page views and pauses when disabled',async()=>{
 assert.equal((await api('events',{method:'POST',publicPost:true,data:{event:'Purchase',event_id:'fake-purchase-123',path:'/books/'}})).response.status,400);
 assert.equal((await api('events',{method:'POST',publicPost:true,data:{event:'PageView',event_id:'private-view-123',path:'/books/download/?ref=secret&k=private'}})).response.status,400);
 const event={event:'ViewContent',event_id:'book-view-123456',path:'/books/'+books[0].slug+'/',data:{content_ids:[books[0].id],currency:'NGN',value:3500},context:{fbp:'fb.1.1791650000000.12345'}};
 assert.equal((await api('events',{method:'POST',data:event})).response.status,403);
 for(let i=0;i<2;i++)assert.equal((await api('events',{method:'POST',publicPost:true,data:event,headers:{'User-Agent':'Test browser','CF-Connecting-IP':'102.89.1.2'}})).response.status,200);
 await call('/__test_cron');assert.equal(metaRequests.filter(r=>r.data[0].event_id===event.event_id).length,1);
 await api('admin/settings',{method:'POST',auth:true,data:{meta_enabled:false}});const count=metaRequests.length;
 const order=await makeOrder([books[0].id]);paid(order);assert.equal((await verify(order)).data.status,'paid');await call('/__test_cron');assert.equal(metaRequests.length,count);assert.equal((await db.prepare('SELECT meta_user_data FROM orders WHERE ref=?').bind(order.ref).first()).meta_user_data,null);
 await api('admin/settings',{method:'POST',auth:true,data:{mode:'test'}});const prior=(await api('counts')).data.books.find(b=>b.id===books[0].id).purchase_count;
 const testOrder=await makeOrder([books[0].id]);paid(testOrder);assert.equal((await verify(testOrder)).data.status,'paid');assert.equal((await api('counts')).data.books.find(b=>b.id===books[0].id).purchase_count,prior);
});
test('Automatic checkout uses the server location and falls back to an enabled currency without asking the buyer',async()=>{
 const catalog=(await api('catalog',{country:'NG'})).data;nonce=catalog.nonce;
 const r=await api('checkout',{method:'POST',publicPost:true,country:'NG',data:{name:'Local Buyer',email:'buyer@example.com',country:'KE',books:[books[0].id],expected_amount:catalog.books.find(b=>b.id===books[0].id).prices.NGN,phone:'do-not-collect',consent:true}});assert.equal(r.response.status,200);assert.equal(payments.get(r.data.ref).currency,'NGN');assert.equal(payments.get(r.data.ref).customer.phonenumber,undefined);
 await api('admin/settings',{method:'POST',auth:true,data:{currencies:['NGN','USD']}});assert.equal((await api('country',{country:'KE'})).data.currency,'NGN');assert.equal((await api('catalog',{country:'KE'})).data.currency,'NGN');
});

test('Manual currencies use server prices and the matching gateway while keeping the detected country',async()=>{
 await api('admin/settings',{method:'POST',auth:true,data:{currencies:['NGN','KES','UGX','USD']}});
 const catalog=(await api('catalog')).data;nonce=catalog.nonce;const book=catalog.books.find(b=>b.id===books[0].id);
 for(const [currency,methods] of [['NGN','card,banktransfer,ussd'],['KES','card,mpesa'],['UGX','card,mobilemoneyuganda'],['USD','card']]){
  const r=await api('checkout',{method:'POST',publicPost:true,country:'NG',headers:{'CF-Connecting-IP':'198.51.100.10'},data:{name:'Currency Test',email:'buyer@example.com',country:'KE',currency,books:[book.id],expected_amount:book.prices[currency],consent:true}});
  assert.equal(r.response.status,200,JSON.stringify(r.data));const payment=payments.get(r.data.ref);assert.equal(payment.currency,currency);assert.equal(payment.amount,book.prices[currency]);if(currency==='NGN')assert.equal(payment.payment_options,methods);else assert.deepEqual(payment.payment_method_types,[currency==='USD'?'USD_CARD':'MOMO_'+currency]);
  const order=await db.prepare('SELECT country,currency FROM orders WHERE ref=?').bind(r.data.ref).first();assert.equal(order.country,'NG');assert.equal(order.currency,currency);
 }
 const details={name:'Currency Test',email:'buyer@example.com',currency:'GBP',books:[book.id],expected_amount:1,consent:true};
 assert.equal((await api('checkout',{method:'POST',publicPost:true,headers:{'CF-Connecting-IP':'198.51.100.10'},data:details})).response.status,400);
 await api('admin/settings',{method:'POST',auth:true,data:{currencies:['NGN']}});details.currency='USD';
 assert.equal((await api('checkout',{method:'POST',publicPost:true,headers:{'CF-Connecting-IP':'198.51.100.10'},data:details})).response.status,400);
 await api('admin/settings',{method:'POST',auth:true,data:{currencies:['NGN','KES','UGX','USD']}});
});
test('Only published books can be featured, and archiving a featured title falls back to another book',async()=>{
 const chosen=books[1].id;assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{featured_book_id:'missing-book'}})).response.status,400);
 assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{featured_book_id:chosen}})).response.status,200);
 assert.equal((await api('catalog')).data.featured_book_id,chosen);assert.equal((await api('admin/settings',{auth:true})).data.featured_book_id,chosen);
 const full=(await api('admin/books',{auth:true})).data.books.find(b=>b.id===chosen);await updateBook(full,{active:false});
 assert.notEqual((await api('catalog')).data.featured_book_id,chosen);assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{featured_book_id:chosen}})).response.status,400);await updateBook(full,{active:true});
});
test('The preference migration preserves saved sales counts and author-written descriptions',async()=>{
 const row=await db.prepare('SELECT data FROM books WHERE id=?').bind(books[0].id).first();const data=JSON.parse(row.data);data.summary='A custom question for my readers';data.starting_sales=2901;
 await db.prepare('UPDATE books SET data=? WHERE id=?').bind(JSON.stringify(data),books[0].id).run();const prior=(await api('counts')).data.books.find(b=>b.id===books[0].id).purchase_count;
 await db.exec(await readFile(root+'migrations/0004_store_preferences.sql','utf8'));
 const catalog=(await api('catalog')).data.books.find(b=>b.id===books[0].id);assert.equal(catalog.starting_sales,2901);assert.equal(catalog.sold_count,2901+prior);assert.equal(catalog.summary,data.summary);
});
test('Test payments and protected downloads work while email setup is pending, and live mode still requires email',async()=>{
 const stored=await db.prepare("SELECT key,value FROM settings WHERE key IN ('resend_key','from_email')").all();
 await db.prepare("UPDATE settings SET value='' WHERE key IN ('resend_key','from_email')").run();
 assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{mode:'test'}})).response.status,200);
 assert.equal((await api('catalog')).data.checkout_enabled,true);
 const order=await makeOrder([books[0].id],'Mail Pending Test','NG',{headers:{'CF-Connecting-IP':'198.51.100.11'}});paid(order);const result=await verify(order);
 assert.equal(result.data.status,'paid');assert.equal(result.data.email_accepted,false);
 const file=new URL(result.data.books[0].download_url);const response=await call(file.pathname+file.search);assert.equal(response.status,200);assert.match(await response.text(),/^%PDF-/);
 const live=await api('admin/settings',{method:'POST',auth:true,data:{mode:'live'}});assert.equal(live.response.status,400);assert.match(live.data.message,/email key and verified sender/);
 await db.batch(stored.results.map(row=>db.prepare('UPDATE settings SET value=? WHERE key=?').bind(row.value,row.key)));
});
test('Author payment checks explain pending results without releasing mismatched purchases or exposing private keys',async()=>{
 const order=await makeOrder([books[0].id],'Payment Check Test','NG',{headers:{'CF-Connecting-IP':'198.51.100.13'}}),path='admin/orders/'+order.ref+'/check';
 assert.equal((await api(path,{method:'POST',data:{}})).response.status,401);
 assert.equal((await api(path,{method:'POST',headers:{Cookie:cookie},data:{}})).response.status,403);
 const check=()=>api(path,{method:'POST',auth:true,data:{}});
 const missing=await check();assert.equal(missing.data.status,'pending');assert.equal(missing.data.confirmation.code,'not_found');
 const tx=paid(order,{amount:1});const mismatch=await check();assert.equal(mismatch.data.status,'underpaid');assert.equal(mismatch.data.confirmation.code,'underpaid');assert.equal(mismatch.data.confirmation.amount,1);
 assert.equal((await verify(order)).data.books,undefined);
 transactions.set(String(tx.id),{...tx,amount:order.payment.amount,customer:{email:'provider-billing@example.com'}});
 const confirmed=await check();assert.equal(confirmed.data.status,'paid');assert.equal(confirmed.data.email_accepted,true);assert.equal(confirmed.data.confirmation.code,'paid');
 const mail=emails.find(m=>m.idempotency==='receipt/'+order.ref);assert.deepEqual(mail.body.to,['buyer@example.com']);assert.equal(mail.body.html.includes('provider-billing@example.com'),false);
 const body=JSON.stringify(confirmed.data);assert.equal(body.includes(order.key),false);assert.equal(body.includes('key_enc'),false);assert.equal(body.includes('customer'),false);
 const result=await verify(order);const url=new URL(result.data.books[0].download_url),file=await call(url.pathname+url.search);assert.equal(file.status,200);assert.match(await file.text(),/^%PDF-/);
});
test('Kenya prices and multi-book checkout use the same whole-shilling total for M-Pesa',async()=>{
 fxMultiplier=340.24/315;await db.prepare("DELETE FROM cache WHERE key IN ('fx','fx_refresh_lock')").run();
 try{
  const catalog=(await api('catalog',{country:'KE'})).data;assert.equal(catalog.currency,'KES');
  for(const id of [books[0].id,books[1].id])assert.equal(catalog.books.find(b=>b.id===id).prices.KES,341);
  const order=await makeOrder([books[0].id,books[1].id],'Kenya Checkout Test','KE',{headers:{'CF-Connecting-IP':'198.51.100.14'}});
  assert.equal(order.payment.amount,682);assert.equal(order.payment.currency,'KES');assert.deepEqual(order.payment.payment_method_types,['MOMO_KES']);assert.equal(order.payment.customer.phonenumber,undefined);
  paid(order);const result=await verify(order);assert.equal(result.data.status,'pending');assert.equal(result.data.books,undefined);const saved=await db.prepare('SELECT provider,items FROM orders WHERE ref=?').bind(order.ref).first();assert.equal(saved.provider,'bachs');assert.deepEqual(JSON.parse(saved.items).map(b=>b.amount),[341,341]);
 }finally{fxMultiplier=1;await db.prepare("DELETE FROM cache WHERE key IN ('fx','fx_refresh_lock')").run();}
});

test('Sandbox payments cannot give anonymous visitors real PDFs, including older test orders after going live',async()=>{
 await db.prepare('DELETE FROM limits').run();
 assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{mode:'test'}})).response.status,200);
 const catalog=(await api('catalog')).data;nonce=catalog.nonce;const book=catalog.books.find(b=>b.id===books[0].id);
 const attempt=await api('checkout',{method:'POST',publicPost:true,headers:{Cookie:''},data:{name:'Anonymous visitor',email:'anon@example.com',books:[book.id],currency:'NGN',expected_amount:book.prices.NGN,consent:true}});
 assert.equal(attempt.response.status,403);assert.match(attempt.data.message,/author portal/);
 const testOrder=await makeOrder([book.id]);paid(testOrder);const receipt=(await verify(testOrder)).data;assert.equal(receipt.status,'paid');
 assert.equal((await api('verify',{method:'POST',publicPost:true,headers:{Cookie:''},data:{ref:testOrder.ref,key:testOrder.key,status:'successful'}})).response.status,403);
 assert.equal((await mf.dispatchFetch(receipt.books[0].download_url)).status,403);
 assert.equal((await api('admin/settings',{method:'POST',auth:true,data:{mode:'live'}})).response.status,200);
 assert.equal((await mf.dispatchFetch(receipt.books[0].download_url)).status,403);
 const liveOrder=await makeOrder([book.id],'Public Live Reader','NG',{headers:{Cookie:''}});paid(liveOrder);
 const verified=await api('verify',{method:'POST',publicPost:true,headers:{Cookie:''},data:{ref:liveOrder.ref,key:liveOrder.key}});assert.equal(verified.data.status,'paid');
 const download=await mf.dispatchFetch(verified.data.books[0].download_url);assert.equal(download.status,200);assert.equal(download.headers.get('Content-Type'),'application/pdf');
});

test('Unpaid orders, forged callbacks, changed links and direct storage paths never release a PDF or ZIP',async()=>{
 const unpaid=await makeOrder([books[0].id]),legitimate=await makeOrder([books[0].id]),transaction=paid(legitimate),receipt=(await verify(legitimate)).data;
 const spoofed=await verify(unpaid,{transaction_id:transaction.id,status:'successful',payment_status:'paid',amount:unpaid.payment.amount});assert.notEqual(spoofed.data.status,'paid');assert.equal(spoofed.data.books,undefined);
 const paidLink=new URL(receipt.books[0].download_url),stored=await db.prepare('SELECT * FROM orders WHERE ref=?').bind(unpaid.ref).first(),testEnv={CONFIG_KEY:'test-only-encryption-key-at-least-thirty-two-characters'};
 // Even a correctly signed URL cannot skip the independent paid-order and book-membership checks.
 for(const id of [books[0].id,'all']){
  const url=await downloadUrl(testEnv,{public_origin:origin},stored,id,new Request(origin));assert.equal((await mf.dispatchFetch(url)).status,403);
 }
 for(const [key,value] of [['ref',unpaid.ref],['book',books[1].id],['book','all'],['e',String(Math.floor(Date.now()/1000)+3600)],['s','fake-signature']]){
  const url=new URL(paidLink);url.searchParams.set(key,value);assert.equal((await mf.dispatchFetch(url.href)).status,403);
 }
 const purchasedRow=await db.prepare('SELECT * FROM orders WHERE ref=?').bind(legitimate.ref).first();
 const unowned=await downloadUrl(testEnv,{public_origin:origin},purchasedRow,books[1].id,new Request(origin));assert.equal((await mf.dispatchFetch(unowned)).status,403);
 const duplicate=new URL(paidLink);duplicate.searchParams.append('book',books[1].id);assert.equal((await mf.dispatchFetch(duplicate.href)).status,403);
 assert.equal((await verify({...legitimate,key:unpaid.key})).response.status,403);
 const page=await mf.dispatchFetch(origin+'/books/download/?ref='+unpaid.ref+'&k='+unpaid.key+'&status=successful');assert.equal(page.headers.get('Content-Type').includes('text/html'),true);assert.equal((await page.text()).includes(JSON.parse(stored.items)[0].pdf_key),false);
 const privateKey=JSON.parse(stored.items)[0].pdf_key;
 for(const path of ['/books/'+privateKey,'/books/assets/'+privateKey,'/books/assets/free-book.pdf','/books/api/cover/'+privateKey,'/books/.env','/books/.git/config'])assert.ok((await mf.dispatchFetch(origin+path)).status>=400,path);
 const original=await mf.dispatchFetch(paidLink.href);assert.equal(original.status,200);assert.match(await original.text(),/^%PDF-/);
});

test('A buyer who declined tracking gets the books and no Meta purchase event is queued or sent',async()=>{
 const order=await makeOrder([books[0].id],'Private Buyer','NG',{meta_consent:false,meta_context:{fbp:'fb.1.1791650000000.987654321'}});paid(order);
 const r=await verify(order);assert.equal(r.data.status,'paid');assert.ok(r.data.books[0].download_url);
 await call('/__test_cron');
 assert.ok(!(await db.prepare('SELECT id FROM meta_events WHERE id=?').bind('purchase-'+order.ref).first()));
 assert.equal(metaRequests.filter(x=>x.data[0].event_id==='purchase-'+order.ref).length,0);
});

test('Contact-form messages reach support and Reply goes to the customer, while receipts still reply to support',async()=>{
 const before=emails.length;
 const sent=await call('/books/api/contact',{method:'POST',publicPost:true,data:{name:'Visitor Name',email:'visitor@example.com',message:'I need help with my payment please.',consent:true,reference:'BS-help'}});assert.equal(sent.status,200);
 const message=emails.slice(before).find(m=>m.idempotency.startsWith('contact/'));assert.ok(message);assert.equal(message.body.to.length,1);assert.notEqual(message.body.to[0],'visitor@example.com');
 assert.equal(message.body.reply_to,'visitor@example.com');
 const receipt=emails.find(m=>m.idempotency.startsWith('receipt/'));if(receipt)assert.notEqual(receipt.body.reply_to,'visitor@example.com');
});
