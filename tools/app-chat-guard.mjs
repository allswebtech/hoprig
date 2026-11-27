// Dev-only (not in the published package): the layout guard of tools/app-chat-drive.mjs. The page side (COLLECT) writes
// down where each part of the chat lies; judge() decides, from those boxes alone, what is wrong. judge() is a plain
// function so that test/tools/app-chat-guard.test.mjs can feed it made-up boxes.
//
// A box: { part, x, y, w, h (the rectangle), cx, cw (the same, cut to what clipping containers show; default x, w), up: [indices of the boxes that contain this one in the page],
//          scroller (it scrolls sideways on purpose: a code block), overlay (a menu, a toast: floats over the page),
//          cutX, cutY (its text is cut: wider or higher than the box), ellipsis, way (a title, or a Show all button, gives the whole text),
//          sideways (it is a box that scrolls sideways on its own: its content is wider than it),
//          icon: { x, y, w, h, empty } | null (the picture inside a button) }
// The window: { w, h, scrollW } (scrollW: the page's own scroll width).
// A fault: { part, kind, px, other? }; line() writes it as one line with the state and the width.

const TOL = 0.75; // a rounding of the browser, in pixels
const MARGIN = 2; // a picture lies in its button with at least this much around it
const r1 = (n) => Math.round(n * 10) / 10;

export function judge(boxes, win) {
  const faults = [];
  const at = (b) => `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}`;
  const add = (b, kind, px, other) => faults.push({ part: b.part, kind, px: r1(px), at: other ? `${at(b)} / ${at(other)}` : at(b), ...(other ? { other: other.part } : {}) });
  if (win.scrollW > win.w + 1) add({ part: 'the page' }, 'scrolls sideways', win.scrollW - win.w);
  if (win.bodyScrollW > win.w + 1) add({ part: 'the page body' }, 'scrolls sideways', win.bodyScrollW - win.w);
  // A phone makes the page larger when a field with a text size under 16 px gets the focus (and moves the page).
  if (win.touch) for (const f of win.fields || []) if (f.fs < 16) add({ part: f.part }, 'text size under 16 px on a touch screen', 16 - f.fs);
  const right = (b) => b.x + b.w;
  const bottom = (b) => b.y + b.h;
  boxes.forEach((b, i) => {
    if (b.w < 1 || b.h < 1) return; // not drawn
    // What a clipping container hides is not outside the window or the column: it is cut off (said once, below).
    const cx = b.cx === undefined ? b.x : b.cx;
    const cr = b.cx === undefined ? right(b) : b.cx + b.cw;
    if (!b.overlay) {
      if (cx < -TOL) add(b, 'outside the window (left)', -cx);
      if (cr > win.w + TOL) add(b, 'outside the window (right)', cr - win.w);
    }
    // Inside its column: inside the nearest part that contains it, unless that one scrolls on purpose.
    const p = !b.overlay && b.up.length ? boxes[b.up[0]] : null;
    if (p && !p.scroller && p.w >= 1) {
      if (cx < p.x - TOL) add(b, `outside its ${p.part} (left)`, p.x - cx);
      if (cr > right(p) + TOL) add(b, `outside its ${p.part} (right)`, cr - right(p));
    }
    const cw = b.cw === undefined ? b.w : b.cw;
    if (b.w - cw > 1 && !b.scroller && !b.inRow) add(b, 'cut off by its container', b.w - cw);
    if (b.sideways && !b.scroller) add(b, 'scrolls sideways inside', b.sideways);
    if ((b.cutX || b.cutY) && !b.ellipsis && !b.way) add(b, 'text cut with no ellipsis and no way to read it', b.cutX || b.cutY);
    if (b.icon) {
      const c = b.icon;
      if (c.empty || c.w < 4 || c.h < 4) add(b, 'its picture is empty', 1);
      else {
        const m = Math.min(c.x - b.x, c.y - b.y, right(b) - (c.x + c.w), bottom(b) - (c.y + c.h));
        if (m < MARGIN - TOL) add(b, 'its picture has no margin in the button', MARGIN - m);
      }
    }
    // Two parts that are neither parent and child nor floating menus never lie over each other.
    if (b.overlay) return;
    for (let j = i + 1; j < boxes.length; j++) {
      const o = boxes[j];
      if (o.overlay || o.w < 1 || o.h < 1 || b.up.includes(j) || o.up.includes(i)) continue;
      const sx = (q) => (q.cx === undefined ? q.x : q.cx);
      const ex = (q) => (q.cx === undefined ? right(q) : q.cx + q.cw);
      const ox = Math.min(ex(b), ex(o)) - Math.max(sx(b), sx(o));
      const oy = Math.min(bottom(b), bottom(o)) - Math.max(b.y, o.y);
      if (ox > 1 && oy > 1) add(b, 'overlaps', Math.min(ox, oy), o);
    }
  });
  // The same fault found twice (a part listed by two names) is one line.
  const seen = new Set();
  return faults.filter((f) => {
    const k = `${f.part}|${f.kind}|${f.other || ''}|${f.px}`;
    return !seen.has(k) && seen.add(k);
  });
}

