import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import mfPackage from 'miniflare';
import {deploymentConfig} from '../scripts/configure.mjs';
import {SEED_BOOKS} from '../src/seed.js';
import {startingSales} from '../src/store.js';
import {BRAND} from '../src/brand.js';
const {Miniflare,convertV4MiniflareOptions}=mfPackage;
const root=new URL('../',import.meta.url).pathname,origin='https://new-store.example',password='fresh-install-test-password-only';
let mf,db,cookie,csrf;
before(async()=>{
 const bundle=await build({entryPoints:[root+'src/worker.js'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
 mf=new Miniflare(convertV4MiniflareOptions({name:'fresh-store-regression',cf:false,telemetry:{enabled:false},modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-10',bindings:{PUBLIC_ORIGIN:origin,CONFIG_KEY:'fresh-install-test-key-over-thirty-two-characters',AUTHOR_INITIAL_PASSWORD:password},d1Databases:['DB'],r2Buckets:['FILES'],assets:{directory:root+'public',binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true},assetConfig:{html_handling:'none',not_found_handling:'none'}},outboundService:()=>Response.json({})}));
 db=await mf.getD1Database('DB');for(const file of (await readdir(root+'migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(root+'migrations/'+file,'utf8'));
});
after(async()=>await mf?.dispose());
test('A real fresh installation has an empty catalog, no tracking and no enabled checkout',async()=>{
 assert.deepEqual(SEED_BOOKS,[]);
 const response=await mf.dispatchFetch(origin+'/books/api/catalog'),catalog=await response.json();
 assert.equal(response.status,200);assert.deepEqual(catalog.books,[]);assert.equal(catalog.mode,'setup');assert.equal(catalog.pixel_id,'');assert.equal(catalog.conversions_api_enabled,false);assert.equal(catalog.checkout_enabled,false);assert.equal(catalog.contact_enabled,false);assert.equal(catalog.support_email,BRAND.support_email||'');assert.deepEqual((await db.prepare('SELECT * FROM orders').all()).results,[]);
 const s=Object.fromEntries((await db.prepare('SELECT key,value FROM settings').all()).results.map(r=>[r.key,r.value]));
 for(const key of ['flutterwave_test','flutterwave_live','bachs_test','bachs_live','resend_key','webhook_secret','bachs_webhook_test','bachs_webhook_live'])assert.equal(s[key],'');
 assert.equal(s.reminder_enabled,'0');assert.equal(s.author_username,'owner');assert.equal(s.default_password,'1');
 const home=await mf.dispatchFetch(origin+'/books/');assert.equal(home.status,200);assert.match(await home.text(),/"books":\[\]/);
});
test('New books start at zero earlier sales and cannot sell before their own PDF is uploaded',async()=>{
 let response=await mf.dispatchFetch(origin+'/books/api/admin/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'owner',password})});let data=await response.json();assert.equal(response.status,200);cookie=response.headers.get('Set-Cookie').split(';')[0];csrf=data.csrf;
 response=await mf.dispatchFetch(origin+'/books/api/admin/books',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'X-BS-CSRF':csrf},body:JSON.stringify({title:'An owner supplied title',slug:'owner-title',price_ngn:2000,active:true})});data=await response.json();assert.equal(response.status,200,JSON.stringify(data));
 const catalog=await (await mf.dispatchFetch(origin+'/books/api/catalog')).json();assert.equal(catalog.books.length,1);assert.equal(catalog.books[0].starting_sales,0);assert.equal(catalog.books[0].sold_count,0);assert.equal(catalog.books[0].available,false);assert.equal(startingSales({}),0);
});
test('The delivered deployment manifest has no destination until its owner configures one',async()=>{
 const config=JSON.parse(await readFile(root+'wrangler.json','utf8'));assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);
 const publicConfig=JSON.parse(await readFile(root+'store.config.json','utf8'));
 if(!publicConfig.domain){assert.deepEqual(config.routes,[]);assert.equal(config.vars.PUBLIC_ORIGIN,'https://store.example.invalid');assert.equal(config.d1_databases[0].database_id,undefined);}
 assert.throws(()=>deploymentConfig({...publicConfig,domain:''}),/own real domain/);
 const own={...publicConfig,domain:'new-publisher.org',support_email:'help@new-publisher.org'};assert.equal(deploymentConfig(own).origin,'https://new-publisher.org');
 for(const domain of ['example.com','example.test','store.example.invalid','https://new-publisher.org','new-publisher.org/books'])assert.throws(()=>deploymentConfig({...own,domain}));
});
