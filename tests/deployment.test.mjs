import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {requirePrivateBucket} from '../scripts/cloudflare-setup.mjs';

const require=createRequire(import.meta.url);
const installedWrangler=dirname(require.resolve('wrangler/package.json'));
const version=require('wrangler/package.json').version;
const source=await readFile(new URL('../scripts/cloudflare-setup.mjs',import.meta.url),'utf8');

for(const layout of ['local','parent','pnpm'])test('deployment runs Wrangler with '+layout+' dependencies',async()=>{
 const fixture=await mkdtemp(join(tmpdir(),'bookshop-deploy-'));
 try{
  const app=join(fixture,'bookshop');
  await mkdir(join(app,'scripts'),{recursive:true});
  await writeFile(join(app,'scripts','cloudflare-setup.mjs'),source);
  const modules=layout==='parent'?join(fixture,'node_modules'):join(app,'node_modules');
  await mkdir(modules,{recursive:true});
  if(layout==='pnpm'){
   const store=join(fixture,'node_modules','.pnpm','wrangler@'+version,'node_modules');
   await mkdir(store,{recursive:true});
   await symlink(installedWrangler,join(store,'wrangler'),'dir');
   await symlink(join(store,'wrangler'),join(modules,'wrangler'),'dir');
  }else await symlink(installedWrangler,join(modules,'wrangler'),'dir');
  const result=spawnSync(process.execPath,['--input-type=module','-e',"import {wrangler} from './scripts/cloudflare-setup.mjs'; console.log(await wrangler(['--version'],{capture:true}));"],{
   cwd:app,env:{...process.env,WORKERS_CI:'',WRANGLER_SEND_METRICS:'false'},encoding:'utf8',timeout:30000
  });
  assert.equal(result.status,0,result.stderr||result.error?.message);
  assert.ok(result.stdout.includes(version),result.stdout);
 }finally{await rm(fixture,{recursive:true,force:true});}
});

test('Cloudflare installs the app lockfile from the bookshop directory',async()=>{
 const fixture=await mkdtemp(join(tmpdir(),'bookshop-install-'));
 try{
  const app=join(fixture,'bookshop'),bin=join(fixture,'bin'),record=join(fixture,'install.json');
  await mkdir(join(app,'scripts'),{recursive:true});
  await mkdir(bin);
  await writeFile(join(app,'scripts','cloudflare-setup.mjs'),source);
  await writeFile(join(app,'package-lock.json'),'{"lockfileVersion":3}');
  const executable='#!'+process.execPath+'\n'+"require('node:fs').writeFileSync(process.env.INSTALL_RECORD,JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),lock:require('node:fs').existsSync('package-lock.json')}));\n";
  await writeFile(join(bin,'npm'),executable,{mode:0o755});
  const result=spawnSync(process.execPath,['--input-type=module','-e',"import {installBuildDependencies} from './scripts/cloudflare-setup.mjs'; await installBuildDependencies();"],{
   cwd:app,env:{...process.env,WORKERS_CI:'1',PATH:bin+':'+process.env.PATH,INSTALL_RECORD:record},encoding:'utf8',timeout:30000
  });
  assert.equal(result.status,0,result.stderr||result.error?.message);
  const observed=JSON.parse(await readFile(record,'utf8'));
  assert.equal(observed.cwd,app);
  assert.equal(observed.lock,true);
  assert.deepEqual(observed.args,['ci','--no-audit','--no-fund']);
 }finally{await rm(fixture,{recursive:true,force:true});}
});

test('Deployment verifies private R2 storage without changing an already private bucket',async()=>{
 const calls=[];await requirePrivateBucket('private-test-bucket',async args=>{calls.push(args);return args.includes('dev-url')?'Public access via the r2.dev URL is disabled.':'There are no custom domains connected to this bucket.';});
 assert.equal(calls.length,2);assert.equal(calls.some(args=>args.includes('disable')),false);
});
test('Deployment disables an exposed development URL and verifies the result',async()=>{
 const calls=[];let exposed=true;await requirePrivateBucket('private-test-bucket',async args=>{calls.push(args);if(args.includes('disable')){exposed=false;return 'disabled';}if(args.includes('dev-url'))return exposed?"Public access is enabled at 'https://test-only.r2.dev'.":'Public access via the r2.dev URL is disabled.';return 'There are no custom domains connected to this bucket.';});
 assert.deepEqual(calls[1],['r2','bucket','dev-url','disable','private-test-bucket','--force']);assert.equal(calls.length,4);
});
test('Deployment refuses any enabled bucket custom domain',async()=>{
 await assert.rejects(requirePrivateBucket('private-test-bucket',async args=>args.includes('dev-url')?'Public access via the r2.dev URL is disabled.':'domain: public.example.com\nenabled: Yes\nssl_status: active'),/public or unverified custom domain/);
});
test('Deployment accepts only explicitly disabled custom domain access',async()=>{
 await assert.doesNotReject(requirePrivateBucket('private-test-bucket',async args=>args.includes('dev-url')?'Public access via the r2.dev URL is disabled.':'domain: private.example.com\nenabled: No\nssl_status: active\n\ndomain: other.example.com\nenabled: No\n'));
});
test('Deployment fails closed on unknown storage output or a failed disable operation',async()=>{
 await assert.rejects(requirePrivateBucket('private-test-bucket',async()=>''),/privacy could not be verified/);
 await assert.rejects(requirePrivateBucket('private-test-bucket',async args=>{if(args.includes('disable'))throw new Error('Insufficient storage permissions');return "Public access is enabled at 'https://test-only.r2.dev'.";}),/Insufficient storage permissions/);
 await assert.rejects(requirePrivateBucket('private-test-bucket',async args=>args.includes('dev-url')?'Public access via the r2.dev URL is disabled.':'unknown domain format'),/unverified custom domain/);
});
