# Starter validation

Prepared 18 October 2026.

- A clean npm ci installation completed using the pinned lockfile and its integrity checks.
- All 107 automated tests passed. They cover checkout, provider verification, signed payment events, private PDF and ZIP access, receipt delivery, purchase counts, owner authentication, authenticator security, UI behavior and an empty production installation.
- Application and deployment syntax checks passed.
- The Wrangler dry-run build completed successfully with the DB, FILES and ASSETS bindings. This was a local build, not a live deployment.
- The transfer audit found no previous merchant identity, book titles, owned images, tracking ID, account identifiers or customer references in the delivered source.
- The production seed list is empty, earlier sales start at zero, keys and tracking IDs are blank, checkout starts in setup mode and reminders start disabled.
- The archive excludes Git history, runtime databases, private book PDFs, secrets, cloud state, build output, dependency folders and logs.

The tests use fictional products and mocked payment and email services. They do not verify a new owner's credentials, gateway approval, actual email delivery, bank settlement or own-domain deployment. Complete those checks using the owner setup prompt.

A browser review of the new owner's eventual deployment remains part of setup. Local automated DOM checks do not replace that review.
