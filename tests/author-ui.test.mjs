import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
const source=(await readFile(new URL('../public/author.js',import.meta.url),'utf8')).replace(/^import[^\n]+\n/,'');
const tick=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
class FormValues{
 constructor(form){this.values=[...form.querySelectorAll('[name]')].filter(el=>!['checkbox','radio'].includes(el.type)||el.checked).map(el=>[el.name,el.value]);}
 entries(){return this.values.values();}getAll(name){return this.values.filter(v=>v[0]===name).map(v=>v[1]);}
}
async function portal(enabled=false){
 const {window,document}=parseHTML('<html><body><main id="portal"></main><dialog id="book-dialog"></dialog><div id="notice" hidden></div></body></html>'),requests=[];
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return [...this.querySelectorAll('option')].find(o=>o.hasAttribute('selected'))?.value||this.querySelector('option')?.value||'';},set(v){for(const o of this.querySelectorAll('option'))o.toggleAttribute('selected',o.value===v);}});
 window.HTMLElement.prototype.reset=function(){for(const el of this.querySelectorAll('[name]'))el.value=el.getAttribute('value')||'';};
 const settings={username:'owner',mode:'setup',currencies:['NGN'],active_currencies:[],typography:'classic',public_origin:'https://store.example.invalid',support_email:'support@example.invalid',mfa_enabled:enabled};
 const fetch=async(url,options={})=>{
  const data=options.body?JSON.parse(options.body):undefined;requests.push({url,options,data});let response={ok:true};
  if(url.endsWith('admin/session'))response={authenticated:true,csrf:'first-csrf'};
  if(url.endsWith('admin/settings'))response=settings;
  if(url.endsWith('admin/books'))response={books:[]};
  if(url.endsWith('security/enroll'))response={secret:'TESTONLYSETUPKEY234567TESTONLYKEY',account:'owner',issuer:'Bookshop'};
  if(url.endsWith('security/enable')){settings.mfa_enabled=true;response={ok:true,csrf:'replacement-csrf',recovery_codes:['FIRST-FAKE-CODE','SECOND-FAKE-CODE']};}
  if(url.endsWith('security/recovery'))response={ok:true,csrf:'recovery-csrf',recovery_codes:['NEW-FAKE-CODE']};
  return Response.json(response);
 };
 const context=vm.createContext({window,document,fetch,FormData:FormValues,location:{origin:'https://store.example.invalid'},URLSearchParams,Intl,Date,setTimeout:()=>1,clearTimeout:()=>{},confirm:()=>true});
 await vm.runInContext('(async()=>{'+source+'})()',context);document.querySelector('[data-tab="settings"]').dispatchEvent(new window.Event('click',{bubbles:true}));await tick();
 return {window,document,requests,settings};
}
async function submit(p,id,values){const form=p.document.getElementById(id);assert.ok(form,id);for(const [key,value] of Object.entries(values)){const field=form.querySelector('[name="'+key+'"]');assert.ok(field,key);field.value=value;}form.dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await tick();}

test('Author settings shows separate valid security forms and supports enrollment through recovery-code display',async()=>{
 const p=await portal();assert.equal(p.document.querySelector('form form'),null);assert.ok(p.document.getElementById('settings-password'));assert.equal(p.document.querySelector('[name=new_password]').getAttribute('minlength'),'15');
 await submit(p,'security-enroll-form',{current_password:'only-for-ui-test-password'});assert.ok(p.document.getElementById('authenticator-secret'),p.document.getElementById('notice').textContent+' '+JSON.stringify(p.requests.slice(-2))); assert.equal(p.document.querySelector('form form'),null);
 await submit(p,'security-enable-form',{current_password:'only-for-ui-test-password',security_code:'123456'});
 assert.equal(p.document.getElementById('saved-recovery-codes').value,'FIRST-FAKE-CODE\nSECOND-FAKE-CODE');assert.equal(p.document.getElementById('authenticator-secret'),null);assert.equal(p.document.querySelector('form form'),null);
 await submit(p,'security-manage-form',{action:'recovery',current_password:'only-for-ui-test-password',security_code:'654321'});
 const last=p.requests.findLast(r=>r.url.endsWith('security/recovery'));assert.equal(last.options.headers['X-BS-CSRF'],'replacement-csrf');assert.equal(p.document.getElementById('saved-recovery-codes').value,'NEW-FAKE-CODE');
});

test('Enabled MFA appears in settings and password confirmation and sends a code with password changes',async()=>{
 const p=await portal(true);assert.ok(p.document.getElementById('settings-code'));assert.ok(p.document.getElementById('password-code'));assert.equal(p.document.getElementById('security-enroll-form'),null);
 await submit(p,'password-form',{current_password:'only-for-ui-test-password',new_password:'only-for-ui-test-new-password',confirm_password:'only-for-ui-test-new-password',security_code:'123456'});
 const sent=p.requests.find(r=>r.url.endsWith('admin/password')).data;assert.equal(sent.security_code,'123456');assert.equal(sent.new_password,'only-for-ui-test-new-password');assert.ok(p.document.querySelector('#login [name=security_code]'));
});
