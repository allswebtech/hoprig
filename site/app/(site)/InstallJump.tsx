'use client';
// The header's Install button and the install line's Copy button are one action: Install leads to the install line
// (/#install) and puts the focus on its Copy button, so Enter copies the line. It is never a second destination.
// The line is marked for a moment (install-flash, in the kit): on a wide screen it is already in view, so a click
// with a mouse changed nothing that could be seen (a focus set by a script after a click shows no ring).
import { useEffect } from 'react';

// The mark's timer: a second press within 1.2 s starts the mark again, so the first press's timer must not end it.
let flashTimer: ReturnType<typeof setTimeout> | undefined;

function focusCopy() {
  // The first line is the visitor's own system where the page knows it (data-first), else the first in the group.
  const box = document.getElementById('install');
  const first = box?.dataset.first;
  const b = box?.querySelector<HTMLButtonElement>(first ? `[data-system="${first}"] .copy` : '.copy');
  if (!b) return false;
  b.focus({ preventScroll: true });
  const line = document.getElementById('install');
  if (line) {
    line.classList.remove('install-flash');
    void line.offsetWidth; // a second press starts the mark again
    line.classList.add('install-flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => line.classList.remove('install-flash'), 1200);
  }
  return true;
}

export function InstallJump() {
  useEffect(() => {
    if (location.hash === '#install') focusCopy();
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[data-install-jump]');
      if (!a || !document.getElementById('install')) return; // another page: the link goes to the landing page
      e.preventDefault();
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      document.getElementById('install')!.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
      history.replaceState(null, '', '#install');
      focusCopy();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
  return null;
}
