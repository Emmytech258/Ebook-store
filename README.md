# Independent ebook store starter

This clean source package contains a digital bookshop, private owner portal, multi-book checkout, protected PDF and ZIP delivery, receipt emails, reviews, sales records, responsive layouts and optional Meta Pixel and Conversions API support.

The production catalog starts empty. Gateway keys, email keys and tracking IDs are blank. Checkout starts in setup mode, earlier sales start at zero, and unfinished-checkout reminders start disabled. The vector images in public/assets are generic placeholders. Fictional products in tests/fixtures exist only for automated checks and never seed production.

## Start here

1. Extract the ZIP and create a new repository in your own GitHub account. Upload this directory's contents, including source, configuration, migrations and tests. Put package.json at the repository root. Uploading only a ZIP to GitHub does not extract its contents.
2. Give Claude access to that new repository or attach this source package. Use an interface that can edit files if you want it to implement changes. A read-only GitHub integration cannot push code by itself.
3. Paste the complete CLAUDE_SETUP_PROMPT.txt into Claude. It will collect your business facts, domain, email, catalog, providers, currencies and optional tracking choices.
4. Use your own Cloudflare, gateway, Resend and Meta accounts. Enter secrets through secure dashboards or the private portal. Never paste secrets into chat, source or issues.

## Configure your public identity

Edit store.config.json with your own store name, public copy, support email, domain, resource names and logo path. Replace the generic logo with an asset you own. The file contains public values only.

Run in the directory that contains package.json:

```sh
npm ci
npm run configure
npm run check
npm test
npm run build
```

The configure command writes your domain and resource names into wrangler.json. It refuses placeholder domains and missing contact details. The delivered manifest has no routes and therefore no destination until you configure it. This command changes local files only.

The app currently uses /books/ and its portal uses /books/author/. On a fresh hostname, deployment_mode custom-domain serves the Worker on your own hostname and redirects / to /books/. If another website already uses the hostname, choose path-route and have Claude check the actual Cloudflare zone and proxied DNS. Another base path needs coordinated source and test changes.

For a local run, copy .dev.vars.example to .dev.vars, generate a fresh random CONFIG_KEY, choose a private initial password of at least 15 characters, apply local D1 migrations and run npm run dev. Keep local secrets out of Git. The initial username defaults to owner; AUTHOR_INITIAL_USERNAME can change it at first initialization. Change the initial password in the portal and enable authenticator login before live checkout.

## Included payment adapters

| Provider | Current implementation |
| --- | --- |
| Flutterwave | v3 Standard collection in NGN with server verification |
| Bachs | GHS, KES, MWK, RWF, TZS, UGX, XAF, XOF and ZMW mobile money with authenticated checkout verification and matching signed success proof |
| Other gateways | Require an adapter and meaningful tests before live use |

Provider account approval controls available methods and currencies. A key cannot activate a disabled method. Optional Bachs USD card code exists, but USD is absent from the default currency list. Enable it only with account approval and a complete test.

Prices currently use NGN as the base through price_ngn. Reports and the twice-daily rate windows use UTC. Tell Claude if you need another base currency or timezone. Changing labels alone does not change calculations.

Live checkout requires email setup, a changed initial password and a ready provider. Test checkout, verification and file access require owner authentication. Test purchases do not add live sales. A browser redirect cannot mark an order paid.

## Main files

| File or directory | Purpose |
| --- | --- |
| CLAUDE_SETUP_PROMPT.txt | Complete setup brief to paste into Claude |
| CLAUDE.md | Repository instructions for Claude |
| store.config.json | Public identity and deployment values |
| src/ | Worker, authentication, payments, email and storage |
| public/ | Storefront and owner portal |
| migrations/ | Schema for a new independent D1 database |
| tests/ | Payment, security, UI and fresh-install checks |
| SETUP_STATUS.md | Public progress and launch record |

The transfer archive contains no Git history, buyer database, paid book files, real credentials, cloud state, logs, build output or dependency installation. Install dependencies yourself using the committed npm lockfile.

Adding a provider or market may need code, account approval and different legal notices. Claude should verify official documentation and describe remaining limits before calling the shop ready.
