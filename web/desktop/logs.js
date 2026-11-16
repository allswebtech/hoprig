// The Logs of a computer (GET /api/logs, /api/logs/files, /api/logs/file; src/desktop/logs.mjs): the journal where
// there is one, read with a cursor (older entries on request) and filtered by unit and priority; or a plain log
// file, read from a byte offset. "Follow" asks again every two seconds from where the last read ended, and only
// while the window can be seen: the relay to another computer has no socket for this, and needs none.
import { icon } from '../icons.js';
import { api, at, bytes, fill, h, toast } from '../lib.js';
import { choice, errorLine, errorText, poll, when } from './native.js';

const PRIORITIES = [['', 'Every priority'], ['3', 'Errors and worse'], ['4', 'Warnings and worse'], ['5', 'Notices and worse'], ['6', 'Information and worse']];
const PRIO_NAME = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];
const KEEP = 3000; // journal entries kept on the page
const TEXT_MAX = 1024 * 1024; // characters of a file kept on the page
const FOLLOW_MS = 2000;

export function mount(root, { machine }) {
  const call = (p) => api(at(machine, p));
  const view = h('div.dapp-view');
  let stopPart = () => {};
  const show = (src) => {
    stopPart();
    fill(view);
    stopPart = src === 'journal' ? journal(view, call, () => {
      pick.set('files');
      show('files');
    }) : files(view, call);
  };
  const pick = choice('Source', [['journal', 'Journal'], ['files', 'Log files']], 'journal', show);
  fill(root, h('div.dapp-bar', pick), view);
  root.classList.add('dapp-logs');
  show('journal');
  return () => stopPart();
}

/** "Follow" as a switch in the bar: onChange(on). */
function followSwitch(onChange) {
  const b = h('button.btn.secondary.small.dapp-follow', { type: 'button', 'aria-pressed': 'false', onclick: () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    onChange(on);
  } }, icon('play', { size: 14 }), h('span', 'Follow'));
  return b;
}

/** Is `el` scrolled to (nearly) its end: then new lines keep it there. */
const atEnd = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 40;

// ---------- the journal ----------

function journal(view, call, noJournal) {
  let scope = 'system';
  let unit = '';
  let priority = '';
  let entries = [];
  let follow = null;
  let gen = 0;
  const list = h('div.dapp-journal', { role: 'log', 'aria-live': 'off', tabindex: '0' });
  const note = h('div');
  const older = h('button.btn.ghost.small', { type: 'button', onclick: () => readOlder() }, icon('up', { size: 14 }), h('span', 'Older entries'));
  const unitField = h('input.field.dapp-filter.dapp-unit', { type: 'search', placeholder: 'Unit, e.g. cron.service', 'aria-label': 'Unit', autocomplete: 'off', spellcheck: 'false',
    onchange: (e) => {
      unit = e.target.value.trim();
      reload();
    } });
  const prio = h('select.field.dapp-select', { 'aria-label': 'Priority', onchange: (e) => {
    priority = e.target.value;
    reload();
  } }, PRIORITIES.map(([v, label]) => h('option', { value: v }, label)));

  const query = (extra) => {
    const p = new URLSearchParams({ scope, lines: extra.lines || '200' });
    if (unit) p.set('unit', unit);
    if (priority) p.set('priority', priority);
    if (extra.after) p.set('after', extra.after);
    if (extra.before) p.set('before', extra.before);
    return `/api/logs?${p}`;
  };
  const row = (e) => h(`div.dapp-entry.dapp-p${Math.min(7, Math.max(0, e.priority))}`,
    h('span.dapp-time', when(e.time)), h('span.dapp-unit-name', { title: e.unit }, e.unit || '–'),
    h('span.dapp-prio', { title: PRIO_NAME[e.priority] || '' }, e.priority <= 4 ? PRIO_NAME[e.priority] : ''), h('span.dapp-msg', e.message));
  const draw = () => fill(list, entries.length ? entries.map(row) : h('p.dapp-note', 'No entries.'));

  async function reload() {
    const mine = ++gen;
    fill(list, h('p.dapp-note', 'Reading…'));
    let r;
    try {
      r = await call(query({}));
    } catch (e) {
      if (mine === gen) fill(list, errorLine(e));
      return;
    }
    if (mine !== gen) return;
    if (!r.available) {
      noJournal();
      toast(r.note || 'This computer has no journal: its log files are shown.');
      return;
    }
    fill(note, r.note ? h('div.banner.muted', h('span', r.note)) : null);
    entries = r.entries || [];
    older.disabled = !entries.length;
    draw();
    list.scrollTop = list.scrollHeight;
  }
  async function readOlder() {
    if (!entries.length) return;
    const mine = gen;
    older.disabled = true;
    try {
      const r = await call(query({ before: entries[0].cursor }));
      if (mine !== gen) return;
      const got = r.entries || [];
      const h0 = list.scrollHeight;
      entries = [...got, ...entries].slice(0, KEEP);
      draw();
      list.scrollTop = list.scrollHeight - h0; // the entry that was at the top stays where it was
      older.disabled = !got.length;
      if (!got.length) toast('Nothing older.');
    } catch (e) {
      toast(errorText(e), { kind: 'error' });
      older.disabled = false;
    }
  }
  async function readNewer() {
    const last = entries[entries.length - 1];
    if (!last) return reload();
    const mine = gen;
    let r;
    try {
      r = await call(query({ after: last.cursor }));
    } catch (e) {
      fill(note, errorLine(e));
      return;
    }
    if (mine !== gen || !(r.entries || []).length) return;
    const stay = atEnd(list);
    entries = [...entries, ...r.entries].slice(-KEEP);
    draw();
    if (stay) list.scrollTop = list.scrollHeight;
  }

  const scopePick = choice('Whose journal', [['system', 'System'], ['user', 'Yours']], scope, (v) => {
    scope = v;
    reload();
  });
  const followBtn = followSwitch((on) => {
    if (follow) follow.stop();
    follow = on ? poll(list, readNewer, FOLLOW_MS) : null;
  });
  fill(view, h('div.dapp-bar', scopePick, unitField, prio, h('span.desk-grow'), older, followBtn), note, list);
  reload();
  return () => {
    gen++;
    if (follow) follow.stop();
  };
}

