import {BRAND} from './brand.js';
import {assert,randomToken,digest,encrypt,decrypt,sign,verifySignature,escapeHtml,constantEqual} from './security.js';
import {now,settings,originFor,upstream,rates,bookPrices,automaticCurrency} from './store.js';
import {zipStream} from './zip.js';
import {authorizeTestAccess} from './portal-security.js';
import {ALL_CURRENCIES,paymentProvider,providerReady,minorUnits} from './markets.js';
import {startBachsCheckout,readBachsConfirmation,bachsCheckoutTarget} from './bachs.js';
import {attribution,metaActive,purchaseStatement,purchaseEventId,flushMeta} from './meta.js';
export function checkoutTarget(link,mode) {
  if(typeof link!=='string')return null;
  try{
    const target=new URL(link),trusted=target.hostname==='checkout.flutterwave.com'||mode==='test'&&target.hostname==='checkout-v2.dev-flutterwave.com';
    return trusted&&target.protocol==='https:'&&!target.username&&!target.password&&!target.port&&!target.hash&&/^\/v3\/hosted\/pay\/[A-Za-z0-9_-]+\/?$/.test(target.pathname)?target:null;
  }catch{return null;}
}
export async function flutterwave(env,s,path,method='GET',body,mode=s.mode) {
  const key=await decrypt(env,s[mode==='live'?'flutterwave_live':'flutterwave_test']);
  assert(key,503,'Payment setup is incomplete.');
  return upstream(env,'https://api.flutterwave.com/v3/'+path,{method,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
}
export async function checkout(env,req,data) {
  const s=await settings(env);
  await authorizeTestAccess(env,req,s.mode);
  assert(['test','live'].includes(s.mode)&&(s.mode==='test'||s.resend_key&&s.from_email),503,'Checkout is not available yet. Please contact support.');
  assert(!data.website,400,'Please check your details.');
  const name=String(data.name||'').trim(),email=String(data.email||'').trim().toLowerCase();
  assert(name.length>=2&&name.length<=120&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&email.length<=200,400,'Please enter your name and a valid email address.');
  assert(data.consent===true,400,'Please agree to purchase support before continuing.');
  assert(Array.isArray(data.books)&&data.books.length>0&&data.books.length<=50,400,'Please add at least one book to your cart.');
  const ids=[...new Set(data.books)];assert(ids.length===data.books.length&&ids.every(id=>typeof id==='string'&&/^[a-z0-9][a-z0-9-]{0,99}$/.test(id)),400,'Please check the books in your cart.');
  const detected=req.cf?.country,country=/^[A-Z]{2}$/.test(detected||'')&&detected!=='OT'?detected:/^[A-Z]{2}$/.test(String(data.country))?data.country:'OT';
  const enabled=JSON.parse(s.currencies||'["NGN"]');
  assert(data.currency==null||typeof data.currency==='string'&&ALL_CURRENCIES.includes(data.currency)&&enabled.includes(data.currency),400,'Choose an available currency at the top of the page.');
  const currency=data.currency||automaticCurrency(country,s),provider=paymentProvider(currency);
  assert(providerReady(s,provider),503,'Payment in this currency is temporarily unavailable. Please choose another currency.');
  const fx=await rates(env),items=[];
  for(const id of ids){const row=await env.DB.prepare('SELECT * FROM books WHERE id=? AND active=1').bind(id).first();assert(row&&row.pdf_key,409,'A book in your cart is not ready for purchase.');const amount=bookPrices(row.price_ngn,fx,s)[currency];assert(amount>0,409,'We could not load this currency price. Please try again later or contact support.');assert(await env.FILES.head(row.pdf_key),409,'A book in your cart is not ready for purchase.');items.push({id:row.id,title:JSON.parse(row.data).title,amount,pdf_key:row.pdf_key});}
  const amount=Math.round(items.reduce((sum,i)=>sum+i.amount,0)*100)/100;
  assert(Number.isFinite(data.expected_amount)&&Math.abs(data.expected_amount-amount)<0.005,409,'The price has changed. Please review the updated total.',{books:items.map(item=>({id:item.id,prices:{[currency]:item.amount}}))});
  const ref='BS-'+randomToken(18),key=randomToken(),origin=originFor(env,s,req);
  const metaUser=metaActive(s)?await encrypt(env,JSON.stringify(attribution(req,data.meta_context))):null;
  await env.DB.prepare('INSERT INTO orders(ref,key_hash,key_enc,name,email,country,amount,currency,items,mode,created_at,meta_user_data,provider) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(ref,await digest(key),await encrypt(env,key),name,email,country,amount,currency,JSON.stringify(items),s.mode,now(),metaUser,provider).run();
  const page=origin+'/books/download/?ref='+encodeURIComponent(ref)+'&k='+encodeURIComponent(key);
  if(provider==='bachs'){
    try{const session=await startBachsCheckout(env,s,{ref,amount,currency,name,email,mode:s.mode},page);await env.DB.prepare('UPDATE orders SET checkout_url=?,provider_session=? WHERE ref=?').bind(session.url,session.session,ref).run();return {checkout_url:session.url,ref,provider,mode:s.mode,checkout_id:session.session,return_url:page};}
    catch(error){await env.DB.prepare("UPDATE orders SET status='setup_failed' WHERE ref=? AND status='pending'").bind(ref).run();throw error;}
  }
  const methods={NGN:'card,banktransfer,ussd'};
  try{
    const {response,data:payment}=await flutterwave(env,s,'payments','POST',{tx_ref:ref,amount,currency,redirect_url:page,payment_options:methods[currency],customer:{email,name},customizations:{title:BRAND.store_name,description:items.map(i=>i.title).join(', ').slice(0,250)}});
    assert(response.ok&&payment.status==='success'&&typeof payment.data?.link==='string',502,'We could not open payment. Please try again.');
    const target=checkoutTarget(payment.data.link,s.mode);assert(target,502,'We could not open payment safely.');
    await env.DB.prepare('UPDATE orders SET checkout_url=? WHERE ref=?').bind(target.href,ref).run();return {checkout_url:target.href,ref,provider,mode:s.mode};
  }catch(error){await env.DB.prepare("UPDATE orders SET status='setup_failed' WHERE ref=? AND status='pending'").bind(ref).run();throw error;}
}
export async function privateOrder(env,ref,key) {
  assert(typeof ref==='string'&&typeof key==='string'&&ref.length<120&&key.length<120,403,'Please use your private purchase link.');
  const order=await env.DB.prepare('SELECT * FROM orders WHERE ref=?').bind(ref).first();
  assert(order&&constantEqual(await digest(key),order.key_hash),403,'Please use your private purchase link.');return order;
}
function paymentIssue(order,tx) {
  if(tx?.tx_ref!==order.ref)return 'reference_mismatch';
  if(tx.currency!==order.currency)return 'currency_mismatch';
  if(!/^[0-9]+$/.test(String(tx.id)))return 'transaction_invalid';
  const status=String(tx.status||'').toLowerCase();
  if(status==='failed')return 'failed';
  if(['cancelled','canceled'].includes(status))return 'cancelled';
  if(status==='expired')return 'expired';
  if(status!=='successful')return 'not_successful';
  const expected=minorUnits(order.amount),received=minorUnits(tx.amount);
  if(expected===null||received===null)return 'amount_mismatch';
  if(received<expected)return 'underpaid';
  // The payment reference identifies the order. A provider's billing email can differ
  // from the delivery email saved at checkout, especially in sandbox responses.
  return 'paid';
}
export function paymentMatches(order,tx) {return paymentIssue(order,tx)==='paid';}
export function confirmationMessage(code,provider='flutterwave') {
  const name=provider==='bachs'?'Bachs':'Flutterwave';
  if(code==='awaiting_webhook')return 'Waiting for the signed Bachs payment confirmation.';
  if(code==='needs_review')return 'Bachs accepted this payment on different terms. Contact support with your reference so we can confirm the amount collected. Do not start another payment yet.';
  if(code==='method_mismatch')return 'The verified payment method does not match this order currency.';
  if(code==='failed')return name+' confirmed that this payment attempt failed. You can retry payment.';
  if(code==='underpaid')return 'The payment is below the order total. Your books will appear after full payment. Contact support with your reference before starting another payment.';
  if(code==='expired')return 'This checkout expired before payment completed. You can open a fresh checkout for these books.';
  if(code==='cancelled')return 'This checkout closed before payment completed. You can open checkout again when you are ready.';
  return ({paid:name+' confirmed this payment.',not_found:name+' has not returned a transaction for this reference yet.',not_successful:name+' has not marked this transaction as successful yet.',reference_mismatch:'The verified payment reference does not match this order.',currency_mismatch:'The verified payment currency does not match this order.',amount_mismatch:'The verified payment amount does not match this order total.',transaction_invalid:name+' returned an invalid transaction identifier.'})[code]||'Payment confirmation is temporarily unavailable.';
}
export async function reconcile(env,order,transactionId) {
  if(order.status==='paid')return {...order,confirmation:{code:'paid',message:confirmationMessage('paid',order.provider)}};
  await env.DB.prepare('UPDATE orders SET last_check_at=? WHERE ref=?').bind(now(),order.ref).run();
  if(order.provider==='bachs'){
    const result=await readBachsConfirmation(env,order);
    return recordConfirmation(env,order,result);
  }
  const s=await settings(env);
  const path=transactionId&&/^[0-9]{1,30}$/.test(String(transactionId))?'transactions/'+transactionId+'/verify':'transactions/verify_by_reference?tx_ref='+encodeURIComponent(order.ref);
  let {response,data}=await flutterwave(env,s,path,'GET',undefined,order.mode);
  if(!response.ok&&response.status!==404)throw new Error('Payment confirmation is temporarily unavailable.');
  let tx=response.ok&&data.status==='success'?data.data:null,code=tx?paymentIssue(order,tx):'not_found';
  // An older failed attempt must not hide a newer payment under the same order.
  if(path.startsWith('transactions/')&&!path.startsWith('transactions/verify_by_reference')&&code!=='paid'){
    const latest=await flutterwave(env,s,'transactions/verify_by_reference?tx_ref='+encodeURIComponent(order.ref),'GET',undefined,order.mode);
    if(!latest.response.ok&&latest.response.status!==404)throw new Error('Payment confirmation is temporarily unavailable.');
    if(latest.response.ok&&latest.data.status==='success'&&latest.data.data?.tx_ref===order.ref){tx=latest.data.data;code=paymentIssue(order,tx);}
  }
  const result={code};
  if(tx){result.provider_status=String(tx.status||'').slice(0,40);result.amount=Number.isFinite(Number(tx.amount))?Number(tx.amount):null;result.currency=String(tx.currency||'').slice(0,8);if(code==='paid')result.provider_id=String(tx.id);}
  return recordConfirmation(env,order,result);
}
async function recordConfirmation(env,order,result){
  if(result.code==='paid'){
    const time=now(),statements=[env.DB.prepare("UPDATE orders SET status='paid',payment_code='paid',paid_at=?,provider_id=? WHERE ref=? AND status!='paid'").bind(time,result.provider_id,order.ref)],s=await settings(env);
    const tracking=await purchaseStatement(env,s,order,time);if(tracking)statements.push(tracking);
    await env.DB.batch(statements);
  }else{
    let status=({failed:'failed',underpaid:'underpaid',needs_review:'review',expired:'expired',cancelled:'cancelled',not_successful:'pending'})[result.code]||null;
    if(['underpaid','review'].includes(order.status))status=order.status;
    await env.DB.prepare("UPDATE orders SET status=CASE WHEN status IN ('underpaid','review') THEN status ELSE COALESCE(?,status) END,payment_code=CASE WHEN status='underpaid' THEN 'underpaid' WHEN status='review' THEN 'needs_review' ELSE ? END WHERE ref=? AND status!='paid'").bind(status,result.code,order.ref).run();
  }
  const updated=await env.DB.prepare('SELECT * FROM orders WHERE ref=?').bind(order.ref).first(),{provider_id,...confirmation}=result;
  if(updated.status==='paid')return {...updated,confirmation:{code:'paid',message:confirmationMessage('paid',order.provider)}};
  if(updated.status==='underpaid')confirmation.code='underpaid';
  if(updated.status==='review')confirmation.code='needs_review';
  return {...updated,confirmation:{...confirmation,message:confirmationMessage(confirmation.code,order.provider)}};
}
export async function downloadUrl(env,s,order,id,req,expires=now()+172800) {
  const signature=await sign(env,order.ref+'.'+id+'.'+expires);
  return originFor(env,s,req)+'/books/api/download?ref='+encodeURIComponent(order.ref)+'&book='+encodeURIComponent(id)+'&e='+expires+'&s='+encodeURIComponent(signature);
}
export async function mail(env,s,to,subject,html,idempotencyKey) {
  assert(s.resend_key&&s.from_email,503,'Email setup is incomplete.');
  const {response,data}=await upstream(env,'https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+await decrypt(env,s.resend_key),'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body:JSON.stringify({from:(s.from_name||BRAND.store_name)+' <'+s.from_email+'>',to:[to],reply_to:s.support_email,subject,html})});
  assert(response.ok&&data.id,502,'Our email service could not accept this message.');return data.id;
}
const shell=html=>'<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#172d27;line-height:1.7"><h2 style="color:#174c3c">'+escapeHtml(BRAND.store_name)+'</h2>'+html+'</div>';
export async function receiptEmail(env,order,req,manual=false) {
  if(order.status!=='paid'||(!manual&&order.email_sent_at))return Boolean(order.email_sent_at);
  const claim=await env.DB.prepare("UPDATE orders SET mail_lock=? WHERE ref=? AND status='paid' AND mail_lock<?"+(manual?'':' AND email_sent_at IS NULL')).bind(now(),order.ref,now()-90).run();if(!claim.meta.changes)return false;
  const s=await settings(env);
  try{
    const key=await decrypt(env,order.key_enc),items=JSON.parse(order.items),links=[];
    const expires=manual?now()+172800:(order.paid_at||order.created_at)+172800;
    for(const item of items)links.push('<li><a href="'+escapeHtml(await downloadUrl(env,s,order,item.id,req,expires))+'">'+escapeHtml(item.title)+' (PDF)</a></li>');
    const page=originFor(env,s,req)+'/books/download/?ref='+encodeURIComponent(order.ref)+'&k='+encodeURIComponent(key);
    const all=items.length>1?'<p><a href="'+escapeHtml(await downloadUrl(env,s,order,'all',req,expires))+'">Download all your books (ZIP)</a></p>':'';
    await mail(env,s,order.email,'Your books are ready',shell('<p>Hello '+escapeHtml(order.name)+',</p><p>Thank you for your purchase. Here are your books:</p><ul>'+links.join('')+'</ul>'+all+'<p>Direct links last 48 hours. <a href="'+escapeHtml(page)+'">Open your private download page</a> whenever you need fresh links or want to leave a review.</p><p>Reference: '+escapeHtml(order.ref)+'</p><p>For help, reply to this email.</p>'),'receipt/'+order.ref+(manual?'/'+now():''));
    await env.DB.prepare('UPDATE orders SET email_sent_at=?,mail_lock=0,mail_error=NULL WHERE ref=?').bind(now(),order.ref).run();return true;
  }catch(error){await env.DB.prepare('UPDATE orders SET mail_lock=0,mail_error=? WHERE ref=?').bind('Receipt email needs another attempt.',order.ref).run();return false;}
}
export async function verifyOrder(env,req,data) {
  let order=await privateOrder(env,data.ref,data.key);await authorizeTestAccess(env,req,order.mode);order=await reconcile(env,order,data.transaction_id);
  if(order.status!=='paid'){
    const status=['failed','underpaid','review','expired','cancelled'].includes(order.status)?order.status:'pending',pending=['not_found','not_successful','awaiting_webhook'].includes(order.confirmation?.code);
    const message=status!=='pending'?confirmationMessage(status==='review'?'needs_review':status,order.provider):pending?'We are waiting for your payment confirmation. Your books will appear here as soon as it arrives.':'The payment details need another check. Please contact support with your reference if you have paid.';
    const resumeAllowed=['failed','pending'].includes(status)&&(order.provider!=='bachs'||order.confirmation?.checkout_open),resume=resumeAllowed?(order.provider==='bachs'?bachsCheckoutTarget(order.checkout_url,order.mode):checkoutTarget(order.checkout_url,order.mode)):null;
    const retry=['failed','expired','cancelled'].includes(status)&&!resume?JSON.parse(order.items).map(i=>i.id):[];
    return {status,ref:order.ref,provider:order.provider||'flutterwave',mode:order.mode,currency:order.currency,message,resume_url:resume?.href||'',retry_books:retry};
  }
  const s=await settings(env),sent=await receiptEmail(env,order,req),items=JSON.parse(order.items),books=[];
  for(const item of items){const downloaded=await env.DB.prepare('SELECT started_at FROM downloads WHERE order_ref=? AND book_id=?').bind(order.ref,item.id).first();const review=await env.DB.prepare('SELECT name,rating,text FROM reviews WHERE book_id=? AND buyer_email=?').bind(item.id,order.email).first();books.push({id:item.id,title:item.title,amount:item.amount,download_url:await downloadUrl(env,s,order,item.id,req),can_review:Boolean(downloaded),review:review||null});}
  return {status:'paid',ref:order.ref,meta_event_id:purchaseEventId(order.ref),amount:order.amount,currency:order.currency,books,email_accepted:sent||Boolean(order.email_sent_at),all_download_url:await downloadUrl(env,s,order,books.length>1?'all':books[0].id,req)};
}
export async function download(env,req) {
  const q=new URL(req.url).searchParams,ref=q.get('ref'),id=q.get('book'),expiry=Number(q.get('e'));
  assert(q.getAll('ref').length===1&&q.getAll('book').length===1&&q.getAll('e').length===1&&q.getAll('s').length===1,403,'Please use the complete download link from your private purchase page.');
  assert(ref&&id&&Number.isSafeInteger(expiry)&&expiry>=now()&&expiry<=now()+172860&&await verifySignature(env,ref+'.'+id+'.'+expiry,q.get('s')||''),403,'This download link has expired. Open your private purchase page for a fresh link.');
  const order=await env.DB.prepare("SELECT * FROM orders WHERE ref=? AND status='paid'").bind(ref).first();assert(order,403,'We have not confirmed payment for this order.');
  await authorizeTestAccess(env,req,order.mode);
  const items=JSON.parse(order.items),selected=id==='all'?items:items.filter(i=>i.id===id);assert(selected.length,403,'This book is not part of your purchase.');
  const filenames=new Set(),entries=[];let total=0;
  for(const [index,item] of selected.entries()){const metadata=await env.FILES.head(item.pdf_key);assert(metadata,404,'Your PDF is temporarily unavailable. Please contact support.');total+=metadata.size;let filename=String(item.title).replace(/[\x00-\x1f<>:"/\\|?*]/g,' ').trim().slice(0,100)||'Book';if(filenames.has(filename.toLowerCase()))filename+=' '+(index+1);filenames.add(filename.toLowerCase());entries.push({key:item.pdf_key,filename:filename+'.pdf'});}
  assert(selected.length===1||total<=200*1024*1024,413,'Please use the individual PDF buttons for this order.');
  await env.DB.batch(selected.map(item=>env.DB.prepare('INSERT OR IGNORE INTO downloads(order_ref,book_id,started_at) VALUES(?,?,?)').bind(ref,item.id,now())));
  const zipped=id==='all'&&selected.length>1,body=zipped?zipStream(entries,env.FILES):(await env.FILES.get(entries[0].key)).body;
  const filename=zipped?'Books.zip':entries[0].filename;
  return new Response(body,{headers:{'Content-Type':zipped?'application/zip':'application/pdf','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(filename),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
}
export async function reminderEmail(env,order) {
  const s=await settings(env);if(s.reminder_enabled!=='1'||!order.checkout_url||order.reminder_sent_at||order.status!=='pending')return;
  order=await reconcile(env,order);
  if(order.status==='paid'){await receiptEmail(env,order);return;}
  const claim=await env.DB.prepare("UPDATE orders SET reminder_lock=? WHERE ref=? AND status='pending' AND reminder_sent_at IS NULL AND reminder_lock<?").bind(now(),order.ref,now()-90).run();if(!claim.meta.changes)return;
  try{
    const titles=JSON.parse(order.items).map(i=>'<li>'+escapeHtml(i.title)+'</li>').join('');
    await mail(env,s,order.email,'Your selected books are still in your cart',shell('<p>Hello '+escapeHtml(order.name)+',</p><p>You started checkout for:</p><ul>'+titles+'</ul><p>If you still want these books, <a href="'+escapeHtml(order.checkout_url)+'">continue your payment here</a>.</p><p>If you have already paid, you can ignore this message. If you need help, reply to this email and include your reference: '+escapeHtml(order.ref)+'.</p>'),'reminder/'+order.ref);
    await env.DB.prepare('UPDATE orders SET reminder_sent_at=?,reminder_lock=0,mail_error=NULL WHERE ref=?').bind(now(),order.ref).run();
  }catch{await env.DB.prepare('UPDATE orders SET reminder_lock=0,mail_error=? WHERE ref=?').bind('Checkout reminder needs another attempt.',order.ref).run();}
}
export async function scheduled(env) {
  await rates(env);
  const {results:receipts}=await env.DB.prepare("SELECT * FROM orders WHERE status='paid' AND email_sent_at IS NULL AND paid_at>? LIMIT 10").bind(now()-2592000).all();
  for(const order of receipts)await receiptEmail(env,order);
  const {results:pending}=await env.DB.prepare("SELECT * FROM orders WHERE status IN ('pending','failed','underpaid','review','expired','cancelled') AND (checkout_url IS NOT NULL OR provider_session IS NOT NULL) AND created_at>? AND (last_check_at IS NULL OR last_check_at<? OR (status='pending' AND reminder_sent_at IS NULL AND created_at<? AND last_check_at<?)) ORDER BY COALESCE(last_check_at,0),created_at LIMIT 10").bind(now()-2592000,now()-600,now()-900,now()-60).all();
  for(let order of pending){try{order=await reconcile(env,order);if(order.status==='paid')await receiptEmail(env,order);else if(order.created_at<=now()-900&&order.created_at>now()-172800)await reminderEmail(env,order);}catch{}}
  await flushMeta(env);
  await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now()),env.DB.prepare('DELETE FROM limits WHERE expires_at<?').bind(now()),env.DB.prepare("DELETE FROM orders WHERE status NOT IN ('paid','underpaid','review') AND COALESCE(payment_code,'')!='awaiting_webhook' AND created_at<?").bind(now()-2592000)]);
}
