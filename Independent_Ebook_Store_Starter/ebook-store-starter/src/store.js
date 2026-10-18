import {BRAND} from './brand.js';
import {SEED_BOOKS} from './seed.js';
import {assert,digest,hashPortalPassword,sanitizeHtml} from './security.js';
import {SHOP_CURRENCIES,ALL_CURRENCIES,currencyFor,configuredCurrencies,activeCurrencies,currencyDecimals} from './markets.js';
export {currencyFor} from './markets.js';
export const now=()=>Math.floor(Date.now()/1000);
const initialized=new WeakMap();
export async function initialize(env) {
  if(initialized.has(env.DB))return initialized.get(env.DB);
  const task=(async()=>{
    const exists=await env.DB.prepare("SELECT value FROM settings WHERE key='initialized'").first();
    if(exists)return;
    assert(typeof env.AUTHOR_INITIAL_PASSWORD==='string'&&env.AUTHOR_INITIAL_PASSWORD.length>=15&&env.AUTHOR_INITIAL_PASSWORD.length<=256,503,'Set a private initial author password before the first deployment.');
    const defaults={initialized:'1',mode:'setup',author_username:env.AUTHOR_INITIAL_USERNAME||'owner',author_password:await hashPortalPassword(env,env.AUTHOR_INITIAL_PASSWORD),default_password:'1',support_email:BRAND.support_email||'',from_email:'',from_name:BRAND.store_name,pixel_id:'',currencies:JSON.stringify(SHOP_CURRENCIES),reminder_enabled:'0',public_origin:env.PUBLIC_ORIGIN||'',flutterwave_test:'',flutterwave_live:'',webhook_secret:'',resend_key:'',bachs_test:'',bachs_live:'',bachs_webhook_test:'',bachs_webhook_live:''};
    const statements=[];
    for(const [key,value] of Object.entries(defaults)) statements.push(env.DB.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').bind(key,value));
    for(const [position,book] of SEED_BOOKS.entries())statements.push(env.DB.prepare('INSERT OR IGNORE INTO books(id,slug,data,price_ngn,active,position,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?)').bind(book.id,book.slug,JSON.stringify(book),book.price_ngn,position,now(),now()));
    await env.DB.batch(statements);
  })();initialized.set(env.DB,task);try{await task;}catch(error){initialized.delete(env.DB);throw error;}
}
export async function settings(env) {
  const {results}=await env.DB.prepare('SELECT key,value FROM settings').all();return Object.fromEntries(results.map(r=>[r.key,r.value]));
}
export async function saveSettings(env,values) {
  const statements=Object.entries(values).map(([key,value])=>env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,String(value)));
  if(statements.length)await env.DB.batch(statements);
}
export function originFor(env,s,request) {
  const value=s.public_origin||env.PUBLIC_ORIGIN||(request?new URL(request.url).origin:'');
  assert(value,503,'Set the website address in your author portal.');
  const u=new URL(value);assert(u.protocol==='https:'||u.hostname==='localhost'||u.hostname==='127.0.0.1',503,'Please use your HTTPS website address.');return u.origin;
}
export async function rateLimit(env,key,limit,seconds=900) {
  const hashed=await digest(key),t=now();
  const result=await env.DB.prepare('INSERT INTO limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN limits.expires_at<? THEN 1 ELSE limits.count+1 END, expires_at=CASE WHEN limits.expires_at<? THEN excluded.expires_at ELSE limits.expires_at END RETURNING count').bind(hashed,t+seconds,t,t).first();
  assert(result.count<=limit,429,'Please wait a little before trying again.');
}
export const clientIp=req=>req.headers.get('CF-Connecting-IP')||'local';
export async function upstream(env,url,options={}) {
  const response=await fetch(url,{...options,signal:AbortSignal.timeout(12000)});
  let data;try{data=await response.json();}catch{data={};}
  return {response,data};
}
export async function rates(env) {
  const cached=await env.DB.prepare("SELECT value,updated_at FROM cache WHERE key='fx'").first();
  let data;try{data=JSON.parse(cached?.value||'null');}catch{}
  // Two shared price windows: midnight and noon UTC.
  const windowFor=t=>Math.floor(t/43200),fallback=()=>data?.published_at>now()-172800?data.rates:{NGN:1};
  const sameWindow=cached&&windowFor(cached.updated_at)===windowFor(now())&&data?.published_at>now()-172800;
  if(sameWindow&&ALL_CURRENCIES.every(c=>Number(data.rates?.[c])>0))return data.rates;
  // D1 coordinates different edge locations, and limits retry attempts during an outage.
  const claim=await env.DB.prepare("INSERT INTO cache(key,value,updated_at) VALUES('fx_refresh_lock','{}',?) ON CONFLICT(key) DO UPDATE SET updated_at=excluded.updated_at WHERE cache.updated_at<?").bind(now(),now()-900).run();
  if(!claim.meta.changes)return fallback();
  try {
    const {response,data:fresh}=await upstream(env,'https://open.er-api.com/v6/latest/NGN');
    if(response.ok&&fresh.result==='success'&&fresh.base_code==='NGN'&&Number(fresh.time_last_update_unix)>now()-172800&&ALL_CURRENCIES.filter(c=>c!=='NGN').every(c=>Number(fresh.rates?.[c])>0)) {
      const normalized={rates:{...Object.fromEntries(ALL_CURRENCIES.map(c=>[c,c==='NGN'?1:Number(fresh.rates[c])])),...(sameWindow?data.rates:{})},published_at:Number(fresh.time_last_update_unix)};
      await env.DB.prepare("INSERT INTO cache(key,value,updated_at) VALUES('fx',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(JSON.stringify(normalized),now()).run();return normalized.rates;
    }
  }catch{}
  return fallback();
}
export function automaticCurrency(country,s){const ready=activeCurrencies(s),enabled=ready.length?ready:configuredCurrencies(s),local=currencyFor(country);return enabled.includes(local)?local:enabled.includes('NGN')?'NGN':enabled[0]||'NGN';}
export function startingSales(book){const legacy=String(book.sales_label||'').match(/[0-9][0-9,]*/)?.[0]?.replaceAll(',','');return Math.max(0,Math.floor(Number(book.starting_sales??legacy??0)||0));}
export async function purchaseCounts(env){
  const {results:rows}=await env.DB.prepare('SELECT book_id AS id,count FROM book_purchase_counts').all();
  const counts=new Map(rows.map(r=>[r.id,r.count]));
  const {results:books}=await env.DB.prepare('SELECT id,data FROM books WHERE active=1').all();
  return books.map(row=>{const b=JSON.parse(row.data);return {id:row.id,purchase_count:counts.get(row.id)||0,sold_count:startingSales(b)+(counts.get(row.id)||0),sold_at_least:String(b.sales_label||'').includes('+')};});
}
export function bookPrices(price,fx,s) {
  const enabled=JSON.parse(s.currencies||'["NGN"]');
  return Object.fromEntries(ALL_CURRENCIES.map(c=>{const scale=10**currencyDecimals(c);return [c,enabled.includes(c)&&Number(fx[c])>0?(currencyDecimals(c)===0?Math.ceil(price*fx[c]):Math.round(price*fx[c]*scale)/scale):null];}));
}
export function rowBook(row,privateFields=false) {
  const book={...JSON.parse(row.data),id:row.id,slug:row.slug,price_ngn:row.price_ngn,active:Boolean(row.active),available:Boolean(row.active&&row.pdf_key),position:row.position};
  if(privateFields)book.pdf_ready=Boolean(row.pdf_key),book.pdf_key=row.pdf_key||'';
  return book;
}
export function descriptionFrom(book) {
  if(book.description_html)return sanitizeHtml(book.description_html);
  const e=str=>String(str||'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
  return `<p><strong>${e(book.hook)}</strong></p>`+(book.overview||[]).map(p=>`<p>${e(p)}</p>`).join('')+'<h2>Inside this book</h2>'+(book.inside||[]).map(([h,p])=>`<h3>${e(h)}</h3><p>${e(p)}</p>`).join('')+`<h2>What makes this book useful</h2><p>${e(book.difference)}</p><h2>What this book can help you do</h2><ul>`+(book.benefits||[]).map(p=>`<li>${e(p)}</li>`).join('')+`</ul><h2>A note from the author</h2><blockquote>${e(book.note)}</blockquote><h2>Who this book is for</h2><ul>`+(book.audience||[]).map(p=>`<li>${e(p)}</li>`).join('')+'</ul><h2>The change you can work towards</h2>'+(book.shift||[]).map(p=>`<p>${e(p)}</p>`).join('');
}
export async function catalog(env,req) {
  const s=await settings(env),fx=await rates(env);
  const counts=new Map((await purchaseCounts(env)).map(b=>[b.id,b]));
  const {results:rows}=await env.DB.prepare('SELECT * FROM books WHERE active=1 ORDER BY position,created_at').all();
  const {results:reviews}=await env.DB.prepare('SELECT book_id,name,rating,text,updated_at FROM reviews WHERE hidden=0 ORDER BY updated_at DESC').all();
  const grouped=new Map();for(const r of reviews){const group=grouped.get(r.book_id)||{count:0,sum:0,items:[]};group.count++;group.sum+=r.rating;if(group.items.length<3)group.items.push({name:r.name,rating:r.rating,text:r.text,date:new Date(r.updated_at*1000).toISOString().slice(0,10)});grouped.set(r.book_id,group);}
  const books=rows.map(row=>{const b=rowBook(row),r=grouped.get(b.id);return {...b,...counts.get(b.id),description_html:descriptionFrom(b),prices:bookPrices(row.price_ngn,fx,s),reviews:r?{count:r.count,average:r.sum/r.count,items:r.items}:{count:0,average:0,items:[]}};});
  const readyCurrencies=activeCurrencies(s),checkoutEnabled=readyCurrencies.length>0&&Boolean(s.mode==='test'||s.resend_key&&s.from_email)&&Boolean(env.CONFIG_KEY);
  const country=/^[A-Z]{2}$/.test(req.cf?.country||'')?req.cf.country:'OT';
  return {books,featured_book_id:books.some(b=>b.id===s.featured_book_id)?s.featured_book_id:books[0]?.id||'',currencies:readyCurrencies.length?readyCurrencies:configuredCurrencies(s),mode:s.mode,checkout_enabled:checkoutEnabled,cart_enabled:true,reviews_enabled:true,contact_enabled:Boolean(s.resend_key&&s.from_email),store_name:BRAND.store_name,tagline:BRAND.tagline,logo_url:BRAND.logo_url,pixel_id:s.pixel_id,conversions_api_enabled:s.meta_enabled==='1'&&Boolean(s.meta_access_token),typography:s.typography||'classic',support_email:s.support_email,country,currency:automaticCurrency(country,s)};
}
