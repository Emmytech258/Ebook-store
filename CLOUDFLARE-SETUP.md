# Your Cloudflare deployment

Use your own account, domain and resources. Ask Claude to guide the current dashboard and confirm each result. This is a deployment contract, not an existing account configuration.

## Domain choice

A fresh hostname can use a Worker Custom Domain with deployment_mode custom-domain. The app stays at /books/ and the root redirects there. A hostname that already serves another website can use path-route for /books/* and /books, with its active Cloudflare zone and proxied DNS. If the hostname is not the zone apex, Claude must set the actual zone name in the generated route entries. Keep workers_dev and preview URLs disabled when the public address should use your domain.

Cloudflare must assign the nameservers for your own zone. Before moving DNS, inventory web and mail records. Preserve working MX, SPF, DKIM, DMARC and certificate records. Do not delete records merely because their type matches an example. Coordinate DNSSEC with the registrar and Cloudflare during a nameserver move.

## Source and resources

Complete store.config.json and run npm run configure. Keep the app at the repository root, or set the exact application folder as the build root.

| Binding | Resource |
| --- | --- |
| DB | A new D1 database in your account |
| FILES | A new private R2 bucket in your account |
| ASSETS | This repository's public directory |
| PUBLIC_ORIGIN | Your HTTPS origin, without /books |

The setup script finds or creates the named D1 and R2 resources, checks storage privacy and applies migrations. Verify the authenticated account and distinct resource names before remote setup. Never reuse another store's resources. Review current service prices and billing requirements before enabling them. Adjust location hints if your data requirements demand a region.

## Private initialization

Generate a fresh CONFIG_KEY. It protects saved provider keys, private purchase links and owner security data. Keep it in Worker secrets and a private backup. Never commit it or replace it on an established database without a planned migration.

Supply AUTHOR_INITIAL_PASSWORD as a private build secret before first deployment. Use at least 15 characters. AUTHOR_INITIAL_USERNAME is optional and otherwise defaults to owner. The setup script uploads missing Worker initialization secrets through private stdin. If CONFIG_KEY is absent, it generates a random key or uses your privately supplied value. It does not print key values.

Change the initial portal password and enable authenticator login before live payments. Store recovery codes privately.

## Build and deployment

Use Workers Builds for this Worker and static asset application, not static-only Pages hosting. Confirm your own repository and production branch. At the application root, use npm run check as the build command and npm run deploy as the deploy command. The deployment wrapper installs the application's own npm lockfile when WORKERS_CI is 1.

The build identity needs the current permissions for its Worker, routes, D1 migrations and private R2 operations. Have Claude verify current requirements, including build-artifact permissions if the dashboard asks for them. Put tokens in secure build secrets and confirm their account scope.

Run checks, tests and a dry-run build before deployment. After actual deployment, verify this Worker's success status, domain, HTTPS, /books/, /books/author/ and the catalog API. An unrelated successful build or a dry run does not prove this shop is live.

## Storage and schedules

Keep the PDF bucket's public development URL disabled and avoid public custom domains on that bucket. The setup script checks this and refuses public or unknown states. Covers use the public cover API; PDF downloads require verified paid-order access.

The cron runs once per minute and retries confirmation, receipts and tracking, then performs cleanup. Each order has a longer provider-check interval to prevent excessive calls. Prices use two shared daily windows. Verify scheduled tasks after deployment.

## Provider destinations

The portal shows complete URLs for your configured domain. Paths are:

| Purpose | Path |
| --- | --- |
| Flutterwave charge webhook | /books/api/webhook |
| Bachs test webhook | /books/api/bachs/webhook/test |
| Bachs live webhook | /books/api/bachs/webhook/live |

Create Bachs destinations in the matching environments and subscribe to checkout.completed, collection.succeeded, collection.failed, collection.underpaid and checkout.expired. Save each destination's own signing secret in the matching portal field.

Flutterwave uses v3 verif-hash and one saved webhook_secret. If your account needs distinct test and live hashes, explain a compatible approved setup or add separate fields and matching verification. Do not claim two secret fields already exist.

## Official references

- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- https://developers.cloudflare.com/workers/configuration/routing/routes/
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/d1/
- https://developers.cloudflare.com/r2/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://resend.com/docs/dashboard/domains/introduction
- https://docs.bachs.io/guides/webhooks/overview

Consult current official documentation when a dashboard label, feature, permission or setup requirement differs.
