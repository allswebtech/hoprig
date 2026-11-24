# Search engines and AI search (SEO, AEO, GEO, LLMO)

- Applies when the project has public pages that should be found in search: `full` on those pages. Then search is
  part of the first build, not a later task. It is never `not needed` while the project has pages or an API (an API
  takes the light form); only a project with neither (a command-line tool, a library) is `not needed`. The light form
  on the pages behind login does not make the reference `light`.
- Light form: for every page that should not be found (an internal tool, the pages behind login, an API), also inside
  a mix. Such a page sends `noindex` (an API sends `X-Robots-Tag: noindex`), `robots.txt` disallows it (everything,
  when no page should be found), and a page still has a unique title (an API has none). Nothing else of this
  reference is built for it: no sitemap entry, structured data, `llms.txt` or search-console steps. Lighthouse SEO is
  not scored on a `noindex` page.

## Technical SEO (every public page)

1. A unique title (up to 60 characters) and description (up to 160), a canonical address, Open Graph and Twitter
   tags with a generated image.
2. One `h1`, logical `h2` and `h3`, semantic HTML, descriptive link text, breadcrumbs.
3. Clean lower-case addresses, correct status codes (404, 410, 301), no duplicate content.
4. `sitemap.xml` (a sitemap index past 50,000 addresses), `robots.txt` blocking private, app and API paths, a favicon
   and web manifest, `hreflang` once there are more languages.
5. Canonical and sitemap addresses use the production domain from the public site address in the environment.
   Staging and preview sites send `noindex` and have no sitemap.

## Structured data (JSON-LD that matches visible content)

6. Organization (logo, contact, `sameAs`), WebSite and BreadcrumbList.
7. Page types only where real: Product, Service, LocalBusiness, Article, FAQPage (only for real, visible questions).

## AEO (answer engines, featured snippets, voice)

8. Pages answer real users' questions. Question-style headings with a direct answer of 40 to 60 words right below,
   details after.
9. Steps as numbered lists, comparisons as tables, short FAQ sections where useful.

## GEO and LLMO (AI assistants and AI overviews)

10. All important content is in the server-rendered HTML. Many AI crawlers run no JavaScript.
11. Clear, consistent facts about the business everywhere (site, schema, `llms.txt`, business profiles): who we are,
    what we offer, where, how to reach us.
12. Trust signals: an about page, real team or author information, contact, policies, a visible "last updated" date
    (also `dateModified` in the schema).
13. Specific facts and numbers with sources. Unique content on every page, no filler.
14. `robots.txt` follows the "AI crawlers" detail (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended
    and others; check the current names).
15. `llms.txt` (a summary plus the key pages with a line each) and `llms-full.txt` (the full public content in
    Markdown), generated from the same source as the pages so that they never go stale.

## Rules and proof

16. Never invent reviews, ratings, prices, awards or business facts.
17. Tests check every public page for a title, description, canonical, one `h1`, Open Graph tags and valid JSON-LD.
    Lighthouse SEO is 100.
18. The deployment docs cover setting up the search engines' webmaster consoles (Google Search Console, Bing
    Webmaster Tools) and submitting the sitemap.
