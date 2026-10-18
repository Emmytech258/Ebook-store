import {setup,wrangler} from './cloudflare-setup.mjs';
try{
 await setup();
 await wrangler(['deploy']);
 console.log('Deployment uploaded. Open your own domain at /books/ and /books/author/.');
 console.log('Your domain must use an active Cloudflare zone and the required proxied DNS for the routes.');
}catch(error){console.error(error.message);if(error.stderr)console.error(error.stderr);process.exitCode=1;}
