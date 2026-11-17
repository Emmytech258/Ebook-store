import {spawnSync} from 'node:child_process';
import {readdir,readFile} from 'node:fs/promises';
let failed=false;
for(const directory of ['src','public','scripts'])for(const file of await readdir(directory))if(/\.(?:js|mjs)$/.test(file)){
 const result=spawnSync(process.execPath,['--check',directory+'/'+file],{stdio:'inherit'});if(result.status!==0)failed=true;
}
for(const file of await readdir('migrations'))if(file.endsWith('.sql'))for(const line of (await readFile('migrations/'+file,'utf8')).split('\n'))if(line.trim()&&!line.trim().endsWith(';')){console.error('migrations/'+file+': every statement must end with a semicolon.');failed=true;break;}
if(failed)process.exitCode=1;else console.log('All application and deployment scripts passed syntax checks.');
