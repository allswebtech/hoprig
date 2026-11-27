// Computers → "Before you format this computer" (#/leave). The page asks the server (src/workspace/leavefeature.mjs)
// for the whole check, which only reads; it shows each command to copy and never runs one. Its presses: "Push my
// other branches" (never a default branch), Keep / Ignore of a home folder, Check it again.
import { icon } from './icons.js';
import { api, btn, bytes, copyText, fill, h, prefs, toast } from './lib.js';
import { registerPage } from './registry.js';
import { emptyState, errorBox, groupHead, okBox, panel } from './shell.js';

export const TITLE = 'Before you format this computer';
const POLL_MS = 1500;

// The groups of the report, in the order a person decides about them (kinds of SHAPE.md).
const GROUPS = [
  ['Work on no git server', ['branch', 'work', 'stash', 'noserver']],
  ['Folders in no git', ['folder', 'described']],
  ['Your coding tools\' own folders', ['memory', 'rules']],
  ['Keys and credentials', ['key', 'keystore', 'credentials']],
  ['Databases', ['database']],
  ['Hoprig\'s own settings', ['hoprig']],
];
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** A command shown with a copy button; the page never runs it. */
const commandLine = (command) => h('div.leave-cmd', h('code', command),
  btn('small ghost', { icon: 'copy', label: 'Copy', 'aria-label': `Copy: ${command}`, onclick: async () => toast(await copyText(command) ? 'Copied' : 'Could not copy: select the line instead') }));

function itemRow(it) {
  return h('div.leave-item',
    h('div.leave-where', h('strong', it.where), it.size === null ? null : h('span.badge.soft', bytes(it.size))),
    h('p', it.what),
    h('p.hint', it.todo),
    it.command ? commandLine(it.command) : null);
}

// ---------- the page ----------

function viewLeave({ frame }) {
  let alive = true;
  let timer = null;
  const hint = h('div');
  const lookBox = h('div');
  const pushBox = h('div');
  let report = null;
  let looking = false;

  const paintHint = () => fill(hint, prefs.get('leave.hintSeen', false) ? null
    : h('div.banner.muted', { role: 'note' }, icon('info', { size: 18 }),
      h('span', 'Press Look now before you erase or give away this computer. Each line says what to do; nothing changes until you do it yourself.'),
      h('span.banner-actions', btn('small secondary', { label: 'Got it', onclick: () => { prefs.set('leave.hintSeen', true); paintHint(); } }))));

  async function mark(body) {
    try {
      await api('/api/workspace/leave/mark', body);
      toast('Saved. Look again to see the new list.');
      look();
    } catch (e) {
      toast(e, { kind: 'error' });
    }
  }

  function paintReport() {
    if (!report) {
      return fill(lookBox, looking
        ? h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Looking at the whole computer… this can take a minute.'))
        : emptyState('search', 'Nothing looked at yet on this page.')); // the one Look now is the page's own button
    }
    const r = report;
    const parts = [];
    for (const [title, kinds] of GROUPS) {
      const items = r.items.filter((i) => kinds.includes(i.kind));
      if (items.length) parts.push(groupHead(title, items.length), h('div.leave-list', items.map(itemRow)));
    }
    const other = r.items.filter((i) => !GROUPS.some(([, k]) => k.includes(i.kind)));
    if (other.length) parts.push(groupHead('Other things', other.length), h('div.leave-list', other.map(itemRow)));
    if (r.asks.length) {
      parts.push(groupHead('Folders of other programs: keep or ignore?', r.asks.length), h('div.leave-list', r.asks.map((a) => h('div.leave-item',
        h('div.leave-where', h('strong', a.where), a.size === null ? null : h('span.badge.soft', bytes(a.size))),
        h('p', a.question),
        h('div.savebar.start',
          btn('secondary', { label: 'Keep (I back it up)', 'aria-label': `Keep ${a.where}: I back it up`, onclick: () => mark({ kind: 'keep', what: a.where }) }),
          btn('ghost', { label: 'Ignore', 'aria-label': `Ignore ${a.where}`, onclick: () => mark({ kind: 'ignore', what: a.where }) }))))));
    }
    if (r.notChecked.length) parts.push(groupHead('Could not be looked at', r.notChecked.length), h('div.leave-list', r.notChecked.map((o) => h('div.leave-item', h('strong', o.where), h('p.hint', o.why)))));
    if (r.outside.length) {
      parts.push(groupHead('Not checked, by your word'), h('div.leave-list', r.outside.map((o) => h('div.leave-item.leave-row',
        h('span', `Not checked, by your word: ${o.where}`),
        btn('small ghost', { label: 'Check it again', 'aria-label': `Check ${o.where} again`, onclick: () => mark({ unmark: o.where }) })))));
    }
    parts.push(r.nothingOnlyHere ? okBox(r.last) : h('p.leave-last', h('strong', r.last)));
    parts.push(h('p.hint', `Looked ${when(r.at)}.`), h('div.savebar.start', btn('secondary', { icon: 'refresh', label: 'Look again', onclick: look })));
    fill(lookBox, parts);
  }

  async function poll(run) {
    try {
      const v = await api(`/api/workspace/leave?run=${encodeURIComponent(run)}`);
      if (!alive) return;
      if (v.running) {
        timer = setTimeout(() => poll(run), POLL_MS);
        return;
      }
      looking = false;
      if (v.error) return fill(lookBox, errorBox(`The look did not finish: ${v.error}`, look));
      report = v.report;
      paintReport();
    } catch (e) {
      looking = false;
      if (alive) fill(lookBox, errorBox(e.message, look));
    }
  }
  async function look() {
    if (looking) return;
    looking = true;
    report = null;
    paintReport();
    try {
      const v = await api('/api/workspace/leave');
      poll(v.run);
    } catch (e) {
      looking = false;
      fill(lookBox, errorBox(e.message, look));
    }
  }

  function paintPush(result = null) {
    let pressing = false;
    const press = btn('primary', { icon: 'upload', label: 'Push my other branches', onclick: async () => {
      if (pressing) return;
      pressing = true;
      press.disabled = true;
      try {
        const r = await api('/api/workspace/onlyhere/push', {});
        paintPush(r);
      } catch (e) {
        toast(e, { kind: 'error' });
        press.disabled = false;
        pressing = false;
      }
    } });
    const res = !result ? null : !result.repos.length ? h('p.hint', 'Nothing was waiting to be pushed.')
      : h('div.leave-list', result.repos.map((x) => h('div.leave-item',
        h('strong', x.label),
        h('p', x.pushed.length ? `Pushed: ${x.pushed.join(', ')}` : 'Nothing pushed.'),
        x.todo.map((t) => [h('p.hint', t.why), t.command ? commandLine(t.command) : null]))));
    fill(pushBox, panel({ icon: 'upload', title: 'Push my other branches', desc: 'Sends the committed work of every branch that is not the default branch to its git server, in every repository of your map. It never pushes a default branch (such as main): that stays your own step, with the command shown above.' },
      h('div.savebar.start', press), res));
  }

  frame({
    title: TITLE,
    page: 'leave',
    back: '#/computers',
    intro: 'Only reads. Nothing is sent or deleted.',
    primary: { label: 'Look now', icon: 'search', onclick: look },
    body: [hint, lookBox, pushBox],
  });
  paintHint();
  paintReport();
  paintPush();
  return () => {
    alive = false;
    clearTimeout(timer);
  };
}

registerPage({ id: 'leave', title: TITLE, icon: 'archive', navAs: 'computers', render: viewLeave });
