# Store setup status

Track public progress only. Do not add secrets, recovery codes, buyer data or private purchase links.

Last updated: 2026-10-18

| Area | State | Evidence / next action |
| --- | --- | --- |
| Business identity and copy | Partly done | Store name set to Revival Fire Forum; tagline and homepage copy are drafts for owner approval. Registered business name, seller country and public contact details still pending |
| Own GitHub repository | Layout fixed locally | Repo Emmytech258/Ebook-store, branch main. Starter files were uploaded inside a nested folder and are now moved to the repository root. Push from Claude is blocked until the Claude GitHub App has access; owner must fix or upload manually |
| Domain and Cloudflare | Not started | Owner will buy a .online domain (planned revivalfireforum.online) at Namecheap, then create a Cloudflare account. domain and support_email in store.config.json are blank until confirmed; npm run configure refuses blanks |
| Independent D1 and private R2 | Not created | Names chosen in store.config.json: revival-fire-forum-db, revival-fire-forum-files. Create after the Cloudflare account exists |
| Owner login and authenticator | Not initialized | Pending private setup |
| Catalog, covers and PDFs | Empty | Owner will upload all books in the portal |
| Provider and currencies | Disabled | Owner has Flutterwave and Bachs with test and live approved. Keys go in the owner portal only |
| Resend and support inbox | Disabled | Owner wants a full mailbox for replies (not forwarding only). Address to be confirmed (hello@ on the new domain) |
| Privacy, terms, refunds, cancellation | Needs owner rules | Refund and cancellation rules still to be decided |
| Meta Pixel and CAPI | Wanted, disabled for now | Owner has a Meta ads account and Pixel. Consent controls to be reviewed before enabling |
| Checkout reminders | Wanted, disabled for now | Enable only after the privacy notice covers them |
| Mobile, payments, files | Local tests only | npm run check, npm test (107 passing) and npm run build (dry run) pass locally. Own-domain checks pending |
| Live launch | Not deployed | Pending domain, Cloudflare, providers, email and authorized verification |
