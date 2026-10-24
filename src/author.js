import {BRAND} from './brand.js';
import {assert,json,bodyJson,sameOrigin,randomToken,digest,checkPortalPassword,hashPortalPassword,pepperPasswordHash,constantEqual,encrypt,sanitizeHtml,limitedBytes,webpDimensions,csvCell,escapeHtml} from './security.js';
import {now,settings,saveSettings,clientIp,rateLimit,rowBook,descriptionFrom,originFor,startingSales} from './store.js';
import {mail,receiptEmail,reconcile,confirmationMessage} from './payments.js';
import {testMeta} from './meta.js';
import {ALL_CURRENCIES,SHOP_CURRENCIES,activeCurrencies,configuredCurrencies} from './markets.js';
import {bachs} from './bachs.js';
import {authorSession as session,reauthenticate,secondFactor,issueSession,prepareTotp,activateTotp,replaceRecoveryCodes} from './portal-security.js';
const cookie=(req,token='',expires=3600)=>'__Secure-bs_author='+token+'; Path=/books; HttpOnly; SameSite=Strict; Max-Age='+expires+'; Secure';
export {session};
export async function authorApi(env,req,path) {
  if(path==='admin/login'&&req.method==='POST'){
    sameOrigin(req);await rateLimit(env,'login/'+clientIp(req),8,900);
    const data=await bodyJson(req,5000),s=await settings(env);
    const passwordOk=await checkPortalPassword(env,typeof data.password==='string'?data.password:'',s.author_password);
    assert(passwordOk&&typeof data.username==='string'&&constantEqual(data.username,s.author_username),401,'The sign-in details are incorrect.');
    if(s.author_totp){await rateLimit(env,'author-second-factor',20,300);await secondFactor(env,s,data.security_code);}
    if(!s.author_password.startsWith('v2.')){
      // The password already passed PBKDF2 verification. Add the pepper without a second costly derivation.
      const upgraded=await pepperPasswordHash(env,s.author_password),result=await env.DB.prepare("UPDATE settings SET value=? WHERE key='author_password' AND value=?").bind(upgraded,s.author_password).run();
      assert(result.meta.changes,401,'Your sign-in details changed. Please sign in again.');s.author_password=upgraded;
    }
    const {token,csrf}=await issueSession(env,s);
    return json({authenticated:true,csrf},200,{'Set-Cookie':cookie(req,token)});
  }
  if(path==='admin/session'&&req.method==='GET'){
    const auth=await session(env,req,false);return json({authenticated:Boolean(auth),csrf:auth?.csrf||''});
  }
  const auth=await session(env,req);
  if(!['GET','HEAD'].includes(req.method)){sameOrigin(req);assert(req.headers.get('X-BS-CSRF')===auth.csrf,403,'Please refresh your author portal and try again.');}
  const s=await settings(env);
  if(path==='admin/logout'&&req.method==='POST'){
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(auth.token_hash).run();return json({ok:true},200,{'Set-Cookie':cookie(req,'',0)});
  }
  if(path==='admin/settings'&&req.method==='GET')return json({store_name:BRAND.store_name,mode:s.mode,support_email:s.support_email,from_email:s.from_email,from_name:s.from_name,pixel_id:s.pixel_id,meta_enabled:s.meta_enabled==='1',meta_test_code:s.meta_test_code||'',has_meta_token:Boolean(s.meta_access_token),typography:s.typography||'classic',featured_book_id:s.featured_book_id||'',currencies:configuredCurrencies(s),active_currencies:activeCurrencies(s),reminder_enabled:s.reminder_enabled==='1',public_origin:originFor(env,s,req),mfa_enabled:Boolean(s.author_totp),default_password:s.default_password==='1',has_test_key:Boolean(s.flutterwave_test),has_live_key:Boolean(s.flutterwave_live),has_webhook_secret:Boolean(s.webhook_secret),has_resend_key:Boolean(s.resend_key),has_bachs_test:Boolean(s.bachs_test),has_bachs_live:Boolean(s.bachs_live),has_bachs_webhook_test:Boolean(s.bachs_webhook_test),has_bachs_webhook_live:Boolean(s.bachs_webhook_live),bachs_webhook_test_url:originFor(env,s,req)+'/books/api/bachs/webhook/test',bachs_webhook_live_url:originFor(env,s,req)+'/books/api/bachs/webhook/live',username:s.author_username,webhook_url:originFor(env,s,req)+'/books/api/webhook'});
  if(path==='admin/settings'&&req.method==='POST'){
    const data=await bodyJson(req,12000),updates={};
    for(const key of ['support_email','from_email'])if(key in data){assert(!data[key]||/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(data[key]),400,'Please enter a valid email address.');updates[key]=String(data[key]).slice(0,200);}
    if('from_name' in data){assert(!/[<>\r\n]/.test(data.from_name),400,'Please check the sender name.');updates.from_name=String(data.from_name).slice(0,100);}
    if('pixel_id' in data){assert(!data.pixel_id||/^\d{5,30}$/.test(data.pixel_id),400,'Please check the Meta Pixel ID.');updates.pixel_id=data.pixel_id;}
    if('typography' in data){assert(['classic','clean','large'].includes(data.typography),400,'Choose one of the three text styles.');updates.typography=data.typography;}
    if('featured_book_id' in data){assert(typeof data.featured_book_id==='string'&&(!data.featured_book_id||await env.DB.prepare('SELECT id FROM books WHERE id=? AND active=1').bind(data.featured_book_id).first()),400,'Choose a published book to feature.');updates.featured_book_id=data.featured_book_id;}
    if('meta_enabled' in data)updates.meta_enabled=data.meta_enabled?'1':'0';
    if('meta_test_code' in data){assert(typeof data.meta_test_code==='string'&&/^[A-Za-z0-9_-]{0,100}$/.test(data.meta_test_code),400,'Please check the Meta Test Event Code.');updates.meta_test_code=data.meta_test_code;}
    if(data.meta_access_token){assert(typeof data.meta_access_token==='string'&&data.meta_access_token.length>=20&&data.meta_access_token.length<=4096&&!/\s/.test(data.meta_access_token),400,'Please check the Conversions API token.');updates.meta_access_token=await encrypt(env,data.meta_access_token);}
    if('public_origin' in data){let u;try{u=new URL(data.public_origin);}catch{}assert(u&&u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&['','/'].includes(u.pathname),400,'Use your website address, starting with https://.');assert(u.origin===new URL(env.PUBLIC_ORIGIN||req.url).origin,400,'The website address must match the domain configured for this Worker.');updates.public_origin=u.origin;}
    if('currencies' in data){assert(Array.isArray(data.currencies)&&data.currencies.length&&data.currencies.every(c=>ALL_CURRENCIES.includes(c)),400,'Choose at least one supported currency.');updates.currencies=JSON.stringify([...new Set(data.currencies)]);}
    if('reminder_enabled' in data)updates.reminder_enabled=data.reminder_enabled?'1':'0';
    for(const key of ['flutterwave_test','flutterwave_live','webhook_secret','resend_key','bachs_test','bachs_live','bachs_webhook_test','bachs_webhook_live']){
      if(data[key]){
        assert(typeof data[key]==='string'&&data[key].length>=12&&data[key].length<=500,400,'Please check the '+key.replaceAll('_',' ')+' value.');
        if(key.startsWith('flutterwave_'))assert(/^FLWSECK(?:_TEST)?-/.test(data[key])&&(key==='flutterwave_test'?data[key].includes('_TEST-'):!data[key].includes('_TEST-')),400,'Use the matching Flutterwave v3 secret key.');
        if(key==='bachs_test'||key==='bachs_live')assert((key==='bachs_test'?/^sk_sandbox_[A-Za-z0-9_-]+$/:/^sk_live_[A-Za-z0-9_-]+$/).test(data[key]),400,'Use the matching Bachs sandbox or live API key.');
        updates[key]=await encrypt(env,data[key]);
      }
    }
    const combined={...s,...updates},mode=data.mode??s.mode;
    if(combined.meta_enabled==='1')assert(combined.pixel_id&&combined.meta_access_token,400,'Add your Pixel ID and Conversions API token before enabling API tracking.');
    assert(['setup','test','live'].includes(mode),400,'Choose setup, test or live mode.');
    if(mode!=='setup')assert(activeCurrencies({...combined,mode}).length>0,400,'Add a payment key and its webhook secret for at least one enabled currency before enabling checkout.');
    if(mode==='live')assert(combined.resend_key&&combined.from_email,400,'Add your email key and verified sender before enabling live checkout.');
    if(mode==='live')assert(combined.default_password!=='1',400,'Change your initial portal password before enabling live checkout.');
    updates.mode=mode;
    const sensitive=new Set(['mode','public_origin','support_email','from_email','from_name','pixel_id','meta_enabled','meta_test_code','meta_access_token','flutterwave_test','flutterwave_live','webhook_secret','resend_key','bachs_test','bachs_live','bachs_webhook_test','bachs_webhook_live']);
    if(Object.entries(updates).some(([key,value])=>sensitive.has(key)&&String(value)!==String(s[key]??'')))await reauthenticate(env,s,auth,data);
    await saveSettings(env,updates);return json({ok:true});
  }
  if(path==='admin/password'&&req.method==='POST'){
    const data=await bodyJson(req,5000);await reauthenticate(env,s,auth,data);
    assert(typeof data.new_password==='string'&&data.new_password.length>=15&&data.new_password.length<=256,400,'Use a password with at least 15 characters.');
    const username=String(data.username||s.author_username).trim();assert(/^[A-Za-z0-9.-]{3,60}$/.test(username),400,'Please check your username.');
    await saveSettings(env,{author_username:username,author_password:await hashPortalPassword(env,data.new_password),default_password:'0'});await env.DB.prepare('DELETE FROM sessions').run();return json({ok:true,sign_in_again:true},200,{'Set-Cookie':cookie(req,'',0)});
  }
  if(path==='admin/security/enroll'&&req.method==='POST'){
    assert(!s.author_totp,409,'An authenticator is already enabled.');
    const data=await bodyJson(req,5000);await reauthenticate(env,s,auth,data);
    return json({secret:await prepareTotp(env,auth),account:s.author_username,issuer:BRAND.store_name,expires_in:600});
  }
  if(path==='admin/security/enable'&&req.method==='POST'){
    assert(!s.author_totp,409,'An authenticator is already enabled.');
    const data=await bodyJson(req,5000);await reauthenticate(env,s,auth,data);
    const recovery_codes=await activateTotp(env,auth,data.security_code);
    await env.DB.prepare('DELETE FROM sessions').run();const {token,csrf}=await issueSession(env);
    return json({ok:true,mfa_enabled:true,csrf,recovery_codes},200,{'Set-Cookie':cookie(req,token)});
  }
  if(path==='admin/security/recovery'&&req.method==='POST'){
    assert(s.author_totp,400,'Enable an authenticator first.');
    const data=await bodyJson(req,5000);await reauthenticate(env,s,auth,data);
    const recovery_codes=await replaceRecoveryCodes(env);await env.DB.prepare('DELETE FROM sessions').run();const {token,csrf}=await issueSession(env);
    return json({ok:true,csrf,recovery_codes},200,{'Set-Cookie':cookie(req,token)});
  }
  if(path==='admin/security/disable'&&req.method==='POST'){
    assert(s.author_totp,400,'An authenticator is not enabled.');
    const data=await bodyJson(req,5000);await reauthenticate(env,s,auth,data);
    await env.DB.batch([env.DB.prepare("UPDATE settings SET value='' WHERE key='author_totp'"),env.DB.prepare("UPDATE settings SET value='-1' WHERE key='mfa_last_counter'"),env.DB.prepare('DELETE FROM author_recovery_codes'),env.DB.prepare('DELETE FROM sessions')]);
    const {token,csrf}=await issueSession(env);return json({ok:true,mfa_enabled:false,csrf},200,{'Set-Cookie':cookie(req,token)});
  }
  if(path==='admin/security/signout-all'&&req.method==='POST'){
    const data=await bodyJson(req,5000);await reauthenticate(env,s,auth,data);
    await env.DB.prepare('DELETE FROM sessions').run();return json({ok:true,sign_in_again:true},200,{'Set-Cookie':cookie(req,'',0)});
  }
  if(path==='admin/books'&&req.method==='GET'){
    const {results}=await env.DB.prepare('SELECT * FROM books ORDER BY position,created_at').all();return json({books:results.map(r=>({...rowBook(r,true),starting_sales:startingSales(JSON.parse(r.data)),description_html:descriptionFrom(JSON.parse(r.data))}))});
  }
  if(path==='admin/books'&&req.method==='POST'){
    const input=await bodyJson(req),id=input.id||'book-'+crypto.randomUUID(),old=await env.DB.prepare('SELECT * FROM books WHERE id=?').bind(id).first();
    assert(old||!input.id,404,'This book no longer exists.');
    const slug=String(input.slug||'').trim().toLowerCase();
    assert(/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)&&!['api','assets','author','checkout','download','contact','privacy','index.html','store.js','store.css'].includes(slug),400,'Use a short book link with letters, numbers and hyphens.');
    const taken=await env.DB.prepare('SELECT id AS book_id FROM books WHERE slug=? UNION SELECT book_id FROM slug_aliases WHERE slug=?').bind(slug,slug).all();assert(taken.results.every(r=>r.book_id===id),409,'Another book already uses this link.');
    const title=String(input.title||'').trim(),price=Number(input.price_ngn);assert(title.length>=2&&title.length<=200&&Number.isFinite(price)&&price>0&&price<=100000000,400,'Enter a book title and a valid naira price.');
    const base=old?JSON.parse(old.data):{image:'placeholder.svg',starting_sales:0,sales_label:'0 copies sold',overview:[],inside:[],benefits:[],audience:[],shift:[],inside_icons:[]};
    const data={...base,id,slug,title};for(const key of ['subtitle','author','category','summary','sales_label','alt','cta'])data[key]=String(input[key]??base[key]??'').trim().slice(0,key==='summary'?1500:500);
    if('starting_sales' in input){const count=Number(input.starting_sales);assert(Number.isInteger(count)&&count>=0&&count<=1000000000,400,'Enter a whole number for earlier sales.');data.starting_sales=count;}
    data.author=data.author||BRAND.store_name;data.alt=data.alt||title+' book cover';data.category=data.category||'Books';
    data.description_html=sanitizeHtml(input.description_html??descriptionFrom(base));
    if(input.image_url){assert(/^\/books\/(assets\/[a-z0-9-]+\.webp|api\/cover\/[A-Za-z0-9_-]+\.webp)$/.test(input.image_url),400,'Upload a book cover through this portal.');data.image_url=input.image_url;}
    if(input.image_small_url){assert(/^\/books\/(assets\/[a-z0-9-]+\.webp|api\/cover\/[A-Za-z0-9_-]+\.webp)$/.test(input.image_small_url),400,'Please upload a mobile cover through this portal.');data.image_small_url=input.image_small_url;}
    const {results:allIds}=await env.DB.prepare('SELECT id FROM books WHERE active=1').all(),allowed=new Set(allIds.map(b=>b.id));
    data.cross_sell=[...new Set(Array.isArray(input.cross_sell)?input.cross_sell:base.cross_sell||[])].filter(other=>other!==id&&allowed.has(other)).slice(0,20);
    const pdfKey=input.pdf_key??old?.pdf_key??null;
    if(pdfKey){assert(/^pdfs\/[A-Za-z0-9_-]+\.pdf$/.test(pdfKey)&&await env.FILES.head(pdfKey),400,'Upload the final PDF through this portal.');}
    const statements=[env.DB.prepare('DELETE FROM slug_aliases WHERE slug=? AND book_id=?').bind(slug,id)];
    if(old&&old.slug!==slug)statements.push(env.DB.prepare('INSERT INTO slug_aliases(slug,book_id) VALUES(?,?) ON CONFLICT(slug) DO UPDATE SET book_id=excluded.book_id').bind(old.slug,id));
    statements.push(env.DB.prepare('INSERT INTO books(id,slug,data,price_ngn,pdf_key,active,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,data=excluded.data,price_ngn=excluded.price_ngn,pdf_key=excluded.pdf_key,active=excluded.active,position=excluded.position,updated_at=excluded.updated_at').bind(id,slug,JSON.stringify(data),price,pdfKey,input.active===false?0:1,Number.isFinite(Number(input.position))?Math.round(Number(input.position)):old?.position??allIds.length,old?.created_at??now(),now()));
    try{await env.DB.batch(statements);}catch{throw Object.assign(new Error('That book link is already in use. Please choose another.'),{status:409});}
    return json({ok:true,id,slug,url:originFor(env,s,req)+'/books/'+slug+'/'});
  }
  if(path.startsWith('admin/books/')&&req.method==='DELETE'){
    await env.DB.prepare('UPDATE books SET active=0,updated_at=? WHERE id=?').bind(now(),path.slice(12)).run();return json({ok:true});
  }
  if(path==='admin/upload'&&req.method==='POST'){
    const kind=new URL(req.url).searchParams.get('kind');assert(['cover','pdf'].includes(kind),400,'Choose a cover or PDF.');
    const bytes=await limitedBytes(req,kind==='pdf'?20*1024*1024:750*1024);assert(bytes.length>0,400,'Choose a file to upload.');
    if(kind==='cover'){
      const dims=webpDimensions(bytes);assert(dims&&dims.width<=1280&&dims.height<=1280&&dims.width>=20&&dims.height>=20,400,'Upload a compressed WebP cover, no larger than 1280 pixels.');
      const filename=randomToken(20)+'.webp';await env.FILES.put('covers/'+filename,bytes,{httpMetadata:{contentType:'image/webp'}});return json({url:'/books/api/cover/'+filename,bytes:bytes.length,width:dims.width,height:dims.height});
    }
    assert(new TextDecoder().decode(bytes.subarray(0,1024)).includes('%PDF-'),400,'Please upload a valid PDF file.');
    const key='pdfs/'+randomToken(20)+'.pdf';await env.FILES.put(key,bytes,{httpMetadata:{contentType:'application/pdf'}});return json({key,bytes:bytes.length});
  }
  if(path==='admin/sales'&&req.method==='GET')return sales(env,req);
  if(path==='admin/export'&&req.method==='GET')return sales(env,req,true);
  if(path==='admin/reviews'&&req.method==='GET'){
    const {results}=await env.DB.prepare('SELECT r.id,r.book_id,r.name,r.rating,r.text,r.updated_at,r.hidden,b.data FROM reviews r LEFT JOIN books b ON b.id=r.book_id ORDER BY r.updated_at DESC LIMIT 200').all();return json({reviews:results.map(r=>({...r,title:r.data?JSON.parse(r.data).title:r.book_id,data:undefined}))});
  }
  if(path.startsWith('admin/reviews/')&&req.method==='DELETE'){
    await env.DB.prepare('UPDATE reviews SET hidden=1 WHERE id=?').bind(path.slice(14)).run();return json({ok:true});
  }
  if(path==='admin/test-email'&&req.method==='POST'){
    const data=await bodyJson(req,5000),to=data.email||s.support_email;assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to),400,'Enter a valid test email address.');
    await mail(env,s,to,'Your bookshop email test','<h2>'+escapeHtml(BRAND.store_name)+'</h2><p>Your email service accepted this test. Check that it reached your inbox.</p><p>Example checkout reminder:</p><p>Hello Store Owner, you started checkout for Sample Book One and Sample Book Four. If you still want these books, continue your payment using your checkout link. If you have already paid, you can ignore this message.</p>','test/'+randomToken());return json({ok:true,message:'The email service accepted your test. Please check your inbox.'});
  }
  if(path==='admin/bachs/check'&&req.method==='POST'){
    await rateLimit(env,'bachs-key-check/'+auth.token_hash,10,300);
    const data=await bodyJson(req,1000),mode=data.mode||s.mode;assert(['test','live'].includes(mode),400,'Choose test or live mode.');
    const {response}=await bachs(env,s,'checkout-sessions?limit=1','GET',undefined,mode);
    assert(response.ok,502,'Bachs did not accept this API request. Check the saved key, its environment and payments read permission.');
    return json({ok:true,message:'Bachs accepted the '+mode+' API key. Complete a payment test to confirm webhook delivery and downloads.'});
  }
  if(path==='admin/test-meta'&&req.method==='POST')return json(await testMeta(env,req));
  if(/^admin\/orders\/[^/]+\/check$/.test(path)&&req.method==='POST'){
    let order=await env.DB.prepare('SELECT * FROM orders WHERE ref=?').bind(path.split('/')[2]).first();assert(order,404,'No order matches that reference.');
    order=await reconcile(env,order);const accepted=order.status==='paid'?await receiptEmail(env,order,req):false;
    return json({ref:order.ref,status:order.status,confirmation:order.confirmation,email_accepted:accepted||Boolean(order.email_sent_at)});
  }
  if(/^admin\/orders\/[^/]+\/resend$/.test(path)&&req.method==='POST'){
    const order=await env.DB.prepare("SELECT * FROM orders WHERE ref=? AND status='paid'").bind(path.split('/')[2]).first();assert(order,404,'No paid order matches that reference.');assert(await receiptEmail(env,order,req,true),502,'The receipt email needs another attempt.');return json({ok:true});
  }
  throw Object.assign(new Error('We could not find that portal action.'),{status:404});
}
async function sales(env,req,exporting=false) {
  const q=new URL(req.url).searchParams,where=[],args=[];
  const status=q.get('status');if(['paid','pending','failed','underpaid','review','expired','cancelled','setup_failed'].includes(status)){where.push('status=?');args.push(status);}
  for(const key of ['from','to'])if(/^\d{4}-\d{2}-\d{2}$/.test(q.get(key)||'')){const t=Date.parse(q.get(key)+'T00:00:00Z')/1000;if(Number.isFinite(t)){where.push('created_at'+(key==='from'?'>=?':'<?'));args.push(t+(key==='to'?86400:0));}}
  const search=String(q.get('search')||'').trim().slice(0,200);if(search){where.push('(name LIKE ? OR email LIKE ? OR ref LIKE ?)');args.push('%'+search+'%','%'+search+'%','%'+search+'%');}
  const clause=where.length?' WHERE '+where.join(' AND '):'',page=Math.max(1,Math.min(100000,Number(q.get('page'))||1));
  const {results}=await env.DB.prepare('SELECT * FROM orders'+clause+' ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(...args,exporting?10000:50,exporting?0:(page-1)*50).all();
  const metaState=new Map();
  if(!exporting){const refs=results.filter(r=>r.status==='paid'&&r.mode==='live'&&r.meta_user_data).map(r=>'purchase-'+r.ref);
    if(refs.length){const {results:events}=await env.DB.prepare('SELECT id,sent_at,attempts FROM meta_events WHERE id IN ('+refs.map(()=>'?').join(',')+')').bind(...refs).all();for(const ev of events)metaState.set(ev.id,ev.sent_at?'sent':ev.attempts>=12?'failed':'waiting');}}
  const metaFor=row=>row.status!=='paid'||row.mode!=='live'?'':!row.meta_user_data?'no_permission':metaState.get('purchase-'+row.ref)||'not_queued';
  const rows=results.map(row=>({meta_purchase:metaFor(row),ref:row.ref,name:row.name,email:row.email,phone:row.phone,country:row.country,amount:row.amount,currency:row.currency,status:row.status,payment_code:row.payment_code,payment_message:row.payment_code?confirmationMessage(row.payment_code,row.provider):'',last_check_at:row.last_check_at,mode:row.mode,provider:row.provider||'flutterwave',created_at:row.created_at,paid_at:row.paid_at,email_sent_at:row.email_sent_at,reminder_sent_at:row.reminder_sent_at,mail_error:row.mail_error,books:JSON.parse(row.items).map(i=>i.title)}));
  if(!exporting){const totals=await env.DB.prepare('SELECT count(*) AS count FROM orders'+clause).bind(...args).first();const {results:summary}=await env.DB.prepare("SELECT currency,SUM(amount) AS amount,COUNT(*) AS orders FROM orders WHERE status='paid' AND mode='live' GROUP BY currency").all();return json({orders:rows,page,total:totals.count,summary});}
  const lines=[['Reference','Buyer name','Email','Phone','Country','Books','Amount','Currency','Status','Mode','Payment provider','Date and time (UTC)','Paid date and time (UTC)','Payment detail','Last checked (UTC)']];
  const date=value=>value?new Date(value*1000).toLocaleString('en-GB',{timeZone:'UTC',hour12:false}):'';
  for(const row of rows)lines.push([row.ref,row.name,row.email,row.phone,row.country,row.books.join('; '),row.amount,row.currency,row.status,row.mode,row.provider,date(row.created_at),date(row.paid_at),row.payment_message,date(row.last_check_at)]);
  return new Response('\ufeff'+lines.map(line=>line.map(csvCell).join(',')).join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="Revival-Fire-Forum-sales.csv"','Cache-Control':'private, no-store'}});
}
