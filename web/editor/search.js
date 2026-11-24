// Search: find in files (Ctrl+Shift+F) with VS Code's three switches (case, whole word, regular expression) and
// files to include or leave out; results grouped by file, a press opens the file at that line. Quick open (Ctrl+P):
// a file by a few letters of its name.
import { add, btn, confirmSheet, fill, h, toast } from '../lib.js';
import { icon } from '../icons.js';
import { patternSource } from './words.js';

const base = (p) => p.split('/').pop();
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** The search as a RegExp for every match (null when the regular expression is not one). Match Whole Word is
 * ripgrep's word, from the one definition the server's search uses too (words.js). */
export function searchRe({ q, regex, caseSensitive, word }) {
  try {
    return new RegExp(patternSource({ q, regex, word }), `g${caseSensitive ? '' : 'i'}u`);
  } catch {
    return null;
  }
}

/** The part of `text` that matched, found again here (the server gives where it starts, not how long it is). */
export function matchSpan(text, col, o) {
  const re = searchRe(o);
  if (!re) return null;
  re.lastIndex = Math.max(0, col - 1);
  const m = re.exec(text);
  if (!m || !m[0]) return null;
  return [m.index, m.index + m[0].length];
}

/**
 * What `by` becomes for one match `m` of a regular expression in `line`, read as String.replace reads it: $$, $&, $`,
 * $', $1 to $99 and $<name>. Worked out from the match alone, so a line of many matches costs one pass (a replace over
 * the whole line for each match copied the line once per match: seconds for a minified file).
 */
export function expand(by, m, line) {
  if (!by.includes('$')) return by;
  const n = m.length - 1; // the number of groups
  const digit = (c) => c >= '0' && c <= '9';
  let out = '';
  for (let i = 0; i < by.length; i++) {
    const d = by[i + 1];
    if (by[i] !== '$' || d === undefined) out += by[i];
    else if (d === '$') (out += '$'), i++;
    else if (d === '&') (out += m[0]), i++;
    else if (d === '`') (out += line.slice(0, m.index)), i++;
    else if (d === '\'') (out += line.slice(m.index + m[0].length)), i++;
    else if (digit(d)) {
      // Two digits when they name a group, else one; "$0" and a group that is not there stay as they are.
      const two = digit(by[i + 2]) ? Number(d + by[i + 2]) : 0;
      if (two >= 1 && two <= n) (out += m[two] ?? ''), (i += 2);
      else if (Number(d) >= 1 && Number(d) <= n) (out += m[Number(d)] ?? ''), i++;
      else out += '$';
    } else if (d === '<' && m.groups && by.indexOf('>', i + 2) > 0) {
      const close = by.indexOf('>', i + 2);
      out += m.groups[by.slice(i + 2, close)] ?? '';
      i = close;
    } else out += '$';
  }
  return out;
}

/**
 * Every match of `re` (global) in ONE line, with what it becomes: [{ at, end, to }]. With a regular expression `by`
 * reads $1, $<name> and $& as VS Code does (expand); otherwise it is taken as it is.
 */
function matchesOf(line, re, by, regex) {
  const out = [];
  re.lastIndex = 0;
  for (const m of line.matchAll(re)) {
    if (!m[0]) continue; // an empty match replaces nothing
    out.push({ at: m.index, end: m.index + m[0].length, to: regex ? expand(by, m, line) : by });
  }
  return out;
}

/** A search that can match nothing at all (a regular expression such as "x*") would replace between every letter. */
const usable = (o) => {
  const re = searchRe(o);
  return re && o.q && !re.test('') ? re : null;
};

/** The matches of the search in one line of a result, with their replacement: what the preview marks. */
export function hitsIn(line, o, by = '') {
  const re = usable(o);
  return re ? matchesOf(line, re, by, o.regex) : [];
}

/**
 * How many matches of a result's line are not in its excerpt: the server cuts a long line to 200 characters and says
 * how many matches the whole line has (count); Replace All writes every one of them.
 */
export const moreOn = (m, hits) => Math.max(0, (m.count || 0) - hits.length);

/**
 * Where a result's line is shown from: its indent goes (unless a match is in it), and a match late in a long line
 * keeps a few words (12 characters) before it, so the match and its replacement are in view (the page adds "…").
 * VS Code's search tree keeps 26, in a narrower font: in this monospace preview at the side bar's default 300 px,
 * 26 still hid the match.
 */
export function previewCut(line, hits) {
  const lead = /^\s*/.exec(line)[0].length;
  if (!hits.length) return lead;
  const first = hits[0].at;
  return first - lead > 12 ? first - 12 : Math.min(lead, first);
}

/**
 * `text` with every match of the search replaced by `by`: { text, n } with n the number of replacements. Line by
 * line, as the search finds them: a pattern never reaches over a line end (so "\s" keeps it) and ^ and $ are each
 * line's start and end, the matches the preview showed and no others.
 */
