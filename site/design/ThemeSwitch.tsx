'use client';
// The light/dark switch. The page's colours never wait for it: THEME_SCRIPT (in the document's head) sets data-theme
// from the saved choice before the first paint, and which icon shows is CSS. This only flips the choice and tells a
// screen reader the state.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

const dark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};

/** A <picture>'s dark source (data-dark) follows a chosen theme: always, never, or the system's preference (at its own width, data-width). */
function pictures() {
  const t = document.documentElement.dataset.theme;
  const base = t === 'dark' ? 'all' : t === 'light' ? 'not all' : '(prefers-color-scheme: dark)';
  for (const s of document.querySelectorAll<HTMLSourceElement>('source[data-dark]')) {
    // A dark source for one width only (data-width) keeps its width.
    const w = s.dataset.width;
    const media = !w || base === 'not all' ? base : base === 'all' ? w : `${w} and ${base}`;
    if (s.media !== media) s.media = media;
  }
}

export function ThemeSwitch({ sun, moon }: { sun: ReactNode; moon: ReactNode }) {
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    setPressed(dark());
    pictures();
    const m = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setPressed(dark());
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  function flip() {
    const next = dark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* a private window: the choice lasts for this page */ }
    setPressed(next === 'dark');
    pictures();
    window.dispatchEvent(new Event('themechange'));
  }
  return (
    <button type="button" className="icon-btn theme-switch" aria-label="Dark theme" aria-pressed={pressed} onClick={flip}>
      <span className="sun">{sun}</span>
      <span className="moon">{moon}</span>
    </button>
  );
}
