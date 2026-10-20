# Store setup status

Track public progress only. Do not add secrets, recovery codes, buyer data or private purchase links.

Last updated: 2026-10-21

| Area | State | Evidence / next action |
| --- | --- | --- |
| Business identity and copy | Logo added | Owner logo (round badge, transparent corners) added as public/assets/revival-fire-forum-logo.png and the dark-mode white-out filter removed. Tagline and homepage copy are still drafts for owner approval. Registered business name, seller country and policy wording pending owner approval |
| Own GitHub repository | Pushed to main | Repo Emmytech258/Ebook-store, branch main. Clean files at the repo root pushed on 2026-10-19 (commit 8bec7c2). Claude now has write access |
| Domain and Cloudflare | Domain active | revivalfireforum.online bought at Namecheap on 2026-10-19 (1 year; renewal is far higher, review before it renews). Added to Cloudflare Free plan; nameservers changed and Cloudflare shows Active. store.config.json domain set; npm run configure applied (custom-domain mode). Owner deleted the Namecheap parking A and www CNAME records on 2026-10-19 |
| Independent D1 and private R2 | Deployed by build | R2 enabled by owner. Workers Build #891f9986 on main succeeded on 2026-10-19; the deploy script creates the D1 database and private bucket and refuses a public bucket. Owner to confirm both appear in the Cloudflare dashboard |
| Owner login and authenticator | Pending first login | Initial password was set privately as a build secret. Owner must log in at /books/author/, change the password, enable the authenticator and store recovery codes privately |
| Catalog, covers and PDFs | Empty | Owner will upload all books in the portal |
| Provider and currencies | Test keys saved, store in test mode | Flutterwave test key and webhook secret hash, and Bachs sandbox key and webhook signing secret, saved in the owner portal on 2026-10-20. The portal shows all ten currencies ready in test mode. Bachs sandbox key check passed. Flutterwave test and live webhooks use the same URL and secret hash. Live keys not entered. No test payment made yet, so webhook delivery, receipts and downloads are still unproven |
| Resend and support inbox | Working in test | Domain revivalfireforum.online verified in Resend (Ireland); DKIM, rsend and send CNAMEs and DMARC (p=none) added in Cloudflare, existing eforward MX and root SPF untouched, receiving off. Portal sender hello@revivalfireforum.online, name Revival Fire Forum. Test email reached the Gmail inbox on 2026-10-21. Reply path and a real receipt email still to test |
| Privacy, terms, refunds, cancellation | Pages added, owner review pending | Owner approved the refund rule on 2026-10-19: no refund after delivery except non-delivery, double charge or a broken or wrong file; report within 7 days; reply within 24 hours on working days. New pages /books/refunds/, /books/delivery/ and /books/terms/ plus footer links; privacy page updated for the tracking choice. Wording is a plain-language draft, not legal advice. Owner to read each page in a browser |
| Meta Pixel and CAPI | Consent popup added, tracking still off | Visitors now see an Accept / No thanks notice before any Meta script, cookie or event runs, and a Tracking choices button stays in the footer. Purchase events to Meta are sent only for orders placed after the buyer accepted. Pixel ID, token and test event still to be entered and checked in Meta Test Events. Tracking only runs in live mode |
| Checkout reminders | Wanted, disabled for now | Enable only after the privacy notice covers them |
| Mobile, payments, files | Local tests only | npm run check, npm test (113 passing) and npm run build (dry run) pass locally. Own-domain checks pending |
| Live launch | Test mode, not selling | Store set to test mode on 2026-10-20. No books uploaded yet. Live needs live keys, live webhooks, a small real purchase and reconciliation |
