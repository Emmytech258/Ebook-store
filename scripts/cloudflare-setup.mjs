import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
function wranglerCLI(){
 const packagePath=require.resolve('wrangler/package.json');
 const manifest=JSON.parse(readFileSync(packagePath,'utf8'));
 return resolve(dirname(packagePath),manifest.bin.wrangler);
}
export async function installBuildDependencies(){
 if(process.env.WORKERS_CI!=='1')return;
 // The parent repository uses pnpm. Install this separate app from its own npm lockfile.
 console.log('Installing the bookshop dependencies from its own package lock.');
 await new Promise((resolve,reject)=>{
  const child=spawn('npm',['ci','--no-audit','--no-fund'],{cwd:root,env:process.env,stdio:'inherit'});
  child.on('error',reject);
  child.on('close',code=>code===0?resolve():reject(new Error('The bookshop dependency installation failed.')));
 });
}
export function wrangler(args,{input,capture=false}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[wranglerCLI(),...args],{cwd:root,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',data=>{stdout+=data;if(!capture)process.stdout.write(data);});child.stderr.on('data',data=>{stderr+=data;if(!capture)process.stderr.write(data);});child.on('error',reject);
  child.on('close',code=>code===0?resolve(stdout):reject(Object.assign(new Error('Cloudflare step failed: '+args.join(' ')),{stdout,stderr,code})));
  if(input!==undefined)child.stdin.end(input);else child.stdin.end();
 });
}
function jsonOutput(text){const clean=text.replace(/\x1b\[[0-9;]*m/g,'').trim();try{return JSON.parse(clean);}catch{}for(const [at,char] of [...clean].entries()){if(!['[','{'].includes(char))continue;try{return JSON.parse(clean.slice(at));}catch{}}throw new Error('Cloudflare returned an unreadable resource list.');}
export async function requirePrivateBucket(bucket,run=wrangler){
 const clean=text=>String(text).replace(/\x1b\[[0-9;]*m/g,'');
 let managed=clean(await run(['r2','bucket','dev-url','get',bucket],{capture:true}));
 if(/Public access is enabled at /i.test(managed)){
  await run(['r2','bucket','dev-url','disable',bucket,'--force'],{capture:true});
  managed=clean(await run(['r2','bucket','dev-url','get',bucket],{capture:true}));
 }
 if(!/Public access via the r2\.dev URL is disabled\./i.test(managed))throw new Error('Book file storage privacy could not be verified. Disable the bucket Public Development URL before deployment.');
 const domains=clean(await run(['r2','bucket','domain','list',bucket],{capture:true}));
 if(!/There are no custom domains connected to this bucket\./i.test(domains)){
  const states=[...domains.matchAll(/^\s*enabled:\s*(Yes|No)\s*$/gim)].map(m=>m[1].toLowerCase());
  if(!states.length||states.some(state=>state!=='no'))throw new Error('Book file storage has a public or unverified custom domain. In R2, open '+bucket+' Settings and disable direct bucket domain access before deployment.');
 }
 console.log('Verified private book storage: public development access is disabled and no public custom domain can bypass payment.');
}
export async function setup(){
 await installBuildDependencies();
 const config=JSON.parse(await readFile(root+'wrangler.json','utf8'));
 const website=config.vars?.PUBLIC_ORIGIN;
 if(!website||!/^https:\/\//.test(website)||new URL(website).hostname.endsWith('.invalid')||!config.routes?.length)throw new Error('Complete store.config.json and run npm run configure before deployment.');
 console.log('Preparing your bookshop for '+website+'/books/.');
 // whoami checks authorization before any remote change. No credentials are printed or written.
 await wrangler(['whoami'],{capture:true});
 let databases=jsonOutput(await wrangler(['d1','list','--json'],{capture:true}));
 let database=databases.find(d=>d.name===config.d1_databases[0].database_name);
 if(!database){await wrangler(['d1','create',config.d1_databases[0].database_name,'--location','weur','--update-config=false']);databases=jsonOutput(await wrangler(['d1','list','--json'],{capture:true}));database=databases.find(d=>d.name===config.d1_databases[0].database_name);}
 if(!database?.uuid)throw new Error('The bookshop database could not be identified.');
 config.d1_databases[0].database_id=database.uuid;await writeFile(root+'wrangler.json',JSON.stringify(config,null,2)+'\n');
 try{await wrangler(['r2','bucket','info',config.r2_buckets[0].bucket_name],{capture:true});}
 catch(error){if(!/10006|bucket.*not.*found|specified bucket does not exist/i.test(error.stderr+error.stdout))throw error;await wrangler(['r2','bucket','create',config.r2_buckets[0].bucket_name,'--location','weur','--update-config=false']);}
 await requirePrivateBucket(config.r2_buckets[0].bucket_name);
 let secrets;
 try{secrets=jsonOutput(await wrangler(['secret','list','--format','json'],{capture:true}));}
 catch(error){if(!/10007|worker.*not.*found|worker.*does not exist|could not find.*worker/i.test(error.stderr+error.stdout))throw error;secrets=[];}
 const values={};
 if(!secrets.some(secret=>secret.name==='CONFIG_KEY')){values.CONFIG_KEY=process.env.CONFIG_KEY||randomBytes(48).toString('base64url');if(values.CONFIG_KEY.length<32)throw new Error('CONFIG_KEY needs at least 32 characters.');}
 if(!secrets.some(secret=>secret.name==='AUTHOR_INITIAL_PASSWORD')){if(!process.env.AUTHOR_INITIAL_PASSWORD||process.env.AUTHOR_INITIAL_PASSWORD.length<15)throw new Error('Set your private AUTHOR_INITIAL_PASSWORD as a build secret before the first deployment.');values.AUTHOR_INITIAL_PASSWORD=process.env.AUTHOR_INITIAL_PASSWORD;}
 if(process.env.AUTHOR_INITIAL_USERNAME)values.AUTHOR_INITIAL_USERNAME=process.env.AUTHOR_INITIAL_USERNAME;
 if(Object.keys(values).length)await wrangler(['secret','bulk'],{input:JSON.stringify(values)});
 await wrangler(['d1','migrations','apply',config.d1_databases[0].database_name,'--remote']);
 console.log('The database, private file storage and store encryption are ready.');
}
if(process.argv[1]===fileURLToPath(import.meta.url))setup().catch(error=>{console.error(error.message);if(error.stderr)console.error(error.stderr);process.exitCode=1;});
