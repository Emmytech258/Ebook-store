import worker from '../src/worker.js';
import {scheduled} from '../src/payments.js';
import {initialize,saveSettings,now} from '../src/store.js';
import {TEST_BOOKS} from './fixtures/books.js';
const seeded=new WeakMap();
async function fixture(env){
 if(!seeded.has(env.DB))seeded.set(env.DB,(async()=>{
  await initialize(env);
  await env.DB.batch(TEST_BOOKS.map((book,position)=>env.DB.prepare('INSERT OR IGNORE INTO books(id,slug,data,price_ngn,active,position,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?)').bind(book.id,book.slug,JSON.stringify(book),book.price_ngn,position,now(),now())));
  await saveSettings(env,{pixel_id:'1234567890',reminder_enabled:'1'});
 })());
 return seeded.get(env.DB);
}
export default {async fetch(req,env,ctx){await fixture(env);if(new URL(req.url).pathname==='/__test_cron'){await scheduled(env);return new Response('ok');}return worker.fetch(req,env,ctx);}};
