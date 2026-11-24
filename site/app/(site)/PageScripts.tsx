'use client';
// What the old site's script did for every page, now in the frame: a copy button on each shell block the content
// layer marked as one command or a sequence to run as it stands (data-copyable), the static install lines of the
// content (data-copy), and the phone menu that closes when a link is followed, on Escape and on a tap outside it.
// Every page reads and works without it.
import { useEffect } from 'react';

async function copy(text: string, button: HTMLButtonElement, from: Element) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // An old browser or a page not on https: select the text, so a long press or Ctrl+C copies it.
    const range = document.createRange();
    range.selectNodeContents(from);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    return;
  }
  const was = button.textContent;
  button.textContent = 'Copied';
  button.classList.add('done');
  setTimeout(() => { button.textContent = was; button.classList.remove('done'); }, 1600);
}

// The comments after # stay out of what is copied.
const runnable = (text: string) => text.split('\n').map((l) => l.replace(/(^|\s+)#(\s.*)?$/, '')).filter((l) => l.trim()).join('\n');

export function PageScripts() {
  useEffect(() => {
    const off: (() => void)[] = [];
    const on = (el: EventTarget, type: string, fn: EventListener) => { el.addEventListener(type, fn); off.push(() => el.removeEventListener(type, fn)); };
    for (const pre of document.querySelectorAll<HTMLPreElement>('[data-content] pre[data-copyable]')) {
      if (pre.parentElement?.classList.contains('pre-wrap')) continue;
      const code = pre.querySelector('code') || pre;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-primary btn-small copy pre-copy'; // the kit's Copy, as on the install line
      b.textContent = 'Copy';
      on(b, 'click', () => copy(runnable(code.textContent || ''), b, code));
      // The button sits on a wrapper, not in the block: in the block it scrolled away with the code and left the
      // code showing at the block's edge.
      const wrap = document.createElement('div');
      wrap.className = 'pre-wrap';
      pre.classList.add('has-copy');
      pre.replaceWith(wrap);
      wrap.append(pre, b);
      off.push(() => { wrap.replaceWith(pre); pre.classList.remove('has-copy'); });
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-content] button[data-copy]')) {
      on(b, 'click', () => copy(b.dataset.copy || '', b, b.parentElement?.querySelector('code') || b));
    }
    const menu = document.querySelector<HTMLDetailsElement>('details.menu');
    if (menu) {
      const close = (refocus: boolean) => {
        if (!menu.open) return;
        menu.open = false;
        if (refocus) menu.querySelector('summary')?.focus();
      };
      on(menu, 'click', (e) => { if ((e.target as Element).closest('a')) close(false); });
      on(document, 'keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') close(true); });
      on(document, 'pointerdown', (e) => { if (!menu.contains(e.target as Node)) close(menu.contains(document.activeElement)); });
    }
    return () => off.forEach((f) => f());
  }, []);
  return null;
}
