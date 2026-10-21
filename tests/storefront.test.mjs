import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {TEST_BOOKS as SEED_BOOKS} from './fixtures/books.js';
const script=await readFile(new URL('../public/store.js',import.meta.url),'utf8');
const extra={id:'book-added-123',slug:'a-new-book',title:'A newly added book',author:'Bookshop',category:'Work',summary:'An added description.',image_url:'/books/assets/placeholder.svg',description_html:'<h2>Custom heading</h2><p><strong>Bold</strong> <em>italic</em> <span style="background-color:#ffec00;font-size:24px">coloured text</span></p>',cross_sell:[],available:true,prices:{NGN:5000,KES:450,UGX:12500,USD:3.5,GHS:40,MWK:6500,RWF:5500,TZS:9500,XAF:2250,XOF:2250,ZMW:85},reviews:{count:0,average:0,items:[]}};
const all=[...SEED_BOOKS.map(b=>({...b,available:true,prices:{NGN:3500,KES:315,UGX:8750,USD:2.45,GHS:28,MWK:4550,RWF:3850,TZS:6650,XAF:1575,XOF:1575,ZMW:59.5},reviews:{count:0,average:0,items:[]}})),extra];
const mobileCurrencies=['NGN','GHS','KES','MWK','RWF','TZS','UGX','XAF','XOF','ZMW'];
const locationCurrency={NG:'NGN',GH:'GHS',KE:'KES',MW:'MWK',RW:'RWF',TZ:'TZS',UG:'UGX',CM:'XAF',BJ:'XOF',TG:'XOF',ZM:'ZMW'};
const tick=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
class Storage{map=new Map();getItem(k){return this.map.get(k)??null;}setItem(k,v){this.map.set(k,String(v));}}
class BrowserFormData{
 constructor(form){this.values=[];for(const input of form.querySelectorAll('[name]')){if(input.disabled||(['checkbox','radio'].includes(input.type)&&!input.checked))continue;this.values.push([input.name,input.type==='checkbox'?(input.getAttribute('value')||'on'):input.value]);}}
 entries(){return this.values.values();}getAll(name){return this.values.filter(v=>v[0]===name).map(v=>v[1]);}
}
async function page(config={page:'home'},cart=[],receipt=null){
 const cfg={base:'/books',api:'/books/api',assets:'/books/assets/',logo:'/books/assets/logo.svg',preview:false,books:SEED_BOOKS,...config};
 const {window,document}=parseHTML('<!doctype html><html><head></head><body><div id="bs-page"></div><script type="application/json" id="bs-page-data">'+JSON.stringify(cfg)+'</script></body></html>');
 // Linkedom does not implement the browser's writable select.value property.
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return [...this.querySelectorAll('option')].find(o=>o.hasAttribute('selected'))?.value||this.querySelector('option')?.value||'';},set(value){for(const o of this.querySelectorAll('option'))o.toggleAttribute('selected',o.value===value);}});
 const localStorage=new Storage(),sessionStorage=config.sessionStorage||new Storage(),events=[],requests=[],navigation=[];
 const media={matches:Boolean(config.darkDevice),addEventListener:(name,fn)=>{media.listener=fn;}};window.matchMedia=()=>media;
 Object.defineProperty(window.HTMLElement.prototype,'open',{configurable:true,get(){return this.hasAttribute('open');}});window.HTMLElement.prototype.showModal=function(){this.setAttribute('open','');};window.HTMLElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new window.Event('close'));};if(!window.HTMLElement.prototype.focus)window.HTMLElement.prototype.focus=function(){};
 localStorage.setItem('bs-book-cart',JSON.stringify({books:cart,at:Date.now()}));
 const location={origin:'https://store.example.invalid',search:receipt?'?ref=BS-private&k=PRIVATE-KEY':'',assign:u=>navigation.push(u)};
 window.location=location;window.Bachs=config.bachs;window.scrollTo=()=>{};window.BSTracking={init:(...args)=>events.push(['init',...args]),track:(...args)=>events.push(args),...(config.tracking||{})};
 let releaseCatalog;let timer=0;const timers=new Map(),timerDelays=new Map();
 const fetch=async(url,options={})=>{requests.push({url,options});if(url.endsWith('/country'))return Response.json({country:config.country||'NG',currency:(locationCurrency[config.country||'NG']||'USD')});if(url.endsWith('/catalog')){if(config.holdCatalog)await new Promise(resolve=>{releaseCatalog=resolve;});return Response.json({books:config.catalogBooks||all,featured_book_id:config.featuredBook||'',currencies:config.currencies||['NGN','KES','UGX','USD'],country:config.country||'NG',currency:(locationCurrency[config.country||'NG']||'USD'),nonce:'test-nonce',mode:config.mode||'live',cart_enabled:true,checkout_enabled:true,contact_enabled:true,reviews_enabled:true,pixel_id:'1234567890',typography:config.typography||'classic',support_email:'support@example.invalid'});}if(url.endsWith('/counts'))return Response.json({books:typeof config.counts==='function'?config.counts():config.counts||[]});if(url.endsWith('/checkout'))return Response.json(config.checkoutResult||{checkout_url:config.checkoutUrl||'https://checkout.flutterwave.com/v3/hosted/pay/test'});if(url.endsWith('/verify'))return config.verifyResponse?config.verifyResponse():Response.json(receipt);throw new Error('Unexpected request: '+url);};
 const context=vm.createContext({window,document,location,localStorage,sessionStorage,fetch,FormData:BrowserFormData,URL,URLSearchParams,Intl,Date,JSON,Map,Set,Number,String,Boolean,AbortController,setTimeout:(fn,delay)=>{timers.set(++timer,fn);timerDelays.set(timer,delay);return timer;},clearTimeout:id=>{timers.delete(id);timerDelays.delete(id);}});vm.runInContext(script,context);await tick();
 return {window,document,localStorage,sessionStorage,events,requests,navigation,timers,timerDelays,media,releaseCatalog:()=>releaseCatalog()};
}
function click(p,selector){const element=p.document.querySelector(selector);assert.ok(element,selector);element.dispatchEvent(new p.window.Event('click',{bubbles:true}));}
test('New titles appear in the shop, search finds them, and cart additions stay on the same domain',async()=>{
 const p=await page();assert.equal(p.document.querySelectorAll('.bs-card').length,6);assert.equal(p.document.querySelector('[data-id="book-added-123"] h3 a').getAttribute('href'),'/books/a-new-book/');
 const search=p.document.getElementById('bs-search');search.value='newly';search.dispatchEvent(new p.window.Event('input',{bubbles:true}));assert.equal(p.document.querySelectorAll('.bs-card').length,1);click(p,'[data-add-cart="book-added-123"]');const saved=JSON.parse(p.localStorage.getItem('bs-book-cart'));assert.deepEqual(saved.books,['book-added-123']);assert.equal(p.document.querySelector('[data-cart-count]').textContent,'1');assert.equal(p.events.filter(e=>e[0]==='AddToCart').length,1);assert.ok(p.requests.every(r=>r.url.startsWith('/books/api/')));
});
test('New-book page renders its full rich description and uses editable public slugs',async()=>{
 const p=await page({page:'book',book:extra.id});assert.equal(p.document.querySelector('.bs-book-intro h1').textContent,extra.title);assert.equal(p.document.querySelector('.bs-book-copy h2').textContent,'Custom heading');assert.equal(p.document.querySelector('.bs-book-copy strong').textContent,'Bold');assert.ok(p.document.querySelector('.bs-book-copy span').getAttribute('style').includes('font-size:24px'));assert.ok(p.events.some(e=>e[0]==='ViewContent'&&e[1].content_ids[0]===extra.id));
});
test('Multi-book cart totals update without erasing buyer details and sends the full selected order',async()=>{
 const p=await page({page:'checkout'},[SEED_BOOKS[0].id]);assert.ok(p.document.querySelector('#bs-cart-suggestions [data-add-cart="book-added-123"]'));const form=p.document.getElementById('bs-checkout-form');form.querySelector('[name=name]').value='Customer Name';form.querySelector('[name=email]').value='buyer@example.com';form.querySelector('[name=consent]').checked=true;
 click(p,'[data-add-cart="book-added-123"]');assert.equal(form.querySelector('[name=name]').value,'Customer Name');assert.equal(p.document.querySelector('[data-cart-total]').textContent,'₦8,500');assert.equal(form.querySelectorAll('input[type=checkbox]').length,1);
 assert.equal(p.document.querySelector('[data-country]'),null);assert.equal(form.querySelector('[name=phone]'),null);
 form.dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await tick();const req=p.requests.find(r=>r.url.endsWith('/checkout'));assert.ok(req);const data=JSON.parse(req.options.body);assert.deepEqual(data.books,[SEED_BOOKS[0].id,extra.id]);assert.equal(data.expected_amount,8500);assert.equal(data.country,'NG');assert.equal(data.phone,undefined);assert.equal(data.consent,true);assert.equal(req.options.headers['X-BS-Nonce'],'test-nonce');assert.equal(p.navigation[0],'https://checkout.flutterwave.com/v3/hosted/pay/test');
});
test('Paid receipt uses the combined ZIP, tracks only verified purchases and never verifies before nonce is ready',async()=>{
 const download='https://store.example.invalid/books/api/download?ref=BS-private&book=all&e=123&s=signed';const receipt={status:'paid',amount:8500,currency:'NGN',all_download_url:download,email_accepted:true,books:[{id:SEED_BOOKS[0].id,title:SEED_BOOKS[0].title,amount:3500,can_review:true,download_url:download.replace('book=all','book=first')},{id:extra.id,title:extra.title,amount:5000,can_review:true,download_url:download.replace('book=all','book=second')}]};
 const p=await page({page:'download'},[SEED_BOOKS[0].id,extra.id],receipt);const calls=p.requests.filter(r=>r.url.endsWith('/verify'));assert.equal(calls.length,1);assert.equal(calls[0].options.headers['X-BS-Nonce'],'test-nonce');assert.equal(p.document.getElementById('bs-download-button').getAttribute('href'),download);assert.equal(p.events.filter(e=>e[0]==='Purchase').length,1);assert.deepEqual(JSON.parse(p.localStorage.getItem('bs-book-cart')).books,[]);
});
test('Check again shows progress, prevents duplicate checks and replaces pending results with paid downloads',async()=>{
 let release,checks=0;const pending={status:'pending',message:'Flutterwave has not confirmed your payment yet.'};
 const p=await page({page:'download',verifyResponse:()=>++checks===1?Response.json(pending):new Promise(resolve=>{release=resolve;})},[all[0].id],pending);
 assert.match(p.document.getElementById('bs-receipt').textContent,/Flutterwave has not confirmed/);
 click(p,'[data-check-payment]');await tick();const button=p.document.querySelector('[data-check-payment]');
 assert.equal(button.disabled,true);assert.equal(button.textContent,'Checking payment...');assert.equal(p.document.getElementById('bs-receipt').getAttribute('aria-busy'),'true');assert.match(p.document.querySelector('#bs-receipt [data-check-status]').textContent,/Checking your payment/);
 click(p,'[data-check-payment]');await tick();assert.equal(checks,2);assert.equal([...p.timerDelays.values()].includes(5000),false);assert.equal(p.document.getElementById('bs-download-button'),null);
 release(Response.json({status:'paid',ref:'BS-private',amount:3500,currency:'NGN',email_accepted:true,all_download_url:'https://store.example.invalid/books/api/download?s=signed',books:[{id:all[0].id,title:all[0].title,amount:3500,can_review:true,download_url:'https://store.example.invalid/books/api/download?s=signed'}]}));await tick();
 assert.ok(p.document.getElementById('bs-download-button'));assert.equal(p.document.getElementById('bs-receipt').getAttribute('aria-busy'),'false');assert.deepEqual(JSON.parse(p.localStorage.getItem('bs-book-cart')).books,[]);
});
test('A failed payment check gives a usable retry instead of leaving the button busy',async()=>{
 let checks=0;const pending={status:'pending'};const p=await page({page:'download',verifyResponse:()=>++checks===1?Response.json(pending):Response.json({message:'Payment confirmation is temporarily unavailable.'},{status:503})},[],pending);
 click(p,'[data-check-payment]');await tick();assert.match(p.document.getElementById('bs-receipt').textContent,/temporarily unavailable/);assert.equal(p.document.querySelector('[data-check-payment]').disabled,false);assert.equal(p.document.getElementById('bs-receipt').getAttribute('aria-busy'),'false');
 click(p,'[data-check-payment]');await tick();assert.equal(checks,3);
});

