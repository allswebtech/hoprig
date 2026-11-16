// Search: find in files (Ctrl+Shift+F) with VS Code's three switches (case, whole word, regular expression) and
// files to include or leave out; results grouped by file, a press opens the file at that line. Quick open (Ctrl+P):
// a file by a few letters of its name.
import { add, btn, fill, h } from '../lib.js';
import { icon } from '../icons.js';

const base = (p) => p.split('/').pop();
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** The part of `text` that matched, found again here (the server gives where it starts, not how long it is). */
export function matchSpan(text, col, { q, regex, caseSensitive, word }) {
  let re;
  try {
    const body = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(word ? `\\b(?:${body})\\b` : body, `g${caseSensitive ? '' : 'i'}u`);
  } catch {
    return null;
  }
  re.lastIndex = Math.max(0, col - 1);
  const m = re.exec(text);
  if (!m || !m[0]) return null;
  return [m.index, m.index + m[0].length];
}

/** wb: { get, tabs }. */
export function createSearch(wb) {
  const opts = { q: '', regex: false, caseSensitive: false, word: false, include: '', exclude: '' };
  const input = h('input.field.ed-search-q', { type: 'text', placeholder: 'Search', 'aria-label': 'Search in files', autocapitalize: 'off', spellcheck: 'false', autocomplete: 'off' });
  const flag = (key, text, title) => {
    const b = h('button.ed-flag', { type: 'button', title, 'aria-pressed': 'false', onclick: () => {
      opts[key] = !opts[key];
      b.setAttribute('aria-pressed', String(opts[key]));
      run();
    } }, text);
    return b;
  };
  const include = h('input.field.ed-search-glob', { placeholder: 'e.g. src/**, *.ts', 'aria-label': 'Files to include', autocapitalize: 'off', spellcheck: 'false' });
  const exclude = h('input.field.ed-search-glob', { placeholder: 'e.g. dist, *.min.js', 'aria-label': 'Files to leave out', autocapitalize: 'off', spellcheck: 'false' });
  const more = h('div.ed-search-more.hidden',
    h('label.ed-search-label', 'Files to include', include),
    h('label.ed-search-label', 'Files to leave out', exclude));
  const summary = h('p.ed-panelnote', { role: 'status' });
  const results = h('div.ed-results');
  const el = h('div.ed-panel.ed-search',
    h('div.ed-panelhead', h('h2.ed-paneltitle', 'Search'),
      h('div.ed-paneltools', btn('icon ghost small', { icon: 'more', title: 'Files to include or leave out', onclick: () => more.classList.toggle('hidden') }))),
    h('div.ed-search-box', input, h('div.ed-flags', flag('caseSensitive', 'Aa', 'Match case'), flag('word', 'ab', 'Match whole word'), flag('regex', '.*', 'Use a regular expression'))),
    more, summary, results);

  let timer = null;
  let ask = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 350);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(timer);
      run();
    }
  });
  for (const x of [include, exclude]) x.addEventListener('keydown', (e) => e.key === 'Enter' && run());

  async function run() {
    opts.q = input.value;
    opts.include = include.value.trim();
    opts.exclude = exclude.value.trim();
    const me = ++ask;
    if (!opts.q) {
      fill(summary);
      fill(results);
      return;
    }
    fill(summary, 'Searching…');
    let r;
    try {
      r = await wb.get('search', {
        q: opts.q, ...(opts.regex ? { regex: '1' } : {}), ...(opts.caseSensitive ? { case: '1' } : {}), ...(opts.word ? { word: '1' } : {}),
        ...(opts.include ? { include: opts.include } : {}), ...(opts.exclude ? { exclude: opts.exclude } : {}),
      });
    } catch (e) {
      if (me !== ask) return;
      fill(summary, e.message);
      fill(results);
      return;
    }
    if (me !== ask) return; // a newer search was started meanwhile
    paint(r, { ...opts });
  }

  function paint(r, o) {
    const files = new Map();
    for (const m of r.matches) {
      if (!files.has(m.path)) files.set(m.path, []);
      files.get(m.path).push(m);
    }
    const n = r.matches.length;
    fill(summary, n
      ? `${n.toLocaleString()} result${n === 1 ? '' : 's'} in ${files.size} file${files.size === 1 ? '' : 's'}${r.truncated ? ' (the first ones only: narrow the search)' : ''}${r.timedOut ? ' (stopped after 10 seconds)' : ''}`
      : r.timedOut ? 'Nothing found in 10 seconds: narrow the search.' : 'No results.');
    fill(results, [...files].map(([p, ms]) => {
      const group = h('div.ed-hitfile');
      const lines = h('div.ed-hits');
      const toggle = h('button.ed-hitfile-head', { type: 'button', 'aria-expanded': 'true', title: p, onclick: () => {
        const shut = lines.classList.toggle('hidden');
        toggle.setAttribute('aria-expanded', String(!shut));
      } }, icon('text', { size: 14 }), h('span.ed-hitfile-name', base(p)), h('span.ed-hitfile-dir', dirOf(p)), h('span.ed-count', String(ms.length)));
      fill(lines, ms.map((m) => {
        const span = matchSpan(m.text, m.col, o);
        // The line without its indent, unless the match is in the indent.
        const lead = /^\s*/.exec(m.text)[0].length;
        const cut = span && span[0] < lead ? 0 : lead;
        const t = m.text.slice(cut);
        const text = span
          ? [t.slice(0, span[0] - cut), h('mark.ed-hit-mark', t.slice(span[0] - cut, span[1] - cut)), t.slice(span[1] - cut)]
          : [t];
        return h('button.ed-hit', { type: 'button', title: `${p}:${m.line}`, onclick: () => wb.tabs.open(p, { line: m.line, col: m.col + (m.cut || 0), preview: true }) },
          h('span.ed-hit-line', String(m.line)), h('span.ed-hit-text', ...text));
      }));
      return add(group, toggle, lines);
    }));
  }

  return {
    el,
    /** Show the panel with the box ready, holding the editor's selection when it has one. */
    focus(selection = '') {
      if (selection && !selection.includes('\n')) {
        input.value = selection;
        run();
      }
      input.focus();
      input.select();
    },
  };
}

