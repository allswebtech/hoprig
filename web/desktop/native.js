// What the native apps of the desktop share (tasks.js, services.js, logs.js): the body of their window, a poll that
// runs only while the app can be seen, a sortable table, small controls and the words for numbers. A native app is
// a module with mount(root, { machine }) → stop(): it draws into `root` and calls the API of computer `machine`
// (null: this one) through at(), so the same app works for another computer through the relay.
import { icon } from '../icons.js';
import { ApiError, fill, h } from '../lib.js';

/**
 * The body of a native app's window: { el, reload(), stop() }. The module is loaded when the window is built; a
 * reload mounts it again from nothing.
 */
export function nativeBody(app, { machine }) {
  const el = h('div.dapp', { dataset: { app: app.id } });
  let stop = () => {};
  let gen = 0;
  const start = () => {
    const mine = ++gen;
    fill(el, h('p.dapp-note', 'Opening…'));
    import(`./${app.module}`).then((m) => {
      if (mine !== gen) return;
      fill(el);
      stop = m.mount(el, { machine }) || (() => {});
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
 * asks again at once when it shows). Never two at a time. Returns { stop(), now() }.
 */
export function poll(root, fn, ms) {
  let busy = false;
  let last = 0;
  let stopped = false;
  const tick = async (force = false) => {
    if (stopped || busy || (!force && (!seen(root) || Date.now() - last < ms - 50))) return;
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
      last = Date.now();
    }
  };
  const timer = setInterval(tick, Math.min(ms, 1000));
  tick(true);
  return { stop: () => ((stopped = true), clearInterval(timer)), now: () => tick(true) };
}

/** An error of an app's request in plain words; a computer without these routes needs a newer Hoprig. */
export function errorText(e) {
  if (e instanceof ApiError && e.status === 404 && !e.code) return 'This computer needs a Hoprig update for this app.';
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

/**
 * A table of `cols` [{ key, label, num?, w (a grid track), sort? (false: not sortable) }] in a scrolling box. Returns
 * { el, draw(rows: [{ key, cells: [node|text…], cls? }]) , sort: { key, desc } }. A press on a column head sorts by
 * it (again: the other way) and calls onSort().
 */
export function table(label, cols, { sort = null, onSort = () => {} } = {}) {
  const state = { key: sort ? sort.key : null, desc: sort ? sort.desc : false };
  const tracks = cols.map((c) => c.w || '1fr').join(' ');
  const head = h('div.dapp-tr.dapp-th', { role: 'row', style: { gridTemplateColumns: tracks } });
  const body = h('div.dapp-tbody', { role: 'rowgroup' });
  const paintHead = () => fill(head, cols.map((c) => {
    const on = state.key === c.key;
    const text = [h('span', c.label), on ? icon(state.desc ? 'down' : 'up', { size: 12 }) : null];
    if (c.sort === false) return h(`span.dapp-td${c.num ? '.dapp-num' : ''}`, { role: 'columnheader' }, c.label);
    return h(`button.dapp-sort${c.num ? '.dapp-num' : ''}`, { type: 'button', role: 'columnheader', 'aria-sort': on ? (state.desc ? 'descending' : 'ascending') : 'none', onclick: () => {
      state.desc = on ? !state.desc : !!c.num;
      state.key = c.key;
      paintHead();
      onSort();
    } }, text);
  }));
  paintHead();
  const el = h('div.dapp-table', { role: 'table', 'aria-label': label }, head, body);
  const draw = (rows) => fill(body, rows.map((r) => h(`div.dapp-tr${r.cls ? `.${r.cls}` : ''}`, { role: 'row', style: { gridTemplateColumns: tracks }, dataset: { key: String(r.key) } },
    r.cells.map((c, i) => h(`span.dapp-td${cols[i].num ? '.dapp-num' : ''}`, { role: 'cell' }, c)))));
  return { el, draw, sort: state };
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
