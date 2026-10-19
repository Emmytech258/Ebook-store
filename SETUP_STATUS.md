# Store setup status

Track public progress only. Do not add secrets, recovery codes, buyer data or private purchase links.

Last updated: 2026-10-19

| Area | State | Evidence / next action |
| --- | --- | --- |
| Business identity and copy | Logo added | Owner logo (round badge, transparent corners) added as public/assets/revival-fire-forum-logo.png and the dark-mode white-out filter removed. Tagline and homepage copy are still drafts for owner approval. Registered business name, seller country and policy wording pending owner approval |
| Own GitHub repository | Pushed to main | Repo Emmytech258/Ebook-store, branch main. Clean files at the repo root pushed on 2026-10-19 (commit 8bec7c2). Claude now has write access |
| Domain and Cloudflare | Domain active | revivalfireforum.online bought at Namecheap on 2026-10-19 (1 year; renewal is far higher, review before it renews). Added to Cloudflare Free plan; nameservers changed and Cloudflare shows Active. store.config.json domain set; npm run configure applied (custom-domain mode). Owner deleted the Namecheap parking A and www CNAME records on 2026-10-19 |
| Independent D1 and private R2 | Deployed by build | R2 enabled by owner. Workers Build #891f9986 on main succeeded on 2026-10-19; the deploy script creates the D1 database and private bucket and refuses a public bucket. Owner to confirm both appear in the Cloudflare dashboard |
| Owner login and authenticator | Pending first login | Initial password was set privately as a build secret. Owner must log in at /books/author/, change the password, enable the authenticator and store recovery codes privately |
| Catalog, covers and PDFs | Empty | Owner will upload all books in the portal |
| Provider and currencies | Disabled | Owner has Flutterwave and Bachs with test and live approved. Keys go in the owner portal only |
| Resend and support inbox | Decision made, setup pending | Owner uses revivalfireforum@gmail.com as the public support and reply address (receipt emails send replies to the support email). Plan: send from hello@revivalfireforum.online through Resend after the domain is verified in Cloudflare DNS. Resend, portal email settings and a real test email are still pending |
| Privacy, terms, refunds, cancellation | Needs owner rules | Refund and cancellation rules still to be decided |
| Meta Pixel and CAPI | Wanted, disabled for now | Owner has a Meta ads account and Pixel. Consent controls to be reviewed before enabling |
| Checkout reminders | Wanted, disabled for now | Enable only after the privacy notice covers them |
| Mobile, payments, files | Local tests only | npm run check, npm test (107 passing) and npm run build (dry run) pass locally. Own-domain checks pending |
| Live launch | Deployed, not selling | Worker revival-fire-forum-store deployed from main (build #891f9986). https://revivalfireforum.online/books/ and /books/author/ return the Revival Fire Forum pages (checked with a text fetch only; browser check by owner pending). Checkout stays in setup mode until email, provider keys and sandbox tests are done |
