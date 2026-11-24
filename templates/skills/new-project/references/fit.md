# The fit in detail: the details, the size, the features, the stack, two examples

- Applies when: always, for every project (read it with SKILL.md's steps 1 and 2).
- Light form: none.

## The details

| Detail | What it holds |
|---|---|
| Name | the product's name as people see it |
| Project folder | the project's folder name, as `hoprig project new` made it |
| Code repositories | each in `code/<folder>-<part>` (`hoprig project add <folder> <part>`), one per deployable part and one per mobile app |
| Domain | the primary address |
| Support contact | the address users write to |
| Country, currency, time zone | what money, dates and the data law follow (the owner's defaults) |
| Languages | the first language, and the next ones planned |
| Kind | one of the kinds of SKILL.md (step 2), or a mix (name the parts) |
| Users and roles | who uses it and what each role may do |
| Sign-in | the methods (a code by mail or phone, a Google account, mail and password) and the library that does it (the owner's defaults, else a maintained library of the stack) |
| Code-message provider | for codes and notices by text or chat message, or none |
| Mail provider | or none |
| Payment provider | or none |
| Storage | where files are kept (an S3-compatible store), or none |
| Deployment | where it runs (a server of its own, or serverless when the brief asks for it or you propose it with your reason) |
| Expected scale | the rows tier and the traffic tier with their numbers (SKILL.md, step 2, and below) |
| Data retention | how long each kind of data is kept, for example logs 90 days, orders for ever |
| AI crawlers | allowed (recommended) or blocked |
| AI assistant | none, or yes (then the assistant reference) |
| Monitoring | logs and a health check (default), or more |
| Mobile apps | none, or one per audience (then the mobile reference) |
| Package ids | the apps' or the package's ids |
| Code hosting | an account or organisation for private repositories, or local only |
| Scope | whole product (default), or set-up only |

1. Write `none` where the project does not have a thing: a default is the value only when the project has that thing
   (no payments, no payment provider).
2. A detail his defaults answer takes his answer; a detail with a default or a recommended value marked here takes
   it. Neither is a question.

## The size

3. Rows: every table of the data model gets its own tier: the rows it can hold three years after launch if the product
   does well (users x actions x days; show the sum). A table that only grows (events, messages, logs, transactions,
   audit) is counted over ten years, a table with a retention period at its fullest. The project's rows tier is the
   tier of its biggest table.
4. Traffic: the requests per second that reach the app server at peak. Pages a CDN serves do not count.
5. In doubt between two tiers, take the higher. A tier the owner names holds, and so does a size the brief states in
   words ("billions of rows", "a few hundred users"): use it for that table, show it, do not ask. A retention period
   you propose never brings a table below a size the brief states. Count and ask only for a tier the brief leaves open
   (often traffic): assume numbers that fit the kind and the country, show them, and put the tier among your questions
   with your recommended answer.

## The features

6. The features, each yes or no: a database; accounts; an admin area (yes when the project has accounts and web
   screens: it holds the settings of the services reference); tenants (one customer's data kept apart from
   another's; calling apps with their own API keys are tenants when each has data of its own, but a cache shared by
   all of them is not tenant data); payments or other money; uploads or stored files; mail or codes; search inside the
   product; background or scheduled work; an AI assistant; mobile apps; public pages (pages anyone opens without
   logging in, also an app's login, password-reset and error pages), and, as a separate yes or no, whether they should
   be found in search (yes, unless the product is internal or private); more than one language; personal data (names,
   phones, mail addresses, postal addresses, locations, ids), yes also when another system sends it and it is only
   passed on or cached. A feature that plainly follows from the brief is yes (a shop keeps its orders: a database). A
   feature the brief neither names nor plainly implies is no in the fit: if the use case needs it, it goes into point
   4 of the one message as yes or no with your recommendation, and counts only after his ok.

## The stack

7. The default stack is this one, unless the owner's defaults file names another (then his holds). Web: Next.js (App
   Router) with TypeScript strict, Node.js LTS and npm; Tailwind CSS with shadcn/ui; PostgreSQL through the `pg`
   driver and plain SQL (no ORM); Zod for every input; the sign-in library of the details; the mail provider's library
   or SMTP; the AWS S3 SDK v3 for an S3-compatible store; Vitest, Playwright with @axe-core/playwright, Lighthouse CI,
   ESLint, Prettier, knip and gitleaks; k6 for a load test. Mobile apps: Flutter through FVM with Riverpod and its
   code generation, calling only the web project's API. Any other choice than the default (also a pick where the brief
   names no technology) is a stack change: it goes into point 3 of the one message with its reason and waits for his
   ok. Another choice is right only in these cases (otherwise the default holds):
8. Nothing to store: no database. Nobody logs in: no sign-in library. A static website has neither.
9. API or backend only: the framework's route handlers alone; no CSS framework, component kit, page checks,
   accessibility checker or page scores.
10. No page that should be found (an internal tool, an app behind login): the stack stays, page scores too;
    the search reference is light and security stays in full.
11. Mobile-first product: the web project is the API, the admin area and the public pages the product needs: at least
    home, privacy, terms and account deletion, plus every page the brief needs found.
12. A library or a tool is installed only when something uses it: no storage client without stored files, no mail
    library without mail, no load-test tool without a load test.
13. The brief asks for something the default stack cannot build (the kinds marked "propose"), or names another
    technology: propose the stack and say which references still apply.
14. Every such change goes into the one message with its reason (after the set-up: into the line that reports a new
    fit). Never change the stack silently, and never because another choice is easier. Until his ok, the default
    holds. Going back to a default needs no ok.

## Two worked examples

Example 1. Brief: "A one-page website for a dental clinic, with a contact form." Kind: website. Size: rows 0, traffic
S (a few form posts a day). Audiences: visitors on the web. Features: public pages to be found, mail, personal data;
the rest no. database `not needed` (a message goes to the clinic by mail). performance `light` ("Pages" and "Targets"
in full; traffic S on one app process: no shared cache store, and no load test because the only server path is the
rate-limited form). security `full` (one public form with validation, a rate limit and a bot check; headers and CSP;
privacy and terms pages; no accounts, uploads or webhooks). ui `light` (no lists or records). search `full`. services
`light` (Env in its light form: the mail key and the form's two addresses are env names; Mail; no storage, payments or
jobs). mobile, assistant `not needed`. testing `full` (the page, the form's cases, page scores, accessibility; no
database or scale tests). docs `full`. Stack change: no database, no sign-in library, no storage client, no load-test
tool.

Example 2. Brief: "A marketplace where shops sell to customers, with online payments, a customer app and a shop app."
Kind: multi-tenant, mobile-first. Size (no numbers in the brief, so assumed and asked): rows XL (order events: 200,000
orders a day x 15 events x 3,650 days, about 11 billion), traffic L (200,000 orders x 50 requests a day, 8 times the
average at peak, about 900 per second). database `full` (order events XL and orders L, both partitioned by month;
users M and shops S not partitioned; scale seed, plan test, the ten-billion proof). performance `full` (a shared cache
store; the load test at 900 per second for 5 minutes). security, ui `full`. search `full` on the public pages, light
form behind login. services `full` (jobs on a worker with a queue store). mobile `full` (two apps). assistant `not
needed`. testing `full` with the nightly scale job and the mobile job. docs `full`. Stack change: none (its shop and
product pages must be found).