test('Non-success payment pages explain each state and never offer a second full payment for a partial payment',async()=>{
 const headings={failed:'Payment attempt failed.',underpaid:'Payment needs the full amount.',expired:'Checkout expired.',cancelled:'Checkout closed.'};
 for(const [status,heading] of Object.entries(headings)){
  const result={status,message:'A verified '+status+' result.',provider:'bachs',mode:'test',resume_url:status==='failed'?'https://checkout.bachs.io/c/retry_token':status==='underpaid'?'https://checkout.bachs.io/c/do_not_repeat':'',retry_books:status==='underpaid'?[all[0].id]:[]};
  const p=await page({page:'download'},[all[0].id],result);const panel=p.document.querySelector('#bs-receipt');
  assert.equal(panel.querySelector('h1').textContent,heading);assert.equal(panel.getAttribute('aria-busy'),'false');assert.equal(panel.querySelector('[data-check-payment]').disabled,false);
  assert.equal(panel.querySelector('#bs-download-button'),null);assert.equal(p.events.some(e=>e[0]==='Purchase'),false);assert.deepEqual(JSON.parse(p.localStorage.getItem('bs-book-cart')).books,[all[0].id]);
  if(status==='failed')assert.equal(panel.querySelector('a.bs-outline').getAttribute('href'),result.resume_url);
  if(status==='underpaid'){assert.equal(panel.querySelector('a.bs-outline'),null);assert.equal(panel.querySelector('[data-retry-checkout]'),null);}
  if(status!=='underpaid')assert.equal([...p.timerDelays.values()].includes(5000),false);
 }
});
test('An expired checkout reopens the same selected books and currency in the website popup',async()=>{
 const ids=[all[0].id,extra.id],result={status:'expired',message:'Checkout expired.',currency:'XOF',retry_books:ids};
 const p=await page({page:'download',currencies:['NGN','XOF']},[all[1].id],result);
 click(p,'[data-retry-checkout]');const dialog=p.document.getElementById('bs-checkout-dialog');
 assert.equal(dialog.open,true);assert.deepEqual(JSON.parse(p.localStorage.getItem('bs-book-cart')).books,ids);assert.equal(p.document.querySelector('[data-currency]').value,'XOF');assert.equal(p.navigation.length,0);
 const form=dialog.querySelector('#bs-checkout-form');assert.ok(form.querySelector('[name=name]'));assert.ok(form.querySelector('[name=email]'));assert.equal(form.querySelector('[name=phone]'),null);
});
test('Payment retry links respect the saved order environment and reject unrelated hosts',async()=>{
 for(const [provider,url,mode,allowed] of [
  ['flutterwave','https://checkout-v2.dev-flutterwave.com/v3/hosted/pay/retry','test',true],
  ['flutterwave','https://checkout-v2.dev-flutterwave.com/v3/hosted/pay/retry','live',false],
  ['bachs','https://sandbox-checkout.bachs.io/c/retry','test',true],
  ['bachs','https://sandbox-checkout.bachs.io/c/retry','live',false],
  ['bachs','https://checkout.bachs.io/c/retry','live',true],
  ['bachs','https://checkout.bachs.io.evil.example/c/retry','test',false]
 ]){
  const p=await page({page:'download',mode:'live'},[],{status:'failed',provider,mode,resume_url:url});
  const retry=p.document.querySelector('#bs-receipt a.bs-outline');assert.equal(Boolean(retry),allowed);if(allowed)assert.equal(retry.getAttribute('href'),url);
 }
});