// ---------- log files ----------

function files(view, call) {
  let path = null;
  let next = null;
  let follow = null;
  let gen = 0;
  const sel = h('select.field.dapp-select.dapp-file', { 'aria-label': 'Log file', onchange: (e) => open(e.target.value) });
  const info = h('span.dapp-status', { role: 'status' });
  const text = h('pre.dapp-log.mono', { tabindex: '0' });
  const err = h('div');

  async function list() {
    try {
      const r = await call('/api/logs/files');
      const all = r.files || [];
      fill(sel, h('option', { value: '' }, all.length ? 'Choose a log file' : 'No log file can be read here'),
        all.map((f) => h('option', { value: f.path }, `${f.path}  (${bytes(f.size)}, ${when(f.mtime)})`)));
    } catch (e) {
      fill(err, errorLine(e));
    }
  }
  async function open(p) {
    const mine = ++gen;
    path = p || null;
    next = null;
    text.textContent = '';
    fill(err);
    if (!path) return;
    text.textContent = 'Reading…';
    try {
      const r = await call(`/api/logs/file?path=${encodeURIComponent(path)}`);
      if (mine !== gen) return;
      text.textContent = r.text || '';
      next = r.next;
      info.textContent = `${bytes(r.size)}${r.from ? ', its end' : ''}`;
      text.scrollTop = text.scrollHeight;
    } catch (e) {
      if (mine === gen) {
        text.textContent = '';
        fill(err, errorLine(e));
      }
    }
  }
  async function readOn() {
    if (!path || next === null) return;
    const mine = gen;
    let r;
    try {
      r = await call(`/api/logs/file?path=${encodeURIComponent(path)}&from=${next}`);
    } catch (e) {
      fill(err, errorLine(e));
      return;
    }
    if (mine !== gen) return;
    const stay = atEnd(text);
    if (r.reset) text.textContent = '(the file started again: it was rotated or emptied)\n';
    if (r.text) {
      const all = text.textContent + r.text;
      text.textContent = all.length > TEXT_MAX ? all.slice(-TEXT_MAX) : all;
    }
    next = r.next;
    info.textContent = bytes(r.size);
    if (stay) text.scrollTop = text.scrollHeight;
  }

  const followBtn = followSwitch((on) => {
    if (follow) follow.stop();
    follow = on ? poll(text, readOn, FOLLOW_MS) : null;
  });
  fill(view, h('div.dapp-bar', sel, info, h('span.desk-grow'), followBtn), err, text);
  list();
  return () => {
    gen++;
    if (follow) follow.stop();
  };
}