/** One line: state, width, the part, by how many pixels. */
export const line = (state, width, f) => `FAULT ${state} | ${width} | ${f.part}${f.other ? ` and ${f.other}` : ''} | ${f.kind} | by ${f.px}px${f.at ? ` | at ${f.at}` : ''}`;

// What is looked at: [name, selector]. A part that is not on the page in this state is not looked at.
export const PARTS = [
  ['the title bar', '.chat-bar'], ['a title bar button', '.chat-bar button, .chat-bar a'], ['the title', '.chat-title'], ['the title bar line under the title', '.chat-sub'],
  ['the list of sessions', '.chat-side'], ['a session row', '.chat-side-item'], ['a session name', '.chat-side-name'],
  ['the conversation column', '.chat-main'], ['the message list', '.chat-list'], ['a message', '.chat-item'], ['a card', '.chat-tool, .chat-ask, .chat-todos, .chat-cmd'],
  ['a code block', '.chat-code, .chat-out, .chat-cmd, pre'], ['a table', '.md-tablewrap, .chat-item table:not(.md-tablewrap table)'],
  ['the Background tasks part', '.chat-bg'], ['the Background tasks head', '.chat-bg-head'], ['a Background tasks row', '.chat-bg-row'], ['a task title', '.chat-bg-title'],
  ['a queued bubble', '.chat-queued'], ['the queued bubble text', '.chat-queued-bubble'], ['the queued message', '.chat-queued-text'],
  ['the input box', '.chat-composer'], ['the text field', 'textarea.chat-input'], ['an input button', '.chat-composer button, .chat-composer .btn'],
  ['the row of chips', '.chat-chips'], ['a chip', '.chat-chip'], ['the line under the box', '.chat-status'],
  ['the panel at the right', '.chat-rail'], ['a card of the panel', '.chat-rcard'], ['a row of the panel', '.chat-rail-rows dt, .chat-rail-link'],
];
// Boxes that scroll sideways on purpose.
const SCROLLERS = 'pre, .md-tablewrap, .chat-code, .chat-out, .chat-cmd, .chat-chips';
// Floating: menus, toasts, sheets.
const OVERLAYS = '.chat-menu, .toast, .sheet, .chat-pop, [role=dialog], [role=menu]';

