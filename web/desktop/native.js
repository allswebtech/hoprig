// What the native apps of the desktop share (files.js, tasks.js, services.js, logs.js): the body of their window, a
// poll that runs only while the app can be seen, a sortable table, small controls and the words for numbers. A native
// app is a module with mount(root, { machine, query, open, place }) → stop(): it draws into `root` and calls the API
// of computer `machine` (null: this one) through at(), so the same app works for another computer through the relay.
// `query` is its address's query (where it starts), `open(app, hash)` opens another app (a window on the desktop, a
// page outside it; `hash` without the computer), `place(query, title)` keeps where it is now (the window's layout and
// title, or the page's address).
import { icon } from '../icons.js';
import { ApiError, fill, h } from '../lib.js';
import { queryOf } from './apps.js';

/**
 * The body of a native app's window: { el, reload(), stop() }. The module is loaded when the window is built; a
 * reload mounts it again from nothing.
 */
export function nativeBody(app, { machine, hash = () => '', open = () => {}, place = () => {} }) {
  const el = h('div.dapp', { dataset: { app: app.id } });
  let stop = () => {};
  let gen = 0;
  const start = () => {
    const mine = ++gen;
    fill(el, h('p.dapp-note', 'Opening…'));
    import(`./${app.module}`).then((m) => {
      if (mine !== gen) return;
      fill(el);
      stop = m.mount(el, { machine, query: queryOf(hash()), open, place }) || (() => {});
    }).catch((e) => fill(el, h('div.dapp-error', icon('alert', { size: 18 }), h('span', `This app did not open: ${e.message}`))));
  };
  start();
  const end = () => {
    gen++;
    try {
      stop();
    } catch {
      /* the app is gone either way */
    }
    stop = () => {};
  };
  return { el, reload: () => (end(), start()), stop: end };
}

/** Can `root` be seen: on the page, not in a minimised window, the browser tab in front. */
export const seen = (root) => root.isConnected && root.offsetParent !== null && document.visibilityState === 'visible';

/**
 * Run `fn` now and then every `ms` while `root` can be seen (a minimised window or a hidden tab asks nothing; it
 * asks again at once when it shows). Never two at a time; now() during one runs again right after it. Returns
 * { stop(), now() }.
 */
export function poll(root, fn, ms) {
  let busy = false;
  let again = false; // asked for now() while one was on its way: one more right after it
  let last = 0;
  let stopped = false;
  const tick = async (force = false) => {
    if (busy && force) again = true;
    if (stopped || busy || (!force && (!seen(root) || Date.now() - last < ms - 50))) return;
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
      last = Date.now();
      if (again && !stopped) {
        again = false;
        tick(true);
      }
    }
  };
  const timer = setInterval(tick, Math.min(ms, 1000));
  tick(true);
  return { stop: () => ((stopped = true), clearInterval(timer)), now: () => tick(true) };
}

/**
 * An error of an app's request in plain words. A computer without these routes needs a newer Hoprig: its server
 * answers a route it does not have with 404 "not found" and no code; every other 404 (no such file) says its own.
 */
export function errorText(e) {
  if (e instanceof ApiError && e.status === 404 && !e.code && (e.data || {}).error === 'not found') return 'This computer needs a Hoprig update for this app.';
  return e && e.message ? e.message : String(e);
}
export const errorLine = (e) => h('div.dapp-error', { role: 'alert' }, icon('alert', { size: 18 }), h('span', errorText(e)));

/** A row of one choice: options [[value, label]]; onPick(value). Returns the element with .set(value). */
export function choice(label, options, current, onPick) {
  const el = h('div.segmented.dapp-seg', { role: 'radiogroup', 'aria-label': label });
  const paint = (cur) => fill(el, options.map(([v, text]) => h('button.seg', { type: 'button', role: 'radio', 'aria-checked': String(cur === v), onclick: () => {
    if (cur === v) return;
    paint(v);
    onPick(v);
  } }, text)));
  paint(current);
  el.set = paint;
  return el;
}