test('Buying a book opens checkout on the same page with name and email only',async()=>{
 const p=await page({page:'book',book:extra.id,country:'KE',typography:'clean'});
 const title=p.document.querySelector('.bs-book-intro h1').textContent;
 click(p,'[data-buy-book="'+extra.id+'"]');
 const dialog=p.document.getElementById('bs-checkout-dialog');assert.equal(dialog.open,true);assert.equal(p.document.querySelector('.bs-book-intro h1').textContent,title);assert.equal(p.navigation.length,0);
 const form=dialog.querySelector('form');assert.ok(form.querySelector('[name=name]'));assert.ok(form.querySelector('[name=email]'));assert.equal(form.querySelector('[name=phone]'),null);assert.equal(form.querySelector('[name=country]'),null);assert.equal(p.document.querySelector('[data-country]'),null);
 assert.equal(dialog.querySelector('[data-cart-total]').textContent,'KSh 450');assert.equal(p.document.getElementById('bs-page').dataset.typography,'clean');
 form.querySelector('[name=name]').value='Kenyan Reader';form.querySelector('[name=email]').value='reader@example.com';form.querySelector('[name=consent]').checked=true;
 click(p,'#bs-checkout-dialog [data-add-cart="'+SEED_BOOKS[0].id+'"]');assert.equal(form.querySelector('[name=name]').value,'Kenyan Reader');assert.equal(dialog.querySelector('[data-cart-total]').textContent,'KSh 765');
 form.dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
 const sent=JSON.parse(p.requests.find(r=>r.url.endsWith('/checkout')).options.body);assert.equal(sent.country,'KE');assert.equal(sent.expected_amount,765);assert.equal(sent.phone,undefined);assert.equal(p.navigation.length,1);
 click(p,'[data-close-checkout]');assert.equal(dialog.open,false);assert.equal(p.document.body.classList.contains('bs-checkout-open'),false);
});
test('System dark theme follows the device and visitors can save a light or dark preference',async()=>{
 const p=await page({darkDevice:true});const root=p.document.getElementById('bs-page');assert.equal(root.dataset.theme,'dark');assert.equal(p.document.querySelector('[data-theme-choice=system]').getAttribute('aria-pressed'),'true');
 click(p,'[data-theme-choice=light]');assert.equal(root.dataset.theme,'light');assert.equal(p.localStorage.getItem('bs-book-theme'),'light');
 p.media.matches=true;p.media.listener();assert.equal(root.dataset.theme,'light');click(p,'[data-theme-choice=system]');assert.equal(root.dataset.theme,'dark');p.media.matches=false;p.media.listener();assert.equal(root.dataset.theme,'light');
 assert.ok(p.document.querySelector('a[href="mailto:support@example.invalid"]'));
});

