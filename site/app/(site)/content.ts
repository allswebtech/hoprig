// The landing page's words from site/content/index.md, read at build time (the content stays the one source).
import fs from 'node:fs';
import path from 'node:path';
import { frontMatter, plainText } from '../../lib/markdown.mjs';

export const ROOT = path.resolve(process.cwd(), '..');

export type Landing = { title: string; description: string; kicker: string; lead: string; under: string; heroAlt: string; body: string };

export function landing(): Landing {
  const { data, body } = frontMatter(fs.readFileSync(path.join(ROOT, 'site/content/index.md'), 'utf8')) as unknown as { data: Record<string, string>; body: string };
  for (const k of ['title', 'description', 'lead', 'under']) if (!data[k]) throw new Error(`site/content/index.md has no "${k}" in its front matter`);
  return { title: data.title, description: data.description, kicker: data.kicker || '', lead: data.lead, under: data.under, heroAlt: data.heroAlt || '', body };
}

export type UseCase = { url: string; title: string; who: string; short: string; coming: boolean; order: number };

/** The use cases (site/content/use-cases/*.md) in their order, for the landing page's cards. */
export function useCases(): UseCase[] {
  const dir = path.join(ROOT, 'site/content/use-cases');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'index.md').map((f) => {
    const { data, body } = frontMatter(fs.readFileSync(path.join(dir, f), 'utf8'));
    const h1 = /^#\s+(.*)$/m.exec(body);
    return { url: `/use-cases/${f.replace(/\.md$/, '')}/`, title: String(data.title || (h1 ? plainText(h1[1]) : f)), who: String(data.who || ''), short: String(data.short || ''), coming: data.coming === true, order: Number(data.order ?? 99) };
  }).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}
