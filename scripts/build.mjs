import {wrangler} from './cloudflare-setup.mjs';
try{await wrangler(['deploy','--dry-run','--outdir','dist']);}
catch(error){console.error(error.message);if(error.stderr)console.error(error.stderr);process.exitCode=1;}