test('Sales counts refresh without changing checkout details, currency or prices',async()=>{
 let sold=1042;
 const p=await page({page:'book',book:extra.id,counts:()=>[{id:extra.id,purchase_count:sold-1000,sold_count:sold,sold_at_least:true}]});
 assert.equal(p.document.getElementById('bs-page').dataset.typography,'classic');
 click(p,'[data-buy-book="'+extra.id+'"]');
 const form=p.document.querySelector('#bs-checkout-dialog form');
 form.querySelector('[name=name]').value='Customer Name';form.querySelector('[name=email]').value='reader@example.com';
 const total=p.document.querySelector('[data-cart-total]').textContent;
 const runCounts=async()=>{const id=[...p.timers.keys()].find(k=>p.timerDelays.get(k)===15000);assert.ok(id);await p.timers.get(id)();await tick();};
 await runCounts();
 assert.equal(p.document.querySelector('[data-sold-book="'+extra.id+'"]').textContent,'1,042+ copies sold');
 sold++;await runCounts();
 assert.equal(p.document.querySelector('[data-sold-book="'+extra.id+'"]').textContent,'1,043+ copies sold');
 assert.equal(p.document.querySelector('#bs-checkout-dialog form'),form);
 assert.equal(form.querySelector('[name=name]').value,'Customer Name');assert.equal(form.querySelector('[name=email]').value,'reader@example.com');
 assert.equal(p.document.querySelector('[data-cart-total]').textContent,total);
 assert.equal(p.requests.filter(r=>r.url.endsWith('/catalog')).length,1);
 Object.defineProperty(p.document,'hidden',{configurable:true,writable:true,value:true});
 const countRequests=p.requests.filter(r=>r.url.endsWith('/counts')).length;
 await runCounts();assert.equal(p.requests.filter(r=>r.url.endsWith('/counts')).length,countRequests);
 p.document.hidden=false;p.document.dispatchEvent(new p.window.Event('visibilitychange'));await tick();
 assert.equal(p.requests.filter(r=>r.url.endsWith('/counts')).length,countRequests+1);
});