/** Run in the page: → { win: { w, h, scrollW }, boxes } (JSON). */
export const COLLECT = `(() => {
  const PARTS = ${JSON.stringify(PARTS)}, SCROLLERS = ${JSON.stringify(SCROLLERS)}, OVERLAYS = ${JSON.stringify(OVERLAYS)};
  const list = [];
  const index = new Map();
  for (const [part, sel] of PARTS) {
    for (const el of document.querySelectorAll(sel)) {
      if (index.has(el)) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if ((el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) || cs.visibility === 'hidden' || cs.display === 'none' || (r.width < 1 && r.height < 1) || el.closest('.hidden, [hidden], .chat-sr') || el.classList.contains('chat-sr')) continue;
      index.set(el, list.length);
      list.push({ el, part, r, cs });
    }
  }
  const boxes = list.map(({ el, part, r, cs }) => {
    const up = [];
    for (let a = el.parentElement; a; a = a.parentElement) if (index.has(a)) up.push(index.get(a));
    const ox = cs.overflowX;
    const clipsX = ox === 'hidden' || ox === 'clip';
    const clipsY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
    const text = (el.innerText || '').trim().length > 0;
    const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none';
    const way = !!(el.title || (el.parentElement && el.parentElement.querySelector(':scope > button[aria-expanded]')));
    let icon = null;
    const svg = el.matches('button, a, .btn') ? el.querySelector('svg') : null;
    if (svg && svg.getBoundingClientRect().width > 0) { // a picture that is not shown (a hidden chevron) is not judged
      const s = svg.getBoundingClientRect();
      const drawn = [...svg.querySelectorAll('path, circle, rect, line, polyline, polygon, ellipse')];
      icon = { x: s.x, y: s.y, w: s.width, h: s.height, empty: !drawn.length };
    }
    // What lies above or below a scrolling area's window is not on the screen: its up-and-down is cut to the window.
    let top = r.top, bot = r.bottom, left = r.left, right = r.right;
    for (let a = el.parentElement; a; a = a.parentElement) {
      const c = getComputedStyle(a);
      const q = a.getBoundingClientRect();
      if (c.overflowY !== 'visible') {
        top = Math.max(top, q.top);
        bot = Math.min(bot, q.bottom);
      }
      if (c.overflowX === 'hidden' || c.overflowX === 'clip' || a.matches('.chat-chips')) { // what a clipping container hides is not drawn (and is cut)
        left = Math.max(left, q.left);
        right = Math.min(right, q.right);
      }
    }
    const name = el.matches('button, a') ? (el.getAttribute('aria-label') || el.title || el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30) : '';
    return {
      part: name ? part + ' "' + name + '"' : part, x: r.x, y: top, w: r.width, h: Math.max(0, bot - top), cx: left, cw: Math.max(0, right - left), up,
      scroller: el.matches(SCROLLERS) && (ox === 'auto' || ox === 'scroll'), // a code block or table that really scrolls; one that only clips is a fault overlay: !!el.closest(OVERLAYS) || cs.position === 'fixed',
      inRow: !!(el.parentElement && el.parentElement.matches('.chat-chips')), // a chip in the row that scrolls: reached by scrolling
      cutX: text && clipsX && el.scrollWidth > el.clientWidth + 1 ? el.scrollWidth - el.clientWidth : 0,
      cutY: text && (clipsY || clamp) && el.scrollHeight > el.clientHeight + 1 ? el.scrollHeight - el.clientHeight : 0,
      ellipsis: cs.textOverflow === 'ellipsis' || !!clamp, way,
      sideways: (ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 1 ? el.scrollWidth - el.clientWidth : 0, icon,
    };
  });
  const touch = matchMedia('(pointer: coarse)').matches;
  const fields = touch && document.body.classList.contains('chat-mode') ? [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]):not([type=hidden]), textarea, select')]
    .filter((e) => e.getClientRects().length).map((e) => ({ part: 'a field (' + (e.className || e.tagName).toString().split(' ')[0] + ')', fs: parseFloat(getComputedStyle(e).fontSize) })) : [];
  return { win: { w: window.innerWidth, h: window.innerHeight, scrollW: document.documentElement.scrollWidth, bodyScrollW: document.body.scrollWidth, touch, fields }, boxes };
})()`;
