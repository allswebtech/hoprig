# Security

- Applies when: always, as `full`. It has no light form, and no kind or size of project makes it lighter.
- Light form: none. Each rule acts wherever its thing exists (accounts, tenants, admins, uploads, webhooks, mobile
  apps, API clients, personal data, files and commands of a tool); the applies table names the things that exist.

## Servers, web apps and mobile apps

1. Every protected page, server action and API checks the session and the role on the server. Never trust the
   client. A middleware or proxy check is only a first filter, never the only check.
2. Multi-tenant data: every query filters by the tenant from the session. Tests prove that user A cannot read or
   change user B's data.
3. Sessions in `httpOnly`, `Secure`, `SameSite=Lax` cookies. Rotated at login, revoked at logout and at a password
   change.
4. Mobile apps use bearer tokens from the same sign-in library (its bearer plugin, where it has one); the API takes
   both. Other systems call it with API keys: random, shown once, stored only as an HMAC hash derived from the root
   secret, one per client, revocable and rate-limited per key; with no admin area they are managed with a small
   server-side command (`node scripts/api-key.mjs create|revoke|list`). An API that apps or other systems call is
   versioned (`/api/v1/...`): never break a version that a published app or a client uses; add a new version instead.
5. Admin accounts use two-factor login. Admin and money actions are written to an audit log.
6. Rate limits on login, codes, sign-up, password reset, contact forms and other costly endpoints. One-time codes are
   stored hashed, short-lived and limited in attempts.
7. Schemas for our own inputs are strict (unknown fields refused). Webhook and other third-party payloads ignore
   unknown fields, so a provider that adds a field never breaks us. A request body is never spread into the database.
8. No XSS (no unsanitised HTML), no CSRF (origin checks on cookie-based APIs), no open redirects (allow-listed return
   addresses), no SSRF (no fetching of an address a user gave without an allow-list), no SQL injection (parameters
   only).
9. Security headers: HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors` and a
   CSP. A nonce CSP makes pages dynamic: use it on dynamic pages and the strictest static-safe CSP on public pages.
   Write the choice in `decisions.md`.
10. CORS allows only our own origins. Mobile apps need no CORS.
11. Uploads: the real file type and size are checked, the bucket is private, keys are random, links are signed.
12. Webhooks: the signature is checked first, then the payload is processed.
13. The environment holds only the names of the services reference, validated at start and different per
    environment. Every other secret (provider keys, webhook secrets) is an admin setting sealed with the root secret;
    a project with no database keeps them as environment names (the services reference). Never log passwords,
    tokens, codes, card or bank data, or full personal data.
14. The package manager's audit is clean; an issue with no fix yet is in the report with its risk. The secret scanner
    is clean.
15. Personal data: collect only what is needed. Privacy policy and terms pages (documents in the repository when the
    project has no pages), drafted from the real use of data and listed in the report for the owner's review. Follow
    the data law of the country in the details (the owner's defaults name it). When users can sign up: account
    deletion inside the app (both app stores ask for it) and on a public web page (one store asks for that too). When
    an admin makes the accounts, an admin disables or deletes them instead. An API that receives or passes on
    personal data has the privacy and terms documents too, masks that data in logs and hashes any cache key built
    from it.
16. Before done: a security review of sign-in, permissions, tenant isolation, payments, uploads, webhooks and every
    other place that takes input. Use a security-review skill when your tool has one.

## Command-line tools, libraries, extensions and desktop apps

17. Every input is data: arguments, files, the environment, pages an extension reads, other programs' output.
    Every argument to another program is a list, never a shell string built from input; a path from outside is
    checked to stay where it belongs.
18. Safe defaults: what deletes, overwrites, costs money or opens a network port is off until asked for, and a
    `--dry-run` really changes nothing (a test compares the whole temporary home before and after).
19. Files are written atomically (a temporary file, then a rename) and never through a link that leads elsewhere.
20. A library never reads the environment, the network or the disk unless its caller asks for it.
21. An extension asks for the fewest permissions and host patterns that work, runs no remote code, and keeps a strict
    CSP. A desktop app keeps its web content isolated from the system (no node access in its pages, a strict CSP,
    only its own content loaded).
22. Secrets are never printed, logged, committed or put into a published package; rules 14 and 16 hold for these
    kinds too.