test('Prices stay blank while catalog data loads and never flash an unavailable message',async()=>{
 const p=await page({holdCatalog:true});
 assert.equal(p.document.querySelector('[data-price]').textContent,'');
 assert.equal(/Price unavailable|Checking currency/.test(p.document.getElementById('bs-page').textContent),false);
 p.releaseCatalog();await tick();
 assert.equal(p.document.querySelector('[data-price]').textContent,'₦3,500');
});
test('Currency choice overrides location across book prices, cart, payment and later pages',async()=>{
 const p=await page({page:'checkout',country:'NG'},[all[0].id,extra.id]);
 const form=p.document.getElementById('bs-checkout-form');form.querySelector('[name=name]').value='Customer Name';form.querySelector('[name=email]').value='buyer@example.com';form.querySelector('[name=consent]').checked=true;
 const selector=p.document.querySelector('[data-currency]');selector.value='USD';selector.dispatchEvent(new p.window.Event('change',{bubbles:true}));
 assert.equal(p.document.querySelector('[data-cart-total]').textContent,'US$ 5.95');
 assert.equal(form.querySelector('[name=name]').value,'Customer Name');assert.equal(p.document.querySelector('#bs-checkout-form'),form);
 assert.equal(p.document.querySelector('#bs-order-country').textContent,'USD');
 const later=await page({page:'book',book:extra.id,country:'KE',sessionStorage:p.sessionStorage});
 assert.equal(later.document.querySelector('[data-currency]').value,'USD');assert.equal(later.document.querySelector('[data-price]').textContent,'US$ 3.50');
 form.dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
 const data=JSON.parse(p.requests.find(r=>r.url.endsWith('/checkout')).options.body);assert.equal(data.country,'NG');assert.equal(data.currency,'USD');assert.equal(data.expected_amount,5.95);
});
test('Closing checkout to change currency keeps buyer details and refreshes the order on reopening',async()=>{
 const p=await page({page:'home'},[all[0].id]);
 click(p,'.bs-cart-link');
 const dialog=p.document.getElementById('bs-checkout-dialog'),form=dialog.querySelector('form');
 form.querySelector('[name=name]').value='Test Reader';form.querySelector('[name=email]').value='reader@example.com';form.querySelector('[name=consent]').checked=true;
 click(p,'[data-close-checkout]');
 const selector=p.document.querySelector('[data-currency]');selector.value='USD';selector.dispatchEvent(new p.window.Event('change',{bubbles:true}));
 click(p,'.bs-card [data-add-cart="'+extra.id+'"]');click(p,'.bs-cart-link');
 assert.equal(dialog.querySelector('form'),form);assert.equal(form.querySelector('[name=name]').value,'Test Reader');assert.equal(form.querySelector('[name=email]').value,'reader@example.com');assert.equal(form.querySelector('[name=consent]').checked,true);
 assert.equal(dialog.querySelector('[data-cart-total]').textContent,'US$ 5.95');assert.equal(dialog.querySelector('#bs-order-country').textContent,'USD');assert.equal(dialog.querySelectorAll('.bs-cart-item').length,2);assert.equal(dialog.open,true);
 form.dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
 const sent=JSON.parse(p.requests.find(r=>r.url.endsWith('/checkout')).options.body);assert.equal(sent.name,'Test Reader');assert.equal(sent.email,'reader@example.com');assert.equal(sent.currency,'USD');assert.equal(sent.expected_amount,5.95);
});
test('Checkout opens the Flutterwave test page only in test mode and rejects unsafe destinations',async()=>{
 const urls=[['test','https://checkout-v2.dev-flutterwave.com/v3/hosted/pay/test',true],['live','https://checkout.flutterwave.com/v3/hosted/pay/live',true],['live','https://checkout-v2.dev-flutterwave.com/v3/hosted/pay/test',false],['test','https://checkout-v2.dev-flutterwave.com.evil.example/v3/hosted/pay/test',false],['test','http://checkout-v2.dev-flutterwave.com/v3/hosted/pay/test',false],['test','https://user:secret@checkout-v2.dev-flutterwave.com/v3/hosted/pay/test',false],['test','https://checkout.flutterwave.com:8443/v3/hosted/pay/test',false],['test','https://checkout.flutterwave.com/unrelated',false],['test','not-a-url',false]];
 for(const [mode,checkoutUrl,allowed] of urls){
  const p=await page({page:'checkout',mode,checkoutUrl},[all[0].id]);const form=p.document.getElementById('bs-checkout-form');form.querySelector('[name=name]').value='Test Reader';form.querySelector('[name=email]').value='reader@example.com';form.querySelector('[name=consent]').checked=true;
  form.dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(p.navigation.length,allowed?1:0,checkoutUrl);
  if(allowed)assert.equal(p.navigation[0],checkoutUrl);else{assert.match(p.document.getElementById('bs-form-result').textContent,/We could not open payment safely/);assert.equal(p.events.some(e=>e[0]==='InitiateCheckout'),false);}
 }
});
test('Featured book updates the cover, text and links with no hero sales count',async()=>{
 const p=await page({featuredBook:extra.id});const hero=p.document.querySelector('.bs-hero');
 assert.equal(hero.querySelector('img').getAttribute('src'),extra.image_url);
 assert.equal(hero.querySelector('.bs-feature-label strong').textContent,extra.title);
 assert.equal(hero.querySelector('.bs-feature-label span').textContent,extra.summary);
 assert.ok([...hero.querySelectorAll('a[data-page=book]')].every(a=>a.getAttribute('href')==='/books/'+extra.slug+'/'));
 assert.equal(hero.querySelector('[data-sold-book]'),null);
 assert.equal(/[:;—–]/.test(hero.querySelector('.bs-hero-copy p').textContent),false);
});
test('The catalog shows ten books per page and resets to page one when searching or filtering',async()=>{
 const titles=Array.from({length:23},(_,i)=>({...extra,id:'added-'+i,slug:'added-'+i,title:'New upload '+(i+1),category:i<12?'Work':'Other'}));
 const p=await page({catalogBooks:titles});
 assert.equal(p.document.querySelectorAll('.bs-card').length,10);assert.equal(p.document.querySelector('.bs-card').dataset.id,'added-0');
 click(p,'[data-catalog-page="2"]');assert.equal(p.document.querySelectorAll('.bs-card').length,10);assert.equal(p.document.querySelector('.bs-card').dataset.id,'added-10');assert.equal(p.document.querySelector('#bs-results').textContent,'Showing 11 to 20 of 23 books');
 click(p,'[data-catalog-page="3"]');assert.equal(p.document.querySelectorAll('.bs-card').length,3);assert.equal(p.document.querySelector('[data-catalog-page="4"]').disabled,true);
 click(p,'[data-filter="Work"]');assert.equal(p.document.querySelectorAll('.bs-card').length,10);assert.equal(p.document.querySelector('.bs-card').dataset.id,'added-0');
 click(p,'[data-catalog-page="2"]');const search=p.document.getElementById('bs-search');search.value='New upload 1';search.dispatchEvent(new p.window.Event('input',{bubbles:true}));
 assert.equal(p.document.querySelector('.bs-card').dataset.id,'added-0');assert.equal(p.document.querySelector('#bs-pagination').textContent,'');
});