export function replaceIn(text, o, by) {
  const re = usable(o);
  if (!re) return { text, n: 0 };
  const parts = text.split(/(\r?\n)/); // the lines at even places, their ends at odd ones
  let n = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const ms = matchesOf(parts[i], re, by, o.regex);
    if (!ms.length) continue;
    n += ms.length;
    let line = '';
    let at = 0;
    for (const m of ms) {
      line += parts[i].slice(at, m.at) + m.to;
      at = m.end;
    }
    parts[i] = line + parts[i].slice(at);
  }
  return { text: n ? parts.join('') : text, n };
}

/**
 * What Replace All would do, counted by the replaceIn that writes, so the dialog says what is written. An open file
 * is taken from its tab. A closed one is read now and left out, named, when it changed on disk after the search read
 * it (`versions`: the search's { path: version }), is binary or too large, or holds no match any more.
 * → { files: [{ path, tab, text, version, n }], n, skipped: [{ path, why }] }
 */
export async function planReplace(wb, paths, o, by, versions = {}) {
  const plan = { files: [], n: 0, skipped: [] };
  for (const p of paths) {
    const t = wb.tabs.fileTab(p);
    if (t && !t.note) {
      const x = replaceIn(wb.tabs.textOf(t), o, by);
      if (x.n) plan.files.push({ path: p, tab: t, n: x.n });
      else plan.skipped.push({ path: p, why: 'no match in its tab now' });
      plan.n += x.n;
      continue;
    }
    let f;
    try {
      f = await wb.get('file', { path: p });
    } catch (e) {
      plan.skipped.push({ path: p, why: e.status === 413 ? 'too large' : e.message });
      continue;
    }
    if (f.binary) {
      plan.skipped.push({ path: p, why: 'a binary file' });
      continue;
    }
    if (versions && versions[p] && versions[p] !== f.version) {
      plan.skipped.push({ path: p, why: 'changed on disk since the search: search again' });
      continue;
    }
    const x = replaceIn(f.text, o, by);
    if (!x.n) {
      plan.skipped.push({ path: p, why: 'no match in it now' });
      continue;
    }
    plan.files.push({ path: p, text: x.text, version: f.version, n: x.n });
    plan.n += x.n;
  }
  return plan;
}

/**
 * Do a plan of planReplace (wb.tabs, wb.post): an open file changes in its tab (its undo takes it back; Ctrl+S saves
 * it); a closed one is saved over the version it was counted at, so a change made meanwhile is skipped and named.
 * → { changed, inTabs, n, skipped }
 */
export async function applyReplace(wb, plan, o, by) {
  const r = { changed: [], inTabs: [], n: 0, skipped: [] };
  for (const f of plan.files) {
    if (f.tab) {
      const x = replaceIn(wb.tabs.textOf(f.tab), o, by);
      if (x.n && wb.tabs.putText(f.tab, x.text)) {
        r.inTabs.push(f.path);
        r.n += x.n;
      } else r.skipped.push({ path: f.path, why: 'no match in its tab now' });
      continue;
    }
    try {
      await wb.post('file', { path: f.path, text: f.text, version: f.version });
      r.changed.push(f.path);
      r.n += f.n;
    } catch (e) {
      r.skipped.push({ path: f.path, why: e.status === 409 ? 'changed on disk meanwhile' : e.message });
    }
  }
  return r;
}

