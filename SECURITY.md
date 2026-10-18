# Security and ownership

This starter has no runtime data from another store. Production starts with an empty catalog, setup mode, no provider or email keys, no Pixel ID and no live tracking. Every installation needs its own accounts, resources, secrets, identity and content.

## Preserved controls

- Owner authentication uses a salted password hash and a server-side secret. Sensitive settings require password confirmation and an authenticator code when enabled.
- Cookies use Secure, HttpOnly and SameSite protections. Owner writes need origin and CSRF checks. Login and public APIs have rate limits.
- Optional authenticator login uses replay protection and recovery codes. Enrollment and recovery changes require reauthentication.
- Provider and email keys stay encrypted in D1 under CONFIG_KEY. The API returns key-presence flags, not saved values.
- Payments must match their saved reference, amount, currency and environment through authenticated provider reads. Bachs also requires a signed matching success event. Optional method metadata cannot replace proof of money received.
- Partial and ambiguous payments do not release files or request another full payment. Paid status wins over late failures.
- Repeated success events do not duplicate receipts, sales counts or Meta Purchase events. Test sales stay separate from live sales.
- Owner authentication protects test checkout, verification and downloads even after the shop switches to live mode.
- Private R2 storage and expiring signatures protect PDFs. Downloads require the matching paid order and purchased book. Direct paths do not serve PDFs.
- Private pages keep external tracking scripts away from purchase keys. Meta Purchase events follow verified live payments.

## Owner responsibilities

Use a strong unique password, enable authenticator login and keep recovery codes privately. Secure your registrar, GitHub, Cloudflare, email, payment and Meta accounts with their available MFA. Limit API permissions. Collection credentials do not need authority to send payouts.

Keep .dev.vars, environment files, database exports, credentials, cloud state, logs and dependencies out of Git and transfer archives. Separate test and live credentials. Never reuse another store's encryption key, login, database or bucket.

Review privacy, advertising consent, support, refund and cancellation rules for your business and markets. Pixel, CAPI and checkout reminders should stay disabled until you choose them and meet the relevant notice and consent rules.

Do not remove payment checks to make a test pass. Do not mark orders paid from redirects, screenshots or unsigned callbacks. Verify against the saved provider environment. If a provider reports success but its own balance does not show the credit, inspect its transaction and settlement records and raise the charge reference with support.

## Verification limits

Automated tests use fictional products and mocked provider calls. They do not prove that your live account has approval, a bank received a payout or a buyer received an actual email. Finish sandbox and authorized live checks on your own deployment. If Claude lacks browser access, it should report that limit and provide focused manual checks.
