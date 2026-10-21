import {BRAND} from './brand.js';
import {SEED_BOOKS} from './seed.js';
import {assert,json,HttpError,bodyJson,sameOrigin,sign,verifySignature,constantEqual,decrypt,escapeHtml} from './security.js';
import {initialize,settings,catalog,purchaseCounts,automaticCurrency,rateLimit,clientIp,now,originFor} from './store.js';
import {checkout,verifyOrder,privateOrder,download,reconcile,receiptEmail,scheduled,mail} from './payments.js';
import {authorApi} from './author.js';
import {receiveBachsWebhook} from './bachs.js';
import {browserEvent,flushMeta} from './meta.js';
const BASE='/books',API=BASE+'/api/';
const headers={
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'SAMEORIGIN',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self' https://connect.facebook.net https://checkout.bachs.io; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.facebook.com; connect-src 'self' https://www.facebook.com https://connect.facebook.net; frame-src 'self' https://checkout.bachs.io https://sandbox-checkout.bachs.io; object-src 'none'; base-uri 'self'; form-action 'self' https://checkout.flutterwave.com; frame-ancestors 'self'"
};
async function publicNonce(env) {const expiry=now()+3600;return expiry+'.'+await sign(env,'public/'+expiry);}
async function checkNonce(env,req) {const [expiry,signature]=String(req.headers.get('X-BS-Nonce')||'').split('.');assert(Number(expiry)>=now()&&Number(expiry)<=now()+3660&&await verifySignature(env,'public/'+expiry,signature||''),403,'Please refresh this page and try again.');}
async function reviews(env,data) {
  const order=await privateOrder(env,data.ref,data.key);assert(order.status==='paid',403,'Complete payment before leaving a review.');
  const item=JSON.parse(order.items).find(i=>i.id===data.book);assert(item,403,'This book is not part of your order.');
  const proof=await env.DB.prepare('SELECT started_at FROM downloads WHERE order_ref=? AND book_id=?').bind(order.ref,data.book).first();assert(proof,403,'Start your book download before leaving a review.');
  const name=String(data.display_name||'').trim(),text=String(data.message||'').trim(),rating=Number(data.rating);
  assert(!data.website&&data.consent===true&&name.length>=2&&name.length<=60&&text.length>=10&&text.length<=3000&&Number.isInteger(rating)&&rating>=1&&rating<=5,400,'Add your display name, a 1 to 5 star rating and a short review.');
  await env.DB.prepare('INSERT INTO reviews(id,book_id,buyer_email,name,rating,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(book_id,buyer_email) DO UPDATE SET name=excluded.name,rating=excluded.rating,text=excluded.text,updated_at=excluded.updated_at').bind(crypto.randomUUID(),data.book,order.email,name,rating,text,now(),now()).run();return {ok:true};
}
async function handle(env,req,ctx) {
  const url=new URL(req.url),path=url.pathname;
  if(path==='/')return Response.redirect(url.origin+BASE+'/',302);
  if(path===BASE)return Response.redirect(url.origin+BASE+'/'+url.search,308);
  if(!path.startsWith(BASE+'/'))return new Response('Page not found',{status:404});
  const relative=path.slice(BASE.length);
  if(/^\/(assets\/[a-z0-9-]+\.(?:webp|svg|png|jpg)|store\.(js|css)|author\.(js|css)|upload\.js|tracking\.js|pixel-frame\.(html|js)|payment-cancelled\.(?:html|js))$/.test(relative))return env.ASSETS.fetch(new Request(url.origin+relative,req));
  assert(env.DB&&env.FILES,503,'The bookshop is still being set up. Please try again shortly.');
  await initialize(env);
  if(path.startsWith(API)){
    const action=path.slice(API.length).replace(/\/$/,'');
    if(action==='country'&&req.method==='GET'){const country=/^[A-Z]{2}$/.test(req.cf?.country||'')?req.cf.country:'OT';return json({country,currency:automaticCurrency(country,await settings(env))});}
    if(action==='counts'&&req.method==='GET')return json({books:await purchaseCounts(env)});
    if(action.startsWith('cover/')&&req.method==='GET'){
      const filename=action.slice(6);assert(/^[A-Za-z0-9_-]+\.webp$/.test(filename),404,'Cover not found.');const file=await env.FILES.get('covers/'+filename);assert(file,404,'Cover not found.');return new Response(file.body,{headers:{'Content-Type':'image/webp','Cache-Control':'public, max-age=31536000, immutable'}});
    }
    if(action==='catalog'&&req.method==='GET'){const data=await catalog(env,req);return json({...data,nonce:env.CONFIG_KEY?await publicNonce(env):''});}
    if(action.startsWith('admin/'))return authorApi(env,req,action);
    if(action==='download'&&req.method==='GET')return download(env,req);
    if(/^bachs\/webhook\/(test|live)$/.test(action)&&req.method==='POST'){
      const order=await receiveBachsWebhook(env,req,action.split('/')[2]);
      if(order){const confirmed=await reconcile(env,order);ctx.waitUntil(receiptEmail(env,confirmed,req).then(()=>flushMeta(env,2)).catch(()=>console.error('Payment delivery needs another attempt.')));}
      return json({received:true});
    }
    if(action==='webhook'&&req.method==='POST'){
      const s=await settings(env),secret=await decrypt(env,s.webhook_secret);assert(secret&&constantEqual(req.headers.get('verif-hash'),secret),401,'Webhook signature did not match.');
      const body=await bodyJson(req,64000),tx=body.data;
      if((!body.event||body.event==='charge.completed')&&tx?.tx_ref&&/^[0-9]{1,30}$/.test(String(tx.id))){const order=await env.DB.prepare('SELECT * FROM orders WHERE ref=?').bind(String(tx.tx_ref)).first();if(order&&order.provider!=='bachs'){const confirmed=await reconcile(env,order,tx.id);ctx.waitUntil(receiptEmail(env,confirmed,req).then(()=>flushMeta(env,2)).catch(()=>console.error('Payment delivery needs another attempt.')));}}
      return json({received:true});
    }
    assert(req.method==='POST',405,'This action needs a submitted form.');sameOrigin(req);await checkNonce(env,req);
    await rateLimit(env,'public/'+action+'/'+clientIp(req),action==='events'?120:action==='verify'?80:action==='checkout'?15:8,300);
    const data=await bodyJson(req,12000);
    if(action==='checkout')return json(await checkout(env,req,data));
    if(action==='verify'){const result=await verifyOrder(env,req,data);ctx.waitUntil(flushMeta(env,2).catch(()=>{}));return json(result);}
    if(action==='events'){const result=await browserEvent(env,req,data);ctx.waitUntil(flushMeta(env,2).catch(()=>{}));return json(result);}
    if(action==='review')return json(await reviews(env,data));
    if(action==='contact'){
      const name=String(data.name||'').trim(),email=String(data.email||'').trim(),message=String(data.message||'').trim();assert(!data.website&&data.consent===true&&name.length>=2&&name.length<=120&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&email.length<=200&&message.length>=10&&message.length<=5000,400,'Please check your name, email address and message.');
      const s=await settings(env);await mail(env,s,s.support_email,BRAND.store_name+' support request','<p>From: '+escapeHtml(name)+' ('+escapeHtml(email)+')</p><p>Reference: '+escapeHtml(String(data.reference||'').slice(0,120))+'</p><p>'+escapeHtml(message).replace(/\n/g,'<br>')+'</p>','contact/'+crypto.randomUUID(),email);return json({ok:true});
    }
    throw new HttpError(404,'We could not find that action.');
  }
  if(relative==='/author'||relative==='/author/'){const asset=await env.ASSETS.fetch(new Request(url.origin+'/author.html',req));return new HTMLRewriter().on('[data-store-name]',{element(el){el.setInnerContent(escapeHtml(BRAND.store_name));}}).on('title',{element(el){el.setInnerContent('Author Portal | '+escapeHtml(BRAND.store_name));}}).on('img',{element(el){el.setAttribute('src',BRAND.logo_url);el.setAttribute('alt',BRAND.store_name);}}).transform(asset);}
  const slug=decodeURIComponent(relative.replace(/^\//,'').replace(/\/$/,''));
  const config={page:'home',book:null,preview:false,base:BASE,api:BASE+'/api',assets:BASE+'/assets/',logo:BRAND.logo_url,store_name:BRAND.store_name,tagline:BRAND.tagline,homepage_title:BRAND.homepage_title,homepage_intro:BRAND.homepage_intro,catalog_intro:BRAND.catalog_intro,support_email:BRAND.support_email,books:SEED_BOOKS};
  let title=BRAND.store_name+' | Digital Books',description=BRAND.tagline,image=BRAND.logo_url;
  if(['checkout','download','contact','privacy','refunds','delivery','terms'].includes(slug)){config.page=slug;title=({refunds:'Refunds and cancellation',delivery:'Delivery',terms:'Terms of use'})[slug]||slug[0].toUpperCase()+slug.slice(1);title+=' | '+BRAND.store_name;}
  else if(slug){
    const row=await env.DB.prepare('SELECT * FROM books WHERE slug=? AND active=1').bind(slug).first();
    if(!row){const alias=await env.DB.prepare('SELECT b.slug FROM slug_aliases a JOIN books b ON b.id=a.book_id WHERE a.slug=? AND b.active=1').bind(slug).first();if(alias)return Response.redirect(url.origin+BASE+'/'+alias.slug+'/'+url.search,301);return new Response('This book is no longer available. Browse the bookshop at /books/.',{status:404});}
    const book=JSON.parse(row.data);config.page='book';config.book=row.id;title=book.title+' | '+BRAND.store_name;description=book.summary||description;image=book.image_url||BASE+'/assets/'+book.image;
  }
  const response=await env.ASSETS.fetch(new Request(url.origin+'/index.html',req));
  const transformed=new HTMLRewriter().on('[data-store-name]',{element(el){el.setInnerContent(escapeHtml(BRAND.store_name));}}).on('title',{element(el){el.setInnerContent(title);}}).on('meta[name="description"]',{element(el){el.setAttribute('content',description);}}).on('#bs-page-data',{element(el){el.setInnerContent(JSON.stringify(config).replace(/</g,'\\u003c'),{html:true});}}).on('head',{element(el){if(config.page!=='download')el.append('<link rel="canonical" href="'+escapeHtml(url.origin+path)+'"><meta property="og:title" content="'+escapeHtml(title)+'"><meta property="og:description" content="'+escapeHtml(description)+'"><meta property="og:image" content="'+escapeHtml(url.origin+image)+'">',{html:true});else el.append('<meta name="robots" content="noindex,nofollow">',{html:true});}}).transform(response);
  const final=new Response(transformed.body,transformed);final.headers.set('Cache-Control','no-store');return final;
}
export default {
  async fetch(req,env,ctx) {
    let response;
    const url=new URL(req.url),local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    try{
      if(url.protocol!=='https:'&&!local){
        if(['GET','HEAD'].includes(req.method)){url.protocol='https:';response=Response.redirect(url.href,308);}
        else throw new HttpError(400,'Use the secure HTTPS website to submit this form.');
      }else response=await handle(env,req,ctx);
    }catch(error){response=json({message:error.status?error.message:'The store could not complete that request. Please try again.',...(error.data?{data:error.data}:{})},error.status||500);if(!error.status)console.error('Store request failed:',error.name);}
    const out=new Response(response.body,response);for(const [key,value] of Object.entries(headers))out.headers.set(key,value);
    if(url.protocol==='https:'&&!local)out.headers.set('Strict-Transport-Security','max-age=31536000');
    const privatePath=/^\/books\/(?:author(?:\/|$)|api\/admin(?:\/|$)|download(?:\/|$))/.test(url.pathname);
    if(privatePath){
      out.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      out.headers.set('X-Frame-Options','DENY');out.headers.set('Cache-Control','private, no-store');out.headers.set('X-Robots-Tag','noindex, nofollow');
    }
    if(url.pathname==='/books/pixel-frame.html'){
      out.headers.delete('X-Frame-Options');
      out.headers.set('Content-Security-Policy',"default-src 'none'; script-src "+url.origin+" https://connect.facebook.net; img-src https://www.facebook.com; connect-src https://www.facebook.com https://connect.facebook.net; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors "+url.origin+"; sandbox allow-scripts");
    }
    if(url.pathname==='/books/payment-cancelled.html'){
      // Static, harmless page. Only the store and Bachs checkout may show it in a frame, so the Exit button works. The private download page stays unframeable.
      out.headers.delete('X-Frame-Options');
      out.headers.set('Content-Security-Policy',"default-src 'none'; script-src "+url.origin+"; style-src 'unsafe-inline'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors "+url.origin+" https://checkout.bachs.io https://sandbox-checkout.bachs.io");
      out.headers.set('Cache-Control','no-store');out.headers.set('X-Robots-Tag','noindex, nofollow');
    }
    return out;
  },
  async scheduled(event,env,ctx){ctx.waitUntil(initialize(env).then(()=>scheduled(env)).catch(()=>console.error('Store scheduled task needs attention.')));}
};