test('Mobile money markets select the local currency and keep a manual choice across pages',async()=>{
 for(const [country,currency] of Object.entries(locationCurrency)){
  const p=await page({country,currencies:mobileCurrencies});assert.equal(p.document.querySelector('[data-currency]').value,currency,country);
  click(p,'[data-add-cart="'+all[0].id+'"]');click(p,'.bs-cart-link');assert.equal(p.document.querySelector('#bs-order-country').textContent,currency);
  assert.equal(p.document.querySelector('[name=phone]'),null);assert.equal(p.document.querySelector('form [name=currency]'),null);
 }
 const p=await page({country:'GH',currencies:mobileCurrencies}),select=p.document.querySelector('[data-currency]');select.value='XOF';select.dispatchEvent(new p.window.Event('change',{bubbles:true}));
 const later=await page({page:'book',book:extra.id,country:'CM',currencies:mobileCurrencies,sessionStorage:p.sessionStorage});assert.equal(later.document.querySelector('[data-currency]').value,'XOF');assert.match(later.document.querySelector('[data-price]').textContent,/CFA/);
});
test('Bachs opens over the shop, submits the displayed total and waits for server verification for delivery',async()=>{
 let opened,initialized=0;const bachs={Initialize:()=>initialized++,Checkout:{open:async options=>{opened=options;}}};
 const result={provider:'bachs',checkout_id:'chk_client',ref:'BS-client',checkout_url:'https://checkout.bachs.io/c/client_token',return_url:'https://store.example.invalid/books/download/?ref=BS-client&k=private-key'};
 const p=await page({country:'GH',currencies:mobileCurrencies,bachs,checkoutResult:result},[all[0].id,extra.id]);click(p,'.bs-cart-link');
 const dialog=p.document.querySelector('#bs-checkout-dialog'),form=dialog.querySelector('form');form.querySelector('[name=name]').value='Reader';form.querySelector('[name=email]').value='reader@example.com';form.querySelector('[name=consent]').checked=true;
 assert.equal(dialog.querySelector('[data-cart-total]').textContent,'GH₵ 68.00');form.dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
 assert.equal(opened.checkoutUrl,result.checkout_url);assert.equal(initialized,1);assert.equal(dialog.open,false);assert.equal(p.navigation.length,0);assert.equal(p.events.filter(e=>e[0]==='Purchase').length,0);
 const sent=JSON.parse(p.requests.find(r=>r.url.endsWith('/checkout')).options.body);assert.equal(sent.country,'GH');assert.equal(sent.currency,'GHS');assert.equal(sent.expected_amount,68);
 opened.onEvent({type:'checkout.completed',data:{reference:'ANOTHER'}});assert.equal(p.navigation.length,0);
 opened.onEvent({type:'checkout.completed',data:{reference:'BS-client'}});assert.equal(p.navigation[0],result.return_url);assert.equal(p.events.filter(e=>e[0]==='Purchase').length,0);
});
test('Exiting Bachs checkout closes the box and shows a clear message, and strangers cannot trigger it',async()=>{
 let opened,closed=0;const bachs={Initialize:()=>{},Checkout:{open:async options=>{opened=options;},close:()=>closed++}};
 const result={provider:'bachs',checkout_id:'chk_client',ref:'BS-client',checkout_url:'https://checkout.bachs.io/c/client_token',return_url:'https://store.example.invalid/books/download/?ref=BS-client&k=private-key'};
 const p=await page({country:'GH',currencies:mobileCurrencies,bachs,checkoutResult:result},[all[0].id]);click(p,'.bs-cart-link');
 const dialog=p.document.querySelector('#bs-checkout-dialog'),form=dialog.querySelector('form');form.querySelector('[name=name]').value='Reader';form.querySelector('[name=email]').value='reader@example.com';form.querySelector('[name=consent]').checked=true;
 const send=(data,origin)=>{const e=new p.window.Event('message');e.data=data;e.origin=origin;p.window.dispatchEvent(e);};
 send({source:'bs-payment-cancelled'},'https://store.example.invalid');assert.equal(closed,0);
 form.dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.ok(opened);
 send({source:'bs-payment-cancelled'},'https://evil.example.invalid');send({source:'something-else'},'https://store.example.invalid');send(null,'https://store.example.invalid');assert.equal(closed,0);
 send({source:'bs-payment-cancelled'},'https://store.example.invalid');assert.equal(closed,1);assert.equal(p.navigation.length,0);assert.match(p.document.querySelector('#bs-form-result')?.textContent||'',/Payment did not finish/);
 send({source:'bs-payment-cancelled'},'https://store.example.invalid');assert.equal(closed,1);
});
test('Bachs SDK loading failure falls back to its trusted hosted page and unsafe links are refused',async()=>{
 const result={provider:'bachs',checkout_id:'chk_client',ref:'BS-client',checkout_url:'https://checkout.bachs.io/c/client_token',return_url:'https://store.example.invalid/books/download/?ref=BS-client&k=private-key'};
 for(const unsafe of [false,true]){
  const p=await page({page:'checkout',country:'KE',currencies:mobileCurrencies,checkoutResult:{...result,checkout_url:unsafe?'https://checkout.bachs.io.evil.example/c/client_token':result.checkout_url}},[all[0].id]);
  const form=p.document.querySelector('#bs-checkout-form');form.querySelector('[name=name]').value='Reader';form.querySelector('[name=email]').value='reader@example.com';form.querySelector('[name=consent]').checked=true;
  form.dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
  if(unsafe){assert.equal(p.navigation.length,0);assert.match(p.document.querySelector('#bs-form-result').textContent,/safely/);assert.equal(p.document.head.querySelector('script[src]'),null);}
  else{const script=p.document.head.querySelector('script[src="https://checkout.bachs.io/bachs.js"]');assert.ok(script);script.onerror();await tick();assert.equal(p.navigation[0],result.checkout_url);}
 }
});

