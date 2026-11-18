// The site's only script: the light/dark switch and the copy buttons. The page works without it.
(() => {
  const root = document.documentElement;
  const dark = () => root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const btn = document.querySelector('.theme-btn');
  if (btn) {
    const show = () => btn.setAttribute('aria-pressed', String(dark()));
    show();
    btn.addEventListener('click', () => {
      const next = dark() ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch { /* private window: the choice lasts for this page */ }
      show();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', show);
  }

  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // An old browser or a page not served over https: select the text so a long press or Ctrl+C copies it.
      const range = document.createRange();
      range.selectNodeContents(button.parentElement.querySelector('code') || button.parentElement);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return;
    }
    const was = button.textContent;
    button.textContent = 'Copied';
    button.classList.add('done');
    setTimeout(() => { button.textContent = was; button.classList.remove('done'); }, 1600);
  }

  for (const b of document.querySelectorAll('[data-copy]')) b.addEventListener('click', () => copy(b.dataset.copy, b));
  // A shell block the build marked as one command, or a sequence to run as it stands (no placeholder, not a list of
  // alternatives), gets its own button; the comments after # stay out of what is copied.
  for (const pre of document.querySelectorAll('pre[data-copyable]')) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'copy pre-copy';
    b.textContent = 'Copy';
    b.addEventListener('click', () => copy(pre.querySelector('code').textContent.split('\n').map((l) => l.replace(/(^|\s+)#(\s.*)?$/, '')).filter((l) => l.trim()).join('\n'), b));
    pre.classList.add('has-copy');
    pre.append(b);
  }
  // The phone menu closes when one of its links is followed (also to an anchor on this page), on Escape and on a tap
  // outside it; the focus goes back to its button when it was inside the menu.
  const menu = document.querySelector('details.menu');
  if (menu) {
    const close = (refocus) => {
      if (!menu.open) return;
      menu.open = false;
      if (refocus) menu.querySelector('summary').focus();
    };
    menu.addEventListener('click', (e) => { if (e.target.closest('a')) close(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(true); });
    document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target)) close(menu.contains(document.activeElement)); });
  }
})();
