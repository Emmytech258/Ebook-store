import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

const script=await readFile(new URL('../public/tracking.js',import.meta.url),'utf8');
function browser(path='/books/a-book/',search=''){
 const {window,document}=parseHTML('<html><head></head><body></body></html>');
 // Linkedom shares some global properties across document windows.
 window.fbq=undefined;window.BSTracking=undefined;
 const jar=new Map(),requests=[];
 Object.defineProperty(document,'cookie',{configurable:true,get:()=>[...jar].map(([k,v])=>k+'='+v).join('; '),set:value=>{const pair=value.split(';')[0],at=pair.indexOf('=');jar.set(pair.slice(0,at),pair.slice(at+1));}});
 let serial=0;Object.defineProperty(window,'crypto',{value:{randomUUID:()=> 'event-test-'+(++serial)},configurable:true});
 const location={origin:'https://store.example.invalid',pathname:path,search};
 window.location=location;
 vm.runInNewContext(script,{window,document,location,URLSearchParams,fetch:(url,options)=>{requests.push({url,options});return Promise.resolve(Response.json({ok:true}));}});
 return {window,document,jar,requests,tracking:window.BSTracking};
}

test('Browser and server events share IDs and contain only the public page path',()=>{
 const p=browser('/books/a-book/','?fbclid=approved-ad-click');
 p.tracking.init('1234567890','live','book',{nonce:'page-nonce',conversions_api_enabled:true});
 p.tracking.track('ViewContent',{content_ids:['a-book'],value:3500,currency:'NGN'});
 const pixelEvents=p.window.fbq.queue.filter(args=>args[0]==='track');
 assert.equal(pixelEvents.length,2);assert.equal(p.requests.length,2);
 for(let i=0;i<p.requests.length;i++){
  const req=p.requests[i],data=JSON.parse(req.options.body);
  assert.equal(data.event_id,pixelEvents[i][3].eventID);
  assert.equal(data.path,'/books/a-book/');assert.equal(req.url,'/books/api/events');
  assert.equal(req.options.headers['X-BS-Nonce'],'page-nonce');assert.equal(req.options.keepalive,true);
  assert.match(data.context.fbp,/^fb\.1\.[0-9]+\.[0-9]+$/);assert.match(data.context.fbc,/\.approved-ad-click$/);
  assert.equal(data.context.email,undefined);
 }
 assert.equal(p.requests.filter(req=>JSON.parse(req.options.body).event==='Purchase').length,0);
});

test('Private purchase tracking uses a clean frame and the verified server event ID',()=>{
 const p=browser('/books/download/','?ref=PRIVATE-REFERENCE&k=PRIVATE-KEY');
 p.tracking.init('1234567890','live','download',{nonce:'page-nonce',conversions_api_enabled:true});
 assert.equal(p.window.fbq,undefined);assert.equal(p.jar.size,0);assert.equal(p.requests.length,0);
 p.tracking.track('PageView',{});assert.equal(p.document.querySelector('iframe'),null);
 p.tracking.track('Purchase',{value:3500,currency:'NGN',content_ids:['a-book'],email:'private@example.com',download_url:'PRIVATE-KEY'},'purchase-BS-verified');
 const frame=p.document.querySelector('iframe');assert.ok(frame);
 assert.equal(frame.getAttribute('src'),'/books/pixel-frame.html?pixel=1234567890');
 assert.equal(frame.getAttribute('src').includes('PRIVATE'),false);
 const messages=[];Object.defineProperty(frame,'contentWindow',{value:{postMessage:(data,origin)=>messages.push({data,origin})}});
 frame.dispatchEvent(new p.window.Event('load'));
 assert.equal(messages.length,1);assert.equal(messages[0].data.eventId,'purchase-BS-verified');assert.equal(messages[0].data.data.email,undefined);assert.equal(messages[0].data.data.download_url,undefined);
 assert.equal(messages[0].origin,'*');assert.equal(frame.getAttribute('sandbox'),'allow-scripts');assert.equal(frame.getAttribute('sandbox').includes('allow-same-origin'),false);assert.equal(p.requests.length,0);
});

test('Setup, test payments and disabled server tracking send no Conversions API events',()=>{
 for(const mode of ['setup','test']){
  const p=browser();p.tracking.init('1234567890',mode,'book',{nonce:'page-nonce',conversions_api_enabled:true});
  p.tracking.track('ViewContent',{});assert.equal(p.requests.length,0);assert.equal(p.jar.size,0);assert.equal(p.window.fbq,undefined);
 }
 const p=browser();p.tracking.init('1234567890','live','book',{nonce:'page-nonce',conversions_api_enabled:false});
 p.tracking.track('ViewContent',{});assert.equal(p.requests.length,0);assert.equal(p.jar.size,0);assert.ok(p.window.fbq);
});

test('The isolated pixel accepts purchase totals only from its parent and supports all payment currencies',async()=>{
 const script=await readFile(new URL('../public/pixel-frame.js',import.meta.url),'utf8'),{window,document}=parseHTML('<html><head></head><body></body></html>'),parent={},handlers={};
 vm.runInNewContext(script,{window,document,parent,location:{origin:'https://store.example.invalid',search:'?pixel=1234567890'},URLSearchParams,addEventListener:(name,fn)=>handlers[name]=fn});
 const data={event:'Purchase',eventId:'verified-test-purchase',data:{value:100,currency:'TZS',content_ids:['book-one'],email:'private@example.com'}};
 handlers.message({origin:'https://attacker.example',source:parent,data});handlers.message({origin:'https://store.example.invalid',source:{},data});assert.equal(window.fbq.queue.length,1);
 for(const currency of ['NGN','GHS','KES','MWK','RWF','TZS','UGX','XAF','XOF','ZMW'])handlers.message({origin:'https://store.example.invalid',source:parent,data:{...data,data:{...data.data,currency}}});
 const events=window.fbq.queue.filter(args=>args[0]==='track');assert.equal(events.length,10);for(const event of events){assert.equal(event[2].email,undefined);assert.equal(event[3].eventID,'verified-test-purchase');}
});