test('Bachs test checkout opens its sandbox popup using the server order mode and exact origin',async()=>{
 for(const [pageMode,orderMode,host,allowed] of [['test','test','sandbox-checkout.bachs.io',true],['live','test','sandbox-checkout.bachs.io',true],['test','live','sandbox-checkout.bachs.io',false],['live','live','sandbox-checkout.bachs.io',false],['test','test','sandbox-checkout.bachs.io.evil.example',false]]){
  let opened,initialization;const bachs={Initialize:options=>{initialization=options;},Checkout:{open:async options=>{opened=options;}}};
  const result={provider:'bachs',mode:orderMode,ref:'BS-sandbox-test',checkout_url:'https://'+host+'/c/test_token',return_url:'https://store.example.invalid/books/download/?ref=BS-sandbox-test&k=private-test-key'};
  const p=await page({page:'checkout',mode:pageMode,country:'GH',currencies:mobileCurrencies,bachs,checkoutResult:result},[all[0].id]);
  const form=p.document.querySelector('#bs-checkout-form');form.querySelector('[name=name]').value='Test Reader';form.querySelector('[name=email]').value='reader@example.com';form.querySelector('[name=consent]').checked=true;form.dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
  if(allowed){assert.equal(initialization.baseUrl,'https://sandbox-checkout.bachs.io');assert.equal(opened.checkoutUrl,result.checkout_url);assert.equal(p.navigation.length,0);assert.equal(p.events.some(e=>e[0]==='Purchase'),false);}
  else{assert.equal(opened,undefined);assert.equal(initialization,undefined);assert.match(p.document.querySelector('#bs-form-result').textContent,/safely/);assert.equal(p.navigation.length,0);}
 }
});