/** wb: { get, post, tabs, onChanged() }. */
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
  const replaceBox = h('input.field.ed-search-r', { type: 'text', placeholder: 'Replace', 'aria-label': 'Replace', autocapitalize: 'off', spellcheck: 'false', autocomplete: 'off' });
  const replaceAll = btn('icon ghost small', { icon: 'checkAll', title: 'Replace All (Ctrl+Alt+Enter)', onclick: () => applyAll() });
  const replaceRow = h('div.ed-search-replace.hidden', replaceBox, replaceAll);
  const toggleReplace = h('button.ed-flag.ed-replace-toggle', { type: 'button', title: 'Toggle Replace', 'aria-label': 'Toggle Replace', 'aria-expanded': 'false', onclick: () => showReplace(replaceRow.classList.contains('hidden')) }, icon('chevronRight', { size: 14 }));
  function showReplace(on = true) {
    replaceRow.classList.toggle('hidden', !on);
    toggleReplace.setAttribute('aria-expanded', String(on));
    fill(toggleReplace, icon(on ? 'chevronDown' : 'chevronRight', { size: 14 }));
    if (on) replaceBox.focus();
    if (last) paint(last.r, last.o);
  }
  replaceBox.addEventListener('input', () => last && paint(last.r, last.o));
  replaceBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.altKey) {
      e.preventDefault();
      applyAll();
    }
  });
  let last = null; // the last results, drawn again as the replacement is typed
  const summary = h('p.ed-panelnote', { role: 'status' });
  const results = h('div.ed-results');
  const el = h('div.ed-panel.ed-search',
    h('div.ed-panelhead', h('h2.ed-paneltitle', 'Search'),
      h('div.ed-paneltools', btn('icon ghost small', { icon: 'more', title: 'Files to include or leave out', onclick: () => more.classList.toggle('hidden') }))),
    h('div.ed-search-top', toggleReplace, h('div.ed-search-fields',
      h('div.ed-search-box', input, h('div.ed-flags', flag('caseSensitive', 'Aa', 'Match Case (Alt+C)'), flag('word', 'ab', 'Match Whole Word (Alt+W)'), flag('regex', '.*', 'Use Regular Expression (Alt+R)'))),
      replaceRow)),
    more, summary, results);
  // VS Code's keys for the three switches while the search box has the keyboard.
  el.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || !['KeyC', 'KeyW', 'KeyR'].includes(e.code) || !e.target.closest('.ed-search-fields')) return;
    e.preventDefault();
    e.stopPropagation();
    el.querySelectorAll('.ed-flags .ed-flag')[{ KeyC: 0, KeyW: 1, KeyR: 2 }[e.code]].click();
  });

  async function applyAll() {
    if (!last || !last.r.matches.length) return toast('Search for something first.', { kind: 'info' });
    const o = last.o;
    const by = replaceBox.value;
    const paths = [...new Set(last.r.matches.map((m) => m.path))];
    // Counted by the function that writes, over every file's whole text: the dialog says what is written.
    fill(summary, 'Counting the matches…');
    const plan = await planReplace(wb, paths, o, by, last.r.versions);
    paint(last.r, last.o);
    const files = (k) => `${k} file${k === 1 ? '' : 's'}`;
    const skipped = plan.skipped.length ? ` Left as they are: ${plan.skipped.map((x) => `${x.path} (${x.why})`).join(', ')}.` : '';
    if (!plan.files.length) return toast(`Nothing to replace.${skipped}`, { kind: 'error', ms: 12000 });
    const ok = await confirmSheet({
      title: `Replace ${plan.n.toLocaleString()} match${plan.n === 1 ? '' : 'es'} in ${files(plan.files.length)}?`,
      text: `"${o.q}" becomes "${by}". Files that are not open are saved at once; open files change in their tabs, where Ctrl+Z takes it back and Ctrl+S saves.${last.r.truncated ? ' Only the files listed are changed: the search stopped at its limit.' : ''}${skipped}`,
      ok: 'Replace',
    });
    if (!ok) return;
    const r = await applyReplace(wb, plan, o, by);
    const left = [...plan.skipped, ...r.skipped];
    const said = [
      `${r.n.toLocaleString()} replaced in ${files(r.changed.length + r.inTabs.length)}`,
      r.inTabs.length ? `${r.inTabs.length} open, not saved yet` : '',
      left.length ? `skipped: ${left.map((x) => `${x.path} (${x.why})`).join(', ')}` : '',
    ].filter(Boolean).join('. ');
    toast(said, { kind: left.length ? 'error' : 'info', ms: left.length ? 12000 : 5000 });
    if (wb.onChanged) wb.onChanged();
    run();
  }

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
    last = { r, o };
    const by = replaceRow.classList.contains('hidden') ? null : replaceBox.value;
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
        // Every match of the line (a result is one line), each struck through with what comes beside it when Replace
        // is open: the preview shows each change Replace All makes (those past a long line's excerpt as "+N more").
        const hits = hitsIn(m.text, o, by || '');
        const cut = previewCut(m.text, hits);
        const text = [cut > /^\s*/.exec(m.text)[0].length ? '…' : ''];
        let at = cut;
        for (const x of hits) {
          const found = m.text.slice(x.at, x.end);
          text.push(m.text.slice(at, x.at), by === null ? h('mark.ed-hit-mark', found) : [h('del.ed-hit-del', found), h('ins.ed-hit-ins', x.to)]);
          at = x.end;
        }
        text.push(m.text.slice(at));
        // Matches of a long line beyond what the server sent: named, so the preview still counts each change.
        const more = moreOn(m, hits);
        return h('button.ed-hit', { type: 'button', title: `${p}:${m.line}`, onclick: () => wb.tabs.open(p, { line: m.line, col: m.col + (m.cut || 0), preview: true }) },
          h('span.ed-hit-line', String(m.line)), h('span.ed-hit-text', ...text),
          more ? h('span.ed-hit-more', `+${more} more on this line`) : null);
      }));
      return add(group, toggle, lines);
    }));
  }

  return {
    el,
    showReplace,
    /** Ctrl+Shift+J: the files to include and leave out, shown or hidden (VS Code's search details). */
    toggleDetails() {
      more.classList.toggle('hidden');
    },
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

/** A command's name for a screen reader: its words, then its key, then the key a browser keeps, apart. */
export const commandName = (c) => `${c.label}, ${c.keys[0]}${c.browser ? ` (a browser tab keeps ${c.browser})` : ''}`;

/** The quick open box over the editor. wb: { get, tabs, frame (the element it goes in) }. */
export function createQuickOpen(wb) {
  let files = null;
  let truncated = false;
  let picks = [];
  let cmds = []; // the page's commands: "> " in the box lists them, as in VS Code
  let at = 0;
  let reading = null; // the file list on its way
  // A combobox over its list (the ARIA pattern): the chosen row is told by aria-activedescendant as the arrows move.
  const input = h('input.field.ed-quick-q', { type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'ed-quick-list', 'aria-autocomplete': 'list', autocapitalize: 'off', spellcheck: 'false', autocomplete: 'off' });
  const list = h('div.ed-quick-list', { role: 'listbox', id: 'ed-quick-list' });
  const box = h('div.ed-quick', { role: 'dialog' }, input, list);
  let mode = '';
  /** Named for what it lists: the files, or with ">" the commands. */
  function nameFor(commands) {
    if (mode === (commands ? 'cmd' : 'file')) return;
    mode = commands ? 'cmd' : 'file';
    const name = commands ? 'Commands' : 'Go to file';
    input.setAttribute('aria-label', name);
    box.setAttribute('aria-label', name);
    list.setAttribute('aria-label', commands ? 'Commands' : 'Files');
    input.placeholder = commands ? 'Type the name of a command' : 'Type a file name (and :line to go there)';
  }
  /** The chosen row, for a screen reader (no row: nothing). */
  const tell = () => input.setAttribute('aria-activedescendant', picks.length ? `ed-quick-opt-${at}` : '');
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
    nameFor(input.value.startsWith('>'));
    if (input.value.startsWith('>')) return paintCommands();
    const [q, line] = input.value.split(':');
    if (!files) {
      // Opened with ">" (the command list), so the file list was never read: read it now. Until it is here nothing is
      // picked, so Enter cannot run a command the list no longer shows.
      picks = [];
      tell();
      if (!reading) reading = load().then(() => {
        reading = null;
        if (files && !input.value.startsWith('>')) paint();
      });
      return;
    }
    const recent = wb.tabs.paths();
    picks = q.trim()
      ? files.map((p) => [fuzzy(q, p), p]).filter((x) => x[0] >= 0).sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1])).slice(0, 50).map((x) => x[1])
      : [...recent, ...files.filter((p) => !recent.includes(p))].slice(0, 50);
    at = Math.min(at, Math.max(0, picks.length - 1));
    fill(list, picks.length
      ? picks.map((p, i) => h(`button.ed-quick-item${i === at ? '.on' : ''}`, { type: 'button', role: 'option', id: `ed-quick-opt-${i}`, tabindex: '-1', 'aria-selected': String(i === at), onclick: () => go(p, line) },
        icon('text', { size: 14 }), h('span.ed-hitfile-name', base(p)), h('span.ed-hitfile-dir', dirOf(p))))
      : h('p.ed-panelnote', 'No file matches.'),
    truncated ? h('p.ed-panelnote', 'Only the first 20,000 files are listed.') : null);
    tell();
    const on = list.querySelector('.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  function paintCommands() {
    const q = input.value.slice(1).trim().toLowerCase();
    picks = cmds.filter((c) => !q || c.label.toLowerCase().includes(q));
    at = Math.min(at, Math.max(0, picks.length - 1));
    fill(list, picks.length
      ? picks.map((c, i) => h(`button.ed-quick-item${i === at ? '.on' : ''}`, { type: 'button', role: 'option', id: `ed-quick-opt-${i}`, tabindex: '-1', 'aria-label': commandName(c), 'aria-selected': String(i === at), onclick: () => runCmd(c) },
        h('span.ed-hitfile-name', c.label), h('span.ed-hitfile-dir', c.browser ? `a browser tab keeps ${c.browser}` : ''), h('span.ed-quick-keys', c.keys[0])))
      : h('p.ed-panelnote', 'No command matches.'));
    tell();
  }
  function runCmd(c) {
    close();
    c.run();
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
      if (picks[at] && typeof picks[at] === 'object') runCmd(picks[at]);
      else if (picks[at]) go(picks[at], input.value.split(':')[1]);
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
    async open(prefix = '') {
      veil.classList.remove('hidden');
      input.value = prefix;
      at = 0;
      input.focus();
      if (!prefix) await load();
      paint();
    },
    commands(list) {
      cmds = list;
    },
    close,
    /** Files were made, renamed or deleted: read the list again next time. */
    stale() {
      files = null;
    },
  };
}
