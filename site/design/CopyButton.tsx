'use client';
// Copies exactly the text it is given. Without a clipboard (an old browser, a page not on https) it selects the text
// beside it, so a long press or Ctrl+C copies it. The result is said to a screen reader too.
import { useRef, useState } from 'react';

export function CopyButton({ text, label = 'Copy', target }: { text: string; label?: string; target?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  async function copy(e: React.MouseEvent<HTMLButtonElement>) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = target ? document.getElementById(target) : e.currentTarget.parentElement?.querySelector('code');
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      }
      return;
    }
    setDone(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1600);
  }
  return (
    <button type="button" className="btn btn-primary btn-small copy" data-copy={text} onClick={copy} aria-describedby={target}>
      {done ? 'Copied' : label}
      <span className="sr-only" aria-live="polite">{done ? 'The line is copied' : ''}</span>
    </button>
  );
}
