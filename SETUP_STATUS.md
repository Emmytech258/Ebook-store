# Store setup status

Track public progress only. Do not add secrets, recovery codes, buyer data or private purchase links.

Last updated: 2026-10-19

| Area | State | Evidence / next action |
| --- | --- | --- |
| Business identity and copy | Partly done | Store name set to Revival Fire Forum; tagline and homepage copy are drafts for owner approval. Registered business name, seller country and public contact details still pending |
| Own GitHub repository | Layout fixed locally, not pushed | Repo Emmytech258/Ebook-store, branch main. Starter files on GitHub are still in a nested folder. Claude's GitHub access is read-only (push returns 403). Owner to upload the cleaned zip or grant the Claude GitHub App write access |
| Domain and Cloudflare | Domain active | revivalfireforum.online bought at Namecheap on 2026-10-19 (1 year; renewal is far higher, review before it renews). Added to Cloudflare Free plan; nameservers changed and Cloudflare shows Active. store.config.json domain set; npm run configure applied (custom-domain mode). Namecheap parking A and www CNAME records must be deleted before first deploy |
| Independent D1 and private R2 | Not created | Names chosen in store.config.json: revival-fire-forum-db, revival-fire-forum-files. Create after the Cloudflare account exists |
| Owner login and authenticator | Not initialized | Pending private setup |
| Catalog, covers and PDFs | Empty | Owner will upload all books in the portal |
| Provider and currencies | Disabled | Owner has Flutterwave and Bachs with test and live approved. Keys go in the owner portal only |
| Resend and support inbox | Disabled | Owner wants a full mailbox for replies. support_email set to hello@revivalfireforum.online (assumed from the owner's note, confirm). Namecheap's default forwarding MX records are still in DNS and will be replaced when the mailbox is chosen |
| Privacy, terms, refunds, cancellation | Needs owner rules | Refund and cancellation rules still to be decided |
| Meta Pixel and CAPI | Wanted, disabled for now | Owner has a Meta ads account and Pixel. Consent controls to be reviewed before enabling |
| Checkout reminders | Wanted, disabled for now | Enable only after the privacy notice covers them |
| Mobile, payments, files | Local tests only | npm run check, npm test (107 passing) and npm run build (dry run) pass locally. Own-domain checks pending |
| Live launch | Not deployed | Pending domain, Cloudflare, providers, email and authorized verification |