test('Bachs test checkout falls back to the trusted sandbox page when the SDK cannot load',async()=>{
 const result={provider:'bachs',mode:'test',ref:'BS-sandbox-test',checkout_url:'https://sandbox-checkout.bachs.io/c/test_token',return_url:'https://store.example.invalid/books/download/?ref=BS-sandbox-test&k=private-test-key'};
 const p=await page({page:'checkout',mode:'test',country:'KE',currencies:mobileCurrencies,checkoutResult:result},[all[0].id]);
 const form=p.document.querySelector('#bs-checkout-form');form.querySelector('[name=name]').value='Test Reader';form.querySelector('[name=email]').value='reader@example.com';form.querySelector('[name=consent]').checked=true;form.dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
 const script=p.document.head.querySelector('script[src="https://checkout.bachs.io/bachs.js"]');assert.ok(script);script.onerror();await tick();assert.equal(p.navigation[0],result.checkout_url);
});

test('Payment retry from a private purchase page never loads the Bachs script into that page',async()=>{
 let opened=0;const result={provider:'bachs',checkout_id:'chk_private_retry',ref:'BS-new',checkout_url:'https://checkout.bachs.io/c/new_token',return_url:'https://store.example.invalid/books/download/?ref=BS-new&k=new-private-key'};
 const receipt={status:'expired',ref:'BS-private',currency:'GHS',message:'Checkout expired.',resume_url:'',retry_books:[all[0].id]};
 const p=await page({page:'download',country:'GH',currencies:mobileCurrencies,bachs:{Initialize:()=>opened++,Checkout:{open:async()=>opened++}},checkoutResult:result},[],receipt);
 click(p,'[data-retry-checkout]');const form=p.document.querySelector('#bs-checkout-form');form.querySelector('[name=name]').value='Reader';form.querySelector('[name=email]').value='reader@example.com';form.querySelector('[name=consent]').checked=true;
 form.dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
 assert.equal(opened,0);assert.equal(p.document.head.querySelector('script[src="https://checkout.bachs.io/bachs.js"]'),null);assert.equal(p.navigation[0],result.checkout_url);
});

test('Refund, delivery and terms pages state the agreed rules and the footer links to them',async()=>{
 const home=await page();for(const slug of ['refunds','delivery','terms','privacy'])assert.ok(home.document.querySelector('.bs-footer a[data-page="'+slug+'"]'),slug);
 const refunds=(await page({page:'refunds'})).document.querySelector('.bs-reading-width').textContent;assert.match(refunds,/within 7 days/);assert.match(refunds,/within 24 hours on working days/);assert.match(refunds,/change of mind/);assert.match(refunds,/does not limit any right you have under the law/);
 const delivery=(await page({page:'delivery'})).document.querySelector('.bs-reading-width').textContent;assert.match(delivery,/48 hours/);assert.match(delivery,/before you pay again/);
 const terms=(await page({page:'terms'})).document.querySelector('.bs-reading-width').textContent;assert.match(terms,/do not copy, resell, share or upload/);
});
test('The tracking choice notice appears only when a choice is needed and passes the visitor choice on',async()=>{
 assert.equal((await page()).document.querySelector('.bs-consent-banner'),null);
 const calls=[];
 const p=await page({tracking:{available:()=>true,needsChoice:()=>true,consented:()=>false,setConsent:v=>{calls.push(v);return true;},resetChoice:()=>calls.push('reset')}});
 assert.ok(p.document.querySelector('.bs-consent-banner'));
 click(p,'[data-consent-choice="no"]');assert.deepEqual(calls,[false]);
 click(p,'[data-consent-reset]');assert.deepEqual(calls,[false,'reset']);
});
