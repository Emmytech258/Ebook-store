import {spawnSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
let failed=false;
for(const directory of ['src','public','scripts'])for(const file of await readdir(directory))if(/\.(?:js|mjs)$/.test(file)){
 const result=spawnSync(process.execPath,['--check',directory+'/'+file],{stdio:'inherit'});if(result.status!==0)failed=true;
}
if(failed)process.exitCode=1;else console.log('All application and deployment scripts passed syntax checks.');