// ---------- quick open ----------

/** How well `q` fits path `p` (higher is better), or -1: every letter in order, the name before the folders. */
export function fuzzy(q, p) {
  const s = q.toLowerCase().replace(/\s+/g, '');
  if (!s) return 0;
  const name = base(p).toLowerCase();
  const full = p.toLowerCase();
  if (name.startsWith(s)) return 1000 - name.length;
  if (name.includes(s)) return 800 - name.length;
  if (full.includes(s)) return 600 - full.length;
  let at = 0;
  let gaps = 0;
  for (const c of s) {
    const i = full.indexOf(c, at);
    if (i < 0) return -1;
    gaps += i - at;
    at = i + 1;
  }
  return Math.max(1, 400 - gaps - full.length);
}

/** The quick open box over the editor. wb: { get, tabs, frame (the element it goes in) }. */
export function createQuickOpen(wb) {
  let files = null;
  let truncated = false;
  let picks = [];
  let at = 0;
  const input = h('input.field.ed-quick-q', { type: 'text', placeholder: 'Type a file name (and :line to go there)', 'aria-label': 'Go to file', autocapitalize: 'off', spellcheck: 'false', autocomplete: 'off' });
  const list = h('div.ed-quick-list', { role: 'listbox' });
  const box = h('div.ed-quick', { role: 'dialog', 'aria-label': 'Go to file' }, input, list);
  const veil = h('div.ed-quick-veil.hidden', { onclick: (e) => e.target === veil && close() }, box);

  async function load() {
    if (files) return;
    fill(list, h('p.ed-panelnote', 'Reading the file list…'));
    try {
      const r = await wb.get('files', {});
      files = r.files;
      truncated = r.truncated;
    } catch (e) {
      fill(list, h('p.ed-panelnote', e.message));
    }
  }

  function paint() {
    const [q, line] = input.value.split(':');
    if (!files) return;
    const recent = wb.tabs.paths();
    picks = q.trim()
      ? files.map((p) => [fuzzy(q, p), p]).filter((x) => x[0] >= 0).sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1])).slice(0, 50).map((x) => x[1])
      : [...recent, ...files.filter((p) => !recent.includes(p))].slice(0, 50);
    at = Math.min(at, Math.max(0, picks.length - 1));
    fill(list, picks.length
      ? picks.map((p, i) => h(`button.ed-quick-item${i === at ? '.on' : ''}`, { type: 'button', role: 'option', 'aria-selected': String(i === at), onclick: () => go(p, line) },
        icon('text', { size: 14 }), h('span.ed-hitfile-name', base(p)), h('span.ed-hitfile-dir', dirOf(p))))
      : h('p.ed-panelnote', 'No file matches.'),
    truncated ? h('p.ed-panelnote', 'Only the first 20,000 files are listed.') : null);
    const on = list.querySelector('.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  function go(p, line) {
    close();
    const n = Number(line);
    wb.tabs.open(p, { preview: false, line: Number.isInteger(n) && n > 0 ? n : 0 });
  }

  input.addEventListener('input', () => {
    at = 0;
    paint();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      at = Math.max(0, Math.min(picks.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (picks[at]) go(picks[at], input.value.split(':')[1]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  function close() {
    veil.classList.add('hidden');
  }

  return {
    el: veil,
    async open() {
      veil.classList.remove('hidden');
      input.value = '';
      at = 0;
      input.focus();
      await load();
      paint();
    },
    close,
    /** Files were made, renamed or deleted: read the list again next time. */
    stale() {
      files = null;
    },
  };
}
