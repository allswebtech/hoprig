// The top bar of every public page: the name, the menu, the theme switch, the code on GitHub, and Install.
// On a phone the menu folds into a <details> (works with no script).
import { ButtonLink, Icon, Logo, ThemeSwitch } from '../../design';
import { NAV, REPO } from './nav';

export function Header({ current = '' }: { current?: string }) {
  const links = NAV.map(([href, label]) => <a key={href} href={href} aria-current={current.startsWith(href) ? 'page' : undefined}>{label}</a>);
  return (
    <header className="bar">
      <div className="wrap bar-row">
        <a className="brand" href="/" aria-label="Hoprig, home"><Logo /><span>Hoprig</span></a>
        <nav className="nav" aria-label="Main">{links}</nav>
        <div className="bar-tools">
          <ThemeSwitch sun={<Icon name="sun" />} moon={<Icon name="moon" />} />
          <a className="icon-btn" href={REPO} aria-label="The code on GitHub"><Icon name="git" /></a>
          <details className="menu">
            <summary className="icon-btn" aria-label="Menu"><Icon name="menu" /></summary>
            <nav className="menu-panel" aria-label="Menu">{links}<a href={REPO}>The code on GitHub</a></nav>
          </details>
          <ButtonLink look="primary" small href="/#install" data-install-jump className="bar-install">Install</ButtonLink>
        </div>
      </div>
    </header>
  );
}
