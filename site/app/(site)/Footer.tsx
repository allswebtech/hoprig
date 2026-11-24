// The foot of every public page: what Hoprig is in one line, the pages, the files for AI tools, and the plain notes.
import { Logo } from '../../design';
import { NAV, REPO } from './nav';

export function Footer({ mdUrl, edit }: { mdUrl?: string; edit?: React.ReactNode }) {
  return (
    <footer className="foot">
      <div className="wrap foot-grid">
        <div className="foot-about">
          <a className="brand" href="/"><Logo /><span>Hoprig</span></a>
          <p>Free and open source (<a href={`${REPO}/blob/main/LICENSE`}>Apache-2.0</a>). Runs on your own computer. The code is on <a href={REPO}>GitHub</a>.</p>
        </div>
        <nav aria-label="Pages">
          <p className="foot-head">Pages</p>
          {NAV.filter(([h]) => h !== '/tools/').map(([href, label]) => <a key={href} href={href}>{label}</a>)}
          <a href="/docs/install/">Install</a>
        </nav>
        <nav aria-label="For AI tools">
          <p className="foot-head">For AI tools</p>
          <a href="/tools/">Tools for agents</a>
          <a href="/skill/">The Hoprig skill</a>
          <a href="/llms.txt">llms.txt</a>
          {mdUrl ? <a href={mdUrl}>This page as Markdown</a> : null}
        </nav>
      </div>
      <div className="wrap foot-note">
        {edit ? <p className="foot-edit">{edit}</p> : null}
        <p>Not affiliated with Anthropic or with OpenCode&apos;s makers. &quot;Claude&quot; and &quot;Claude Code&quot; are Anthropic&apos;s. This site sets no cookie and has no tracking.</p>
      </div>
    </footer>
  );
}
