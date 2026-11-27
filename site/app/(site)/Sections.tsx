// The rest of the landing page, from site/content/index.md as it stands: each "## " part is a band of its own (what
// Hoprig does, who it is for, how it works, the comparison, questions and answers, start now), rendered by the
// site's own Markdown code (lib/markdown.mjs, whose raw-HTML rules hold here too). Its parts `<!-- install -->` and
// `<!-- usecases -->` become the install line and the use-case cards.
import type { ReactNode } from 'react';
import { InstallLines } from '../../design';
import { renderMarkdown } from '../../lib/markdown.mjs';
import { INSTALLS } from '../../lib/seo.mjs';
import { linkItems } from '../../lib/pages.mjs';
import { useCases } from './content';

type Band = { id: string; title: string; md: string };

/** The body's "## " parts, in order (what comes before the first is the first screen's, above). */
export function bands(body: string): Band[] {
  return body.split(/^(?=## )/m).slice(1).map((part) => {
    const title = /^## (.*)$/m.exec(part)![1].trim();
    const { headings } = renderMarkdown(`## ${title}`);
    return { id: headings[0]?.id || title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title, md: part.replace(/^## .*\n/, '') };
  });
}

function UseCaseCards() {
  return (
    <ul className="cards cards-3 usecases">
      {useCases().map((u) => (
        <li key={u.url}>
          <a className="card" href={u.url}>
            <p className="who">{u.who}{u.coming ? <span className="badge">Coming</span> : null}</p>
            <h3>{u.title}</h3>
            <p>{u.short}</p>
          </a>
        </li>
      ))}
    </ul>
  );
}

function Html({ html }: { html: string }) {
  return html.trim() ? <div className="prose" dangerouslySetInnerHTML={{ __html: linkItems(html) }} /> : null;
}

function bandBody(md: string, n: number): ReactNode[] {
  const marked = md.replace(/^<!--[ \t]*(install|usecases)[ \t]*-->[ \t]*$/gm, (_, name) => `@@${name}@@`);
  const { html: raw } = renderMarkdown(marked, { copy: 'site' });
  // The renderer gives a question and its answer as siblings: each pair becomes one card.
  const html = raw.replace(/<div class="faq">([\s\S]*?)<\/div>/, (_, inner: string) => `<div class="faq">${inner.split(/(?=<h3\b)/).filter((q) => q.trim()).map((q) => `<div class="faq-item">${q}</div>`).join('')}</div>`);
  return html.split(/<p>@@(install|usecases)@@<\/p>/).map((part, i) => {
    if (i % 2 === 0) return <Html key={i} html={part} />;
    return part === 'install' ? <InstallLines key={i} systems={INSTALLS} id={`install-${n}`} /> : <UseCaseCards key={i} />;
  });
}

export function Sections({ body, after }: { body: string; after: Record<string, ReactNode> }) {
  return (
    <>
      {bands(body).map((b, n) => (
        <div key={b.id}>
          <section className={`band band-${b.id}`} aria-labelledby={b.id}>
            <div className="wrap">
              <h2 id={b.id} className="t-h2 band-title">{b.title}</h2>
              {bandBody(b.md, n)}
            </div>
          </section>
          {after[b.id] ?? null}
        </div>
      ))}
    </>
  );
}
