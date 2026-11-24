# Performance and heavy traffic

- Applies when the project has web pages (the parts "Pages" and "Targets") or code that runs per request (the part
  "Heavy traffic"): `full`, unless a light form below fits. It is never `not needed` while one of them exists (a
  command-line tool or a library has neither: `not needed`, and its own speed is a test case of the testing
  reference).
- Light form: each of these that fits, named in the applies table. Traffic tier S on one app process on a server of
  its own: no shared cache store, and the load test is the short one of tier S (both as written below). Serverless is
  never one process: even one form's rate limit needs a shared store (Valkey or Redis, or the host's Redis-compatible
  store), so choose the deployment before you write this line and make the line agree with it. API or backend only:
  no "Pages" and no "Targets". Static files only (traffic tier 0): "Pages", "Targets" and the caching rule of "Heavy
  traffic", nothing else.

The targets below are the skill's; the owner's defaults may name his own.

## Pages

1. Public pages are static or cached and served from the CDN. Dynamic rendering only for personal data. Slow parts
   stream in (for example with Suspense).
2. Minimal client JavaScript. No heavy interface or animation libraries. A heavy component the product really needs
   (a chart, a map, an editor) is lazy-loaded. Look at the bundles with the analyzer of the installed framework
   version. A page-score budget in continuous integration fails when a public page's JavaScript grows more than 10%
   over its recorded baseline.
3. Images through the framework's image component, AVIF or WebP, the right `sizes`, width and height always set;
   only the largest image above the fold is preloaded.
4. Fonts self-hosted through the framework's font loader (subset, `display: swap`), or the system font stack.
5. No third-party scripts on public pages unless the owner approves. Approved ones load after the page is idle.
6. Zero layout shift: space is kept for images, embeds and loading skeletons.

## Targets

7. Lighthouse 100 for Performance, Accessibility, Best Practices and SEO on every public page (every page that opens
   without login, also the login, reset and error pages; SEO is not scored on a `noindex` page), desktop and mobile.
   The main page behind login gets the first three.
8. Mobile Performance varies a little between runs, so continuous integration takes the median of 3 runs and fails
   when a score drops below its recorded baseline or mobile Performance below 95. The report shows the real scores.
9. Core Web Vitals floor: LCP under 2.5 s, INP under 200 ms, CLS under 0.1. Aim far lower.

## Heavy traffic

10. App servers keep no state of their own, so scaling means adding instances.
11. Caching: static files immutable for one year, HTML through the CDN with revalidation, safe GET responses with
    `Cache-Control` and `ETag`, private data `no-store`.
12. Session checks do not reach the database on every request (a signed cookie cache of at most 5 minutes, or a
    cache store). Sensitive actions (payments, role changes, account changes) check the session in the database, so
    a revoked session stops at once.
13. One app process: an in-memory cache and rate limits are fine. More than one process or instance, or serverless:
    Valkey or Redis for rate limits, cache and sessions. Never rate-limit counters in the main database.
14. Slow work (mail, processing other services' hooks, images, reports) runs in background jobs, not in the request.
    The one exception is in the services reference (Mail).
15. API responses carry only the fields needed, are paginated and compressed.
16. A load test (k6, or autocannon through npx) on the production build, locally or on staging (never production
    without the owner's ok), at the expected peak: API p95 under 200 ms, zero errors. Report the numbers.
17. The rate and length of the load test, by traffic tier. S: 20 requests per second for 1 minute. M: the expected
    peak (200 when there is no number) for 3 minutes. L: the expected peak (2,000 when there is no number) for 5
    minutes. XL: the expected peak, at least 2,000, for 10 minutes. It runs the main API and dynamic-page paths.
    Endpoints with a rate limit (login, codes, forms) are left out; the testing reference tests their limits. A
    project with no other path has no load test. When this computer cannot produce the rate, report the highest rate
    it held and list the staging run in the report as open.