/** A search field that calls onInput(text) as it is typed. */
export const filterField = (placeholder, onInput) => h('input.field.dapp-filter', { type: 'search', placeholder, 'aria-label': placeholder, autocomplete: 'off', spellcheck: 'false', oninput: (e) => onInput(e.target.value) });

/** The width a set of grid tracks needs at least: the px of each fixed or minmax(px, …) track, the gaps, the row's
 * padding and room for a scroll bar. */
export function minWidthOf(tracks, { gap = 10, pad = 36 } = {}) {
  const px = tracks.map((t) => {
    const m = /^(?:minmax\(\s*)?(\d+)px/.exec(String(t || ''));
    return m ? Number(m[1]) : 0;
  });
  return px.reduce((a, b) => a + b, 0) + gap * Math.max(0, tracks.length - 1) + pad;
}

/**
 * A table of `cols` [{ key, label, num?, w (a grid track), narrow? (its track when the table is narrow; false: left
 * out then), sort? (false: not sortable) }] in a box that scrolls. Returns { el, draw(rows: [{ key, cells: [node |
 * text…], cls? }]), sort: { key, desc }, isNarrow() }. A press on a column head sorts by it (again: the other way) and
 * calls onSort(). The table turns narrow when it is narrower than its wide columns need, so a window can be any size
 * and the last column (the actions) never sits past its edge.
 *
 * The rows are kept by key and only the cells that changed are replaced: a poll every few seconds must not take the
 * keyboard's place away from a button, nor swallow a press that spans a redraw. While the keyboard or a press is in
 * the rows, their order stays as it is (new rows go to the end); it catches up when they leave.
 */
export function table(label, cols, { sort = null, onSort = () => {} } = {}) {
  const state = { key: sort ? sort.key : null, desc: sort ? sort.desc : false };
  const head = h('div.dapp-tr.dapp-th', { role: 'row' });
  const body = h('div.dapp-tbody', { role: 'rowgroup' });
  const el = h('div.dapp-table', { role: 'table', 'aria-label': label }, head, body);
  const needs = minWidthOf(cols.map((c) => c.w));
  let last = [];
  const rowEls = new Map(); // key → row element
  let headSig = '';
  let pressing = false;
  const isNarrow = () => el.clientWidth > 0 && el.clientWidth < needs;
  const layout = () => {
    const narrow = isNarrow();
    el.classList.toggle('dapp-narrow', narrow); // words on buttons give way to their icons (desktop.css)
    const idx = cols.map((c, i) => i).filter((i) => !(narrow && cols[i].narrow === false));
    return { narrow, idx, tracks: idx.map((i) => (narrow && cols[i].narrow) || cols[i].w || '1fr').join(' ') };
  };
  const paintHead = ({ idx, tracks }) => {
    const sig = JSON.stringify([tracks, state.key, state.desc]);
    if (sig === headSig) return;
    headSig = sig;
    head.style.gridTemplateColumns = tracks;
    fill(head, idx.map((i) => {
      const c = cols[i];
      const on = state.key === c.key;
      if (c.sort === false) return h(`span.dapp-td${c.num ? '.dapp-num' : ''}`, { role: 'columnheader' }, c.label);
      return h(`button.dapp-sort${c.num ? '.dapp-num' : ''}`, { type: 'button', role: 'columnheader', 'aria-sort': on ? (state.desc ? 'descending' : 'ascending') : 'none', onclick: () => {
        state.desc = on ? !state.desc : !!c.num;
        state.key = c.key;
        onSort();
      } }, h('span', c.label), on ? icon(state.desc ? 'down' : 'up', { size: 12 }) : null);
    }));
  };
  const cell = (i, content) => h(`span.dapp-td${cols[i].num ? '.dapp-num' : ''}`, { role: 'cell' }, content);
  const busy = () => pressing || body.contains(document.activeElement);
  const draw = (rows) => {
    last = rows;
    const l = layout();
    paintHead(l);
    const wanted = new Map(rows.map((r) => [String(r.key), r]));
    // Rows that are gone go (the focused one too: what it showed has ended).
    for (const [k, row] of rowEls) if (!wanted.has(k)) {
      row.remove();
      rowEls.delete(k);
    }
    for (const r of rows) {
      const k = String(r.key);
      const cls = `dapp-tr${r.cls ? ` ${r.cls}` : ''}`;
      const cells = l.idx.map((i) => cell(i, r.cells[i]));
      let row = rowEls.get(k);
      if (!row) {
        row = h('div', { role: 'row', dataset: { key: k } }, cells);
        rowEls.set(k, row);
      } else if (row.children.length !== cells.length) {
        fill(row, cells);
      } else {
        // Same look, same node: a focused or pressed button stays where it is.
        cells.forEach((c, j) => {
          const old = row.children[j];
          if (old.innerHTML !== c.innerHTML) old.replaceWith(c);
        });
      }
      row.className = cls;
      row.style.gridTemplateColumns = l.tracks;
    }
    // The order: the sorted one, unless someone is in the rows (then the old order, new rows at the end).
    const order = busy()
      ? [...[...body.children].filter((n) => wanted.has(n.dataset.key)), ...rows.map((r) => rowEls.get(String(r.key))).filter((n) => n.parentNode !== body)]
      : rows.map((r) => rowEls.get(String(r.key)));
    order.forEach((row, i) => {
      if (body.children[i] !== row) body.insertBefore(row, body.children[i] || null);
    });
  };
  const settle = () => setTimeout(() => {
    if (!busy()) draw(last);
  }, 0);
  body.addEventListener('pointerdown', () => (pressing = true));
  const up = () => {
    if (!pressing) return;
    pressing = false;
    settle();
  };
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', up, true);
  body.addEventListener('focusout', settle);
  // A window made narrower or wider: the same rows with the columns that fit.
  let wasNarrow = null;
  const sizer = new ResizeObserver(() => {
    const n = isNarrow();
    if (n !== wasNarrow) {
      wasNarrow = n;
      draw(last);
    }
  });
  sizer.observe(el);
  paintHead(layout());
  const stop = () => {
    sizer.disconnect();
    document.removeEventListener('pointerup', up, true);
    document.removeEventListener('pointercancel', up, true);
  };
  return { el, draw, sort: state, isNarrow, stop };
}

/** Sort `list` by `key` of each item (numbers, else text), `desc` the other way; nulls last. */
export function sortBy(list, key, desc) {
  const v = (x) => x[key];
  return [...list].sort((a, b) => {
    const x = v(a);
    const y = v(b);
    if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
    if (y === null || y === undefined) return -1;
    const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return desc ? -d : d;
  });
}

/** 12.3 → "12.3 %"; null → "–". */
export const pct = (n) => (Number.isFinite(n) ? `${n >= 10 ? Math.round(n) : n.toFixed(1)} %` : '–');
/** Seconds → "3 d 4 h", "5 h 12 min", "8 min", "40 s". */
export function duration(s) {
  if (!Number.isFinite(s) || s < 0) return '–';
  const d = Math.floor(s / 86400);
  const hr = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${hr} h`;
  if (hr) return `${hr} h ${m} min`;
  return m ? `${m} min` : `${Math.floor(s)} s`;
}
/** A share 0…1 as a meter (the kit's), red above 90 %. */
export const meter = (frac) => h(`div.meter${frac > 0.9 ? '.hot' : ''}`, h('i', { style: { width: `${Math.round(Math.min(1, Math.max(0, frac || 0)) * 100)}%` } }));
/** A time (ms) as the clock of today, or the date and clock of another day. */
export function when(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`;
}
