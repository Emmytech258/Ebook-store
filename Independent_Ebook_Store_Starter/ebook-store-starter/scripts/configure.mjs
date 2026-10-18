import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
export function deploymentConfig(input){
 const domain=String(input.domain||'').trim().toLowerCase();
 if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)||/\.(invalid|example|localhost|test)$/.test(domain)||['example.com','example.org','example.net'].includes(domain))throw new Error('Set domain to your own real domain in store.config.json, without https or a path.');
 if(!String(input.store_name||'').trim()||String(input.store_name).length>100)throw new Error('Add your own store_name in store.config.json.');
 if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.support_email||'')||/\.invalid$/i.test(input.support_email))throw new Error('Add your own support_email in store.config.json.');
 for(const key of ['worker_name','database_name','bucket_name'])if(!/^[a-z0-9][a-z0-9-]{2,59}$/.test(input[key]||''))throw new Error('Set a lowercase name for '+key+'.');
 if(!['custom-domain','path-route'].includes(input.deployment_mode))throw new Error('Choose custom-domain for a new hostname or path-route to keep another website on the same hostname.');
 if(!/^\/books\/assets\/[a-z0-9-]+\.(svg|webp|png|jpg)$/.test(input.logo_url||''))throw new Error('Use a local /books/assets/ logo_url.');
 return {domain,origin:'https://'+domain};
}
export async function configure(){
 const input=JSON.parse(await readFile(root+'store.config.json','utf8')),{domain,origin}=deploymentConfig(input);
 const config=JSON.parse(await readFile(root+'wrangler.json','utf8'));
 config.name=input.worker_name;config.vars={...config.vars,PUBLIC_ORIGIN:origin};config.workers_dev=false;config.preview_urls=false;
 config.routes=input.deployment_mode==='custom-domain'?[{pattern:domain,custom_domain:true}]:[{pattern:domain+'/books/*',zone_name:domain},{pattern:domain+'/books',zone_name:domain}];
 config.d1_databases[0].database_name=input.database_name;delete config.d1_databases[0].database_id;
 config.r2_buckets[0].bucket_name=input.bucket_name;
 await writeFile(root+'wrangler.json',JSON.stringify(config,null,2)+'\n');
 console.log('Configured your store for '+origin+'/books/. No remote resources changed.');
}
if(process.argv[1]===fileURLToPath(import.meta.url))configure().catch(error=>{console.error(error.message);process.exitCode=1;});
