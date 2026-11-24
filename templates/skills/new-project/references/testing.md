# Testing: complete and fast

- Applies when: always, as `full`. What a test proves is never reduced.
- Light form: none. A case, a check or a CI job is written only for what the project has (no page checks without
  pages, no database tests without a database, no mobile job without apps), and the scale tests follow the tiers of
  the database and performance references.

## What to test (every row of `docs/test-matrix.md`)

1. Every page, screen, command, feature, flow and function, with each of these cases that applies: happy path; empty
   data; invalid input and limits (0, max, very long, another script than the first language's, emoji, special
   characters); logged out; wrong role; another user's or tenant's data (must fail); double click and double submit;
   expired session; rate limit hit; slow or failed network; provider failure; last page of pagination; two users
   editing the same thing.
2. Every page in light and dark at 375, 768 and 1280+ px: no console errors, no hydration warnings, no sideways
   overflow, zero accessibility violations (for example axe).
3. Lighthouse on every public page, desktop and mobile.
4. Pages built from data (products, posts, profiles) are checked per template with a few real records, not every
   address.
5. Scale: the database's plan test and the performance reference's load test.
6. Security, payment and permission tests must be seen failing once with the protection removed (then put back), so
   a green run really proves something.
7. Coverage: 100% of branches in sign-in, permissions, payments, money and webhook code.
8. A feature is complete only when the type check, lint, its tests and the production build pass, its permissions,
   loading and error states and its mobile layout are checked, and no secret is exposed.
9. A command-line tool or a library: every command or public function with its cases (rule 1's that apply, plus a
   missing argument, a bad flag, an unreadable file, no network, an interrupted run and a run again), its help text
   and exit codes, and its own speed on a large input measured and written down.

## How to keep it fast

10. Most checks are fast unit tests: logic, validation, money, permissions.
11. Database tests use a real PostgreSQL. Each worker gets its own database cloned from a migrated template (under a
    second).
12. Browser tests run against the production build with full parallelism and as many workers as the computer runs
    without time-outs, sharded in CI. Each worker gets its own users and tenant, logged in once through the API and
    reused (stored state). Tests that change data make their own records through SQL or the API, never through
    clicks, so parallel tests never collide. Third-party requests are blocked. Providers are mocked at the HTTP edge
    (a request mock in unit tests; a local mock server whose base address the browser tests' seed writes into the
    admin settings, never env; with no database there are no settings, so there the base address is one more name of
    the Env light form, left empty outside tests), and their real test mode is checked once.
13. While building, run only the affected tests (for example `vitest related --run <files>`). Run the whole suite at
    the end of each phase and at the final review.
14. Lighthouse performance runs one at a time per computer, because parallel runs distort scores. Spread them across
    CI jobs instead.
15. No fixed sleeps: waiting assertions. A flaky test is a bug to fix, not to retry.

## CI (parallel jobs, cached, under 10 minutes)

16. Web: type check, lint, format check, unit and database tests (a database service), build, browser test shards,
    Lighthouse CI with budgets, the dependency audit, the secret scanner (run the binary: some scanners' CI actions
    need a licence key for organisations), the unused-code finder.
17. Mobile: analyse, test, build.
18. A nightly or manual job: scale seed, database plan test and load test (too slow for every push). Only the ones
    this project's tiers call for.
19. A command-line tool or a library: the suite on every supported runtime version and operating system it names.
