// The pages made from content (use cases, docs, comparisons, the skill, the tools, the changelog, the 404 page), in
// the frame: the text exactly as the content layer rendered it (lib/markdown.mjs, whose raw-HTML rules hold), with
// what each kind of page adds around it, as the old generator did.
import { Fragment } from 'react';
import { InstallLine } from '../../design';
import { SIDE_LABELS, docGroups, useCasesOf } from '../../lib/pages.mjs';
import { INSTALL, PLATFORMS } from '../../lib/seo.mjs';
import { Frame } from './Frame';
import { JsonLd, allPages, sized } from './site-pages';
import type { Page } from './site-pages';

const here = (a: string, b: string) => (a === b ? ('page' as const) : undefined);

function Prose({ html, wide }: { html: string; wide?: boolean }) {
  return <article className={`prose${wide ? ' prose-wide' : ''}`} data-content dangerouslySetInnerHTML={{ __html: sized(html) }} />;
}

/** The docs menu, twice: a list beside the text on a wide screen, a closed "All docs" on a phone. */
function DocsSide({ pages, current }: { pages: Page[]; current: string }) {
  const links = (
    <>
      <a href="/docs/" aria-current={here(current, '/docs/')}>Overview</a>
      {docGroups(pages).map(([g, list]) => (
        <Fragment key={g}>
          <span className="group">{g}</span>
          {list.map((p) => <a key={p.url} href={p.url} aria-current={here(current, p.url)}>{SIDE_LABELS[p.url.split('/')[2]] || p.title}</a>)}
        </Fragment>
      ))}
    </>
  );
  return (
    <aside className="side">
      <nav className="side-wide" aria-label="Docs">{links}</nav>
      <details className="side-narrow"><summary>All docs</summary><nav aria-label="Docs">{links}</nav></details>
    </aside>
  );
}

function UseCase({ page, pages }: { page: Page; pages: Page[] }) {
  const list = useCasesOf(pages);
  const i = list.findIndex((p) => p.url === page.url);
  const [prev, next] = [list[i - 1], list[i + 1]];
  // The first paragraph after the question is the direct answer.
  const body = page.body.replace(/(<\/h1>\n)<p>/, '$1<p class="answer">');
  return (
    <div className="wrap page page-read">
      <p className="crumbs"><a href="/use-cases/">Use cases</a></p>
      {page.data.coming ? <p><span className="badge badge-coming">Coming: not built yet</span></p> : null}
      <Prose html={body} />
      {page.data.coming ? null : (
        <section className="page-cta" aria-labelledby="try-it">
          <h2 id="try-it">Try it</h2>
          <InstallLine command={INSTALL} />
          <p className="cta-note">{PLATFORMS} After the install, <code>hoprig demo</code> opens the dashboard with sample data.</p>
        </section>
      )}
      <nav className="pager" aria-label="Other use cases">
        {prev ? <a href={prev.url}><span>Previous</span>{prev.title}</a> : <span />}
        {next ? <a className="next" href={next.url}><span>Next</span>{next.title}</a> : null}
      </nav>
    </div>
  );
}

export async function ContentPage({ page }: { page: Page }) {
  const pages = await allPages();
  let inner;
  if (page.kind === 'doc' || page.url === '/docs/') {
    inner = (
      <div className="wrap page">
        <div className="docs-layout">
          <DocsSide pages={pages} current={page.url} />
          <div>
            {page.url === '/docs/' ? null : <p className="crumbs"><a href="/docs/">Docs</a></p>}
            <Prose html={page.body} />
          </div>
        </div>
      </div>
    );
  } else if (page.kind === 'usecase') {
    inner = <UseCase page={page} pages={pages} />;
  } else {
    inner = (
      <div className="wrap page page-read">
        {page.kind === 'compare' ? <p className="crumbs"><a href="/compare/">Compare</a></p> : null}
        <Prose html={page.body} wide={page.kind === 'tools' || page.kind === 'list'} />
      </div>
    );
  }
  return (
    <Frame page={page} className={`kind-${page.kind}`}>
      {inner}
      <JsonLd page={page} />
    </Frame>
  );
}
