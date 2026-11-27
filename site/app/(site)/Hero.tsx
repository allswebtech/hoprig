// The landing page's first screen: three facts, the headline, the second line, the install line with its copy
// button, and one picture of the dashboard. All of it is plain HTML from the build: readable before any script runs,
// and before the story's 3D code loads (that comes later, under it).
import type { ReactNode } from 'react';
import { InstallLines } from '../../design';
import { INSTALLS } from '../../lib/seo.mjs';
import type { Landing } from './content';
import { WORDS } from './words';

/** "…, and a computer is ready to code with AI.": the clause after the last " is " in the accent. */
function headline(title: string): ReactNode {
  const i = title.lastIndexOf(' is ');
  if (i === -1) return title;
  return <>{title.slice(0, i + 4)}<em>{title.slice(i + 4)}</em></>;
}

/** The content's own <code> marks, as elements (no raw HTML from a file goes into the page). */
function withCode(text: string): ReactNode[] {
  return text.split(/<code>(.*?)<\/code>/g).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

export function Hero({ page }: { page: Landing }) {
  return (
    <div className="hero">
      <div className="wrap hero-words">
        <ul className="pills" aria-label="In short">
          {WORDS.pills.map((p, i) => <li key={p} className="chip">{i === 0 ? <i className="dot" aria-hidden="true" /> : null}{p}</li>)}
        </ul>
        <h1 className="t-display">{headline(page.title)}</h1>
        <p className="t-lead hero-lead">{page.lead}</p>
        <p className="hero-paste">{WORDS.paste} <a href={WORDS.newHere.href}>{WORDS.newHere.text}</a></p>
        <InstallLines systems={INSTALLS} />
        <p className="hero-phone">{WORDS.phone}</p>
        <p className="hero-cost">{WORDS.cost}</p>
        <p className="hero-under">{withCode(page.under)}</p>
      </div>
      <figure className="stage">
        <div className="window">
          <div className="chrome" aria-hidden="true"><i /><i /><i /><b>{WORDS.heroWindow}</b></div>
          {/* The system's theme picks the picture with no script (one fetch); a theme chosen on the switch sets the
              source's media before the picture is chosen (the head's script, as the page is read), so a chosen dark
              never paints the light picture first. */}
          {/* On a phone, Home at phone width from its top (story-shots.mjs home-*-phone-top.webp): the desktop screen
              shrunk to 356 px left every word about 4 px tall. data-width keeps the width for a chosen theme. */}
          <picture>
            <source data-dark data-width="(max-width: 699px)" media="(max-width: 699px) and (prefers-color-scheme: dark)" srcSet="/story/home-dark-phone-top.webp" width={780} height={1040} />
            <source media="(max-width: 699px)" srcSet="/story/home-light-phone-top.webp" width={780} height={1040} />
            <source data-dark media="(prefers-color-scheme: dark)" srcSet="/story/home-dark-640.webp 640w, /story/home-dark.webp 1280w" sizes="(max-width: 1080px) 92vw, 1030px" width={1280} height={800} />
            <img className="shot" src="/story/home-light.webp" srcSet="/story/home-light-640.webp 640w, /story/home-light.webp 1280w" sizes="(max-width: 1080px) 92vw, 1030px" width={1280} height={800} alt={WORDS.heroAlt} fetchPriority="high" decoding="async" />
          </picture>
        </div>
      </figure>
      <div className="stage-fade" aria-hidden="true" />
    </div>
  );
}
