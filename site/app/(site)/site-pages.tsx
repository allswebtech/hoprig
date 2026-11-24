// Every page of the site from the content layer (lib/pages.mjs), loaded once per build, and what each page's head
// carries: its title, description, canonical address, Markdown twin, Open Graph tags and schema.org data.
import fs from 'node:fs';
import path from 'node:path';
import type { Metadata } from 'next';
import { linkItems, loadPages, pageTitle, sizeImages, sourceOf } from '../../lib/pages.mjs';
import type { Page } from '../../lib/pages.mjs';
import { jsonLd } from '../../lib/seo.mjs';
import { frontMatter } from '../../lib/markdown.mjs';
import { SITE } from '../../lib/sources.mjs';

export type { Page };
export const ROOT = path.resolve(process.cwd(), '..');
const VERSION: string = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

let pages: Promise<Page[]> | null = null;
export const allPages = () => (pages ??= loadPages(ROOT));

export async function pageAt(url: string): Promise<Page> {
  const p = (await allPages()).find((x) => x.url === url);
  if (!p) throw new Error(`the content layer has no page ${url}`);
  return p;
}

/** The slugs under a folder (/docs/<slug>/), for generateStaticParams. */
export async function slugsUnder(folder: string, kind: string) {
  return (await allPages()).filter((p) => p.kind === kind && p.url.startsWith(`/${folder}/`)).map((p) => ({ slug: p.url.split('/')[2] }));
}

/** A page's HTML with its pictures sized from their files (docs/screenshots, assets, site/story). */
export const sized = (html: string, eager = false) => linkItems(sizeImages(html, (src) => sourceOf(ROOT, src), { eager }));

const MISSING = '/404.html';
// The link picture (scripts/link-picture.mjs) says the landing page's headline; its alt text says the same.
const LANDING_TITLE = String(frontMatter(fs.readFileSync(path.join(ROOT, 'site/content/index.md'), 'utf8')).data.title);

export function metaOf(page: Page): Metadata {
  const missing = page.url === MISSING;
  const url = `${SITE}${page.url}`;
  return {
    title: { absolute: pageTitle(page) },
    description: page.description,
    // The 404 page is served at every missing address: not indexed and with no canonical address (Next marks it noindex).
    alternates: { ...(missing ? {} : { canonical: url }), types: { 'text/markdown': [{ url: page.mdUrl, title: 'This page as Markdown' }] } },
    openGraph: {
      type: 'website',
      siteName: 'Hoprig',
      title: page.title,
      description: page.description,
      ...(missing ? {} : { url }),
      images: [{ url: `${SITE}/social-preview.png`, width: 1200, height: 630, type: 'image/png', alt: `Hoprig: ${LANDING_TITLE}` }],
    },
    twitter: { card: 'summary_large_image' },
  };
}

/** schema.org data for the page (not on the 404 page). A data block: the browser does not run it. */
export function JsonLd({ page }: { page: Page }) {
  if (page.url === MISSING) return null;
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(page, { version: VERSION }) }} />;
}
