// Work → Go live (#/work/golive): finished task branches of a project put together on one branch, checked, and made
// live on the owner's tap (docs/GO-LIVE.md, src/ship/feature.mjs). One project at a time, chosen at the top. The page
// shows every command in full before it asks for a yes, and says after each step what happened and how to take it back.
import { icon } from './icons.js';
import { api, btn, fill, h, openSheet, prefs, toast } from './lib.js';
import { registerSettingsPage } from './registry.js';
import { emptyState, errorBox, panel, skeletonRows } from './shell.js';

const CHECK = { none: 'Not checked yet', running: 'Checking…', ready: 'Ready: the check passed', failed: 'Failed: the check did not pass', mixed: 'Passed and failed' };
const times = (n) => `${n} time${n === 1 ? '' : 's'}`;
const OUTCOME = { 'taken-back': 'Taken back', 'back-failed': 'Taking back failed', 'back-cut': 'Taking back was cut off', 'did-not-start': 'Did not start', 'not-confirmed': 'Stopped: its commands were no longer the confirmed ones' };

/**
 * The title of a step's outcome, saying what runs now: after a failed verify the new version IS running, which "not
 * live" would hide from someone who is not a programmer.
 */
export function outcomeTitle(s) {
  const at = (iso) => (iso ? new Date(iso).toTimeString().slice(0, 5) : '');
  if (s.outcome === 'live') return `Live since ${at(s.liveSince)}: ${s.name}`;
  if (s.outcome === 'not-verified') return s.updateFailed ? `The update of ${s.name} failed: the project may be part-way updated` : `${s.name} is running now, but it does not answer as it should`;
  if (s.outcome === 'changed') return `${s.name} is running now, and files you keep changed`;
  if (s.outcome === 'update-cut') return `The update of ${s.name} was cut off: the project may be part-way updated`;
  return `${OUTCOME[s.outcome] || s.outcome}: ${s.name}`;
}
/** Whether the go-live commands get the owner's GitHub token: said on the block and on the tap. */
export const githubWords = (on) => (on ? 'These commands get your GitHub token (the project\'s file asks for it with "github": true).' : 'These commands do not get your GitHub token.');
const PART = { picture: 'Taking a picture of the files you keep', update: 'Updating', verify: 'Checking that it answers', again: 'Comparing the files you keep', back: 'Taking it back' };
const hm = (iso) => (iso ? new Date(iso).toTimeString().slice(0, 5) : '');
const enc = encodeURIComponent;

/** One list of commands, each on its own line, in full. */
const focusable = (el, key) => (el.setAttribute('tabindex', '-1'), el.setAttribute('data-sp', key), el);
const cmdList = (label, lines) => (lines && lines.length ? h('div.sp-cmds', h('span.sp-cmds-label', label), h('ul', lines.map((l) => h('li', h('code', l))))) : null);

/**
 * The words of the tap sheet around its commands: which commit is which (`commit`, `before`: short ids), and what
 * happens when it does not answer, by itself or on his press.
 */
export function tapWords({ name, commit, before, autoBack }) {
  return {
    ids: commit && before ? `${commit}… is ${name}'s last commit; ${before}… is the commit the project is on now.` : null,
    after: autoBack ? 'If it does not, nothing more runs and it is taken back by itself:' : 'If it does not, nothing more runs and you can take it back with one press:',
  };
}

/** Draw the part into `slot`. → { refresh(), stop() }. */
export function paintShip(slot) {
  let alive = true;
  let project = prefs.get('ship.project', '');
  let v = null;
  let timer = null;
  const head = h('div.sp-head');
  const body = h('div.sp-body');
  fill(slot, head, body);

  // What the owner picks and types, kept outside paint(): the repaint while something runs (every 2.5 s) keeps it.
  const pick = { order: [], name: null };
  const auto = { open: null, typed: '', from: null, to: null };
  const forget = () => Object.assign(pick, { order: [], name: null }) && Object.assign(auto, { open: null, typed: '', from: null, to: null });

  // After a press focus goes to what it changed: `focus` names it (a data-sp key, or a function of the answer), else
  // the first of a step, its outcome, a conflict, a check (paint). `ok(answer)`: what to forget before the repaint.
  let moveFocus = false;
  const call = async (p, b, done, { focus = true, ok = null } = {}) => {
    try {
      const r = await api(`/api/ship/p/${enc(project)}${p}`, b);
      if (done) toast(done);
      if (ok) ok(r);
      moveFocus = typeof focus === 'function' ? focus(r) : focus;
      await load();
      return r;
    } catch (e) {
      toast(e, { kind: 'error', ms: 7000 });
      await load();
      return null;
    }
  };
  /** A button that is busy while its press runs (a second press waits). */
  const press = (cls, label, run, ic = null) => {
    const b = btn(cls, { label, icon: ic, onclick: async () => {
      if (b.disabled) return;
      b.disabled = true;
      b.classList.add('busy');
      try {
        await run();
      } finally {
        b.disabled = false;
        b.classList.remove('busy');
      }
    } });
    return b;
  };

  async function start() {
    let list;
    try {
      list = (await api('/api/ship')).projects;
    } catch (e) {
      fill(body, errorBox(`Could not load the projects: ${e.message}`, start));
      return;
    }
    if (!list.length) return fill(body, emptyState('folder', 'There is no project with a git repository in your workspace yet.'));
    if (!list.includes(project)) project = list[0];
    const sel = h('select.field.sp-project', { 'aria-label': 'Project', onchange: () => {
      project = sel.value;
      prefs.set('ship.project', project);
      v = null;
      forget();
      fill(body, skeletonRows(3));
      load();
    } }, list.map((n) => h('option', { value: n, selected: n === project }, n)));
    fill(head, h('label.sp-pick', h('span', 'Project'), sel));
    fill(body, skeletonRows(3));
    load();
  }

  async function load() {
    try {
      const next = await api(`/api/ship/p/${enc(project)}`);
      if (!alive) return;
      // A step that ended while the page looked: focus goes to its outcome, as after a press.
      if (v && v.step && !next.step) moveFocus = 'last';
      v = next;
      paint();
    } catch (e) {
      if (alive) fill(body, errorBox(`Could not load ${project}: ${e.message}`, load));
    }
    clearTimeout(timer);
    // While something runs (a step, a check, a session on a conflict), look again now and then.
    const busy = v && (v.step || v.togethers.some((t) => t.check.state === 'running' || (t.conflict && t.conflict.session)));
    if (alive && busy) timer = setTimeout(load, 2500);
  }

  const bySp = (key) => body.querySelector(`[data-sp=${JSON.stringify(key)}]`);

  function paint() {
    // The element with the focus (and where the caret is in a text field), put back after the repaint.
    const active = document.activeElement;
    const focusId = active && body.contains(active) && active.getAttribute ? active.getAttribute('data-sp') : null;
    const caret = focusId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const tg = v.togethers;
    const ready = tg.find((t) => t.finished) || null;
    fill(body,
      v.step ? stepCard(v.step) : null,
      v.last ? lastCard(v.last) : null,
      tg.some((t) => !t.finished) ? null : picker(),
      tg.filter((t, i) => i === 0 || !t.finished).map((t) => togetherCard(t)),
      commandsCard(ready),
      autoCard());
    if (moveFocus) {
      const key = moveFocus === true ? null : moveFocus;
      moveFocus = false;
      // What the press named; else, in this order: a step under way, its outcome, a conflict, a check, the next press.
      const to = (key && bySp(key)) || body.querySelector('.sp-step .sp-title, .sp-last .sp-title, .sp-conflict .btn, .sp-check .banner') || body.querySelector('.btn.primary, .btn.danger');
      to?.focus();
    } else if (focusId) {
      const el = bySp(focusId);
      el?.focus();
      if (el && caret && el.setSelectionRange) {
        try {
          el.setSelectionRange(...caret);
        } catch {
          /* a field without a caret */
        }
      }
    }
  }

  // ---------- 1. pick the finished task branches and put them together ----------
  function picker() {
    pick.order = pick.order.filter((b) => v.branches.some((x) => x.name === b)); // a branch that went is no longer picked
    const order = pick.order;
    const listBox = h('ol.sp-order', { 'aria-label': 'Order in which they are put together' });
    const name = h('input.field.sp-name', { type: 'text', value: pick.name ?? new Date().toLocaleDateString('en-GB', { weekday: 'long' }).toLowerCase(), 'aria-label': 'A short name for this put-together', maxlength: 41, autocapitalize: 'off', spellcheck: false, 'data-sp': 'pick-name', oninput: () => (pick.name = name.value) });
    const go = press('primary', 'Put them together', async () => {
      if (!order.length) return toast('Pick at least one branch', { kind: 'error' });
      await call('/together', { name: name.value.trim(), branches: [...order] }, 'Put together', { focus: (r) => `together:${r.id}`, ok: () => Object.assign(pick, { order: [], name: null }) });
    }, 'git');
    const drawOrder = () => {
      fill(listBox, order.map((b, i) => h('li', h('span.sp-order-name', b),
        btn('icon ghost small', { icon: 'up', title: `Move ${b} up`, disabled: i === 0, onclick: () => ([order[i - 1], order[i]] = [order[i], order[i - 1]], drawOrder()) }),
        btn('icon ghost small', { icon: 'down', title: `Move ${b} down`, disabled: i === order.length - 1, onclick: () => ([order[i + 1], order[i]] = [order[i], order[i + 1]], drawOrder()) }))));
      listBox.hidden = order.length < 2;
    };
    const rows = v.branches.map((b) => {
      const box = h('input', { type: 'checkbox', checked: order.includes(b.name), 'data-sp': `pick:${b.name}`, 'aria-label': b.title ? `${b.name}: ${b.title}` : b.name, onchange: () => {
        if (box.checked) order.push(b.name);
        else order.splice(order.indexOf(b.name), 1);
        drawOrder();
      } });
      return h('label.row.sp-branch', box, h('div.row-main', h('span.row-title.sp-mono', b.name), h('span.row-sub', [b.title, `${b.commits} commit${b.commits === 1 ? '' : 's'}`, b.subject && !b.title ? `"${b.subject}"` : null].filter(Boolean).join(' · '))));
    });
    drawOrder();
    return h('section.card.sp-card',
      focusable(h('h2.sp-title', icon('git', { size: 18 }), h('span', '1. Pick the finished tasks')), 'picker'),
      v.branches.length
        ? [h('p.hint', `Branches with work that is not in ${v.base} yet. They are put together, in the order you pick, on a branch of their own: ${v.base} and your own folder do not change.`), h('div.rows', rows), listBox,
          h('div.sp-actions', h('label.sp-inline', h('span', 'Name'), name), go)]
        : h('p.hint', `There is no branch with work that is not in ${v.base} yet.`));
  }

  // ---------- 2. a put-together: its merges, a conflict, its check ----------
  function togetherCard(t) {
    const merged = h('ol.sp-merged', t.branches.map((b) => {
      const done = t.done.includes(b);
      const meets = t.conflict && t.conflict.branch === b;
      return h(`li.sp-m-${done ? 'done' : meets ? 'conflict' : 'wait'}`, icon(done ? 'check' : meets ? 'alert' : 'clock', { size: 16 }), h('span.sp-mono', b), t.titles[b] ? h('span.sp-muted', ` · ${t.titles[b]}`) : null);
    }));
    let state;
    if (t.conflict) {
      const c = t.conflict;
      state = h('div.banner.warn.sp-conflict', { role: 'status' }, icon('alert', { size: 18 }), h('div',
        h('p', h('strong', `${c.branch} and ${c.meets.map((m) => m.branch).join(', ') || t.base} changed the same lines`), ` in ${c.files.join(', ')}${c.more ? ` and ${c.more} more files` : ''}. Nothing was forced: the merge waits.`),
        c.session
          ? h('p', 'A session is working on it. When it has committed the merge, press Go on. ', h('a', { href: `#/chat/${enc(c.session)}` }, 'Open the session'))
          : h('p', 'A coding session can join the two: it gets both tasks and the files, and commits the merge.'),
        h('div.sp-actions',
          c.session ? null : press('primary', 'Give it to a session', () => call('/handoff', { id: t.id }, 'A session has the conflict', { focus: `together:${t.id}` }), 'sparkle'),
          press(c.session ? 'primary' : 'secondary', 'Go on', () => call('/goon', { id: t.id }, 'Merged the next task', { focus: `together:${t.id}` }), 'play'))));
    } else if (t.problem) state = h('div.banner.error-box', icon('alert', { size: 18 }), h('span', t.problem));
    else if (t.finished) {
      const ck = t.check;
      const cls = ck.state === 'ready' ? 'ok-box' : ck.state === 'none' || ck.state === 'running' ? 'info' : ck.state === 'mixed' ? 'warn' : 'error-box';
      const failing = ck.last && !ck.last.ok ? ck.last.commands.find((x) => !x.ok) : null;
      state = h('div.sp-check',
        h(`div.banner.${cls}`, { role: 'status', tabindex: -1, 'data-sp': `check:${t.id}` }, icon(ck.state === 'ready' ? 'check' : ck.state === 'running' ? 'clock' : ck.state === 'none' ? 'info' : 'alert', { size: 18 }),
          h('span', ck.state === 'mixed'
            ? [h('strong', `Passed ${times(ck.passed)} and failed ${times(ck.failed)}`), ': not counted as passed']
            : [h('strong', CHECK[ck.state]), ck.passed + ck.failed > 1 ? ` (${ck.passed} passed, ${ck.failed} failed)` : ''], ck.last ? ` · last run at ${hm(ck.last.at)}` : '')),
        ck.notCounted ? h('p.hint', `The last run is not counted: ${ck.notCounted}.`) : null,
        failing ? h('div.sp-fail', h('p', failing.shown.length <= 80 ? h('code', failing.shown) : 'The check command', ` ${failing.ended}. Its last lines:`), h('pre.sp-lines', { tabindex: 0, 'aria-label': 'The last lines it printed' }, failing.last || '(nothing)')) : null,
        v.check.shown
          ? h('div.sp-actions', v.check.confirmed
            ? press(ck.state === 'none' ? 'primary' : 'secondary', ck.state === 'none' ? 'Run the check' : 'Run the check again', () => call('/check', { id: t.id }, null, { focus: `check:${t.id}` }), 'play')
            : h('span.hint', 'Confirm the check commands below first.'))
          : h('p.hint', v.check.problem ? `The check in project.json cannot be used: ${v.check.problem}` : 'This project has no check in its project.json.'));
    } else state = h('p.hint', `${t.done.length} of ${t.branches.length} merged.`);
    // One that cannot finish keeps the picker away: it can be dropped (its branch and folder stay).
    const drop = t.finished ? null : h('div.sp-actions', press('ghost', 'Drop this put-together', async () => {
      const ok = await openSheet({ title: `Drop ${t.name}?`, subtitle: v.project }, (close) => [
        h('p', 'The put-together is dropped and you can pick the tasks again. Its branch ', h('code', t.branch), ' and its folder stay; a new put-together needs another name.'),
        h('div.sp-actions', btn('secondary', { label: 'Cancel', onclick: () => close(false) }), btn('primary', { label: 'Drop it', onclick: () => close(true) }))]);
      if (ok) await call('/drop', { id: t.id }, 'Dropped', { focus: 'picker' });
    }, 'x'));
    return h('section.card.sp-card',
      focusable(h('h2.sp-title', icon('stack', { size: 18 }), h('span', `2. Put together: ${t.name}`)), `together:${t.id}`),
      h('p.hint', 'On the branch ', h('code', t.branch), `, made from ${t.base}.`),
      merged, state, drop);
  }

  // ---------- 3. the project's own commands: shown in full, confirmed, the tap ----------
  function commandsCard(ready) {
    const c = v.check;
    const l = v.live;
    const confirm = (kind, hash) => press('secondary', 'I have read them: confirm', () => call('/allow', { kind, seen: hash, ...(ready ? { id: ready.id } : {}) }, 'Confirmed on this computer', { focus: `block:${kind}` }), 'check');
    const block = (title, shown, confirmed, kind, lines) => h('div.sp-block',
      focusable(h('div.sp-block-head', h('strong', title), h(`span.badge.soft.sp-${confirmed ? 'yes' : 'no'}`, confirmed ? 'Confirmed on this computer' : 'Not confirmed')), `block:${kind}`),
      lines,
      confirmed ? null : h('div.sp-actions', confirm(kind, shown.hash)));
    const parts = [];
    if (v.limiter && !v.limiter.confirmed) parts.push(h('div.banner.warn', icon('alert', { size: 18 }), h('span', 'Checks run through ', h('code', v.limiter.shown), ', which is not confirmed yet.'), press('secondary', 'Confirm', () => call('/allow', { kind: 'limiter', seen: v.limiter.shown }, null, { focus: 'block:check' }))));
    if (c.shown) parts.push(block('The check', c.shown, c.confirmed, 'check', [cmdList('Runs in the put-together branch, one after the other:', c.shown.commands), c.confirmed ? null : h('p.hint', 'Your yes covers these words. The check runs the code of the branches that were put together, also scripts a task branch changed.')]));
    if (l.shown) {
      parts.push(block('Going live', l.shown, l.confirmed, 'live', [
        cmdList('1. Update (in the project\'s folder):', l.shown.update),
        cmdList('2. Then it must answer:', l.shown.verify),
        cmdList('To take it back:', l.shown.back),
        l.shown.keep.length ? h('p.hint', 'Kept the same, compared before and after: ', l.shown.keep.map((k, i) => [i ? ', ' : '', h('code', k)])) : null,
        h('p.hint', githubWords(l.shown.github)),
        h('p.hint', '{commit} is the put-together\'s last commit; {before} is the commit your project is on now.'),
        l.confirmed ? null : h('p.hint', 'Your yes covers these words. They run the scripts that are in the project\'s folder at that moment: the update runs the scripts of the put-together, and so does "back" unless it checks out {before} first.'),
      ]));
    } else if (l.problem) parts.push(h('p.hint', `The go-live part of project.json cannot be used: ${l.problem}`));
    if (!parts.length) return h('section.card.sp-card', h('h2.sp-title', icon('code', { size: 18 }), h('span', '3. Go live')), h('p.hint', 'This project has no "check" or "live" in its project.json yet. docs/GO-LIVE.md shows a whole example.'));
    parts.push(tapPart(ready));
    return h('section.card.sp-card', h('h2.sp-title', icon('zap', { size: 18 }), h('span', '3. Go live')),
      h('p.hint', 'These commands come from the project\'s own file. They run on this computer as you, only after you confirmed exactly these. A change to any of them asks again.'),
      parts);
  }

  function tapPart(ready) {
    const l = v.live;
    if (!l.shown) return null;
    if (!ready) return h('p.hint', 'Put the tasks together first.');
    const mixed = ready.check.state === 'mixed' && ready.check.last && ready.check.last.ok;
    if (ready.check.state !== 'ready' && !mixed) return h('p.hint', ready.check.state === 'mixed' ? 'Its last check failed: it does not go live.' : 'It can go live once its check passed.');
    if (!l.confirmed) return h('p.hint', 'Confirm the go-live commands to go live.');
    if (v.step) return h('p.hint', 'A go-live is under way.');
    if (v.last && v.last.outcome === 'live' && v.last.together === ready.id) return h('p.hint', `${ready.name} is live. To go live with more tasks, pick them above and put them together.`);
    if (v.last && ['not-verified', 'changed', 'update-cut', 'back-failed', 'back-cut'].includes(v.last.outcome)) return h('p.hint', 'Take the last go-live back first (above).');
    const failedBefore = v.last && v.last.together === ready.id && v.last.outcome === 'taken-back';
    const cut = v.cut && v.cut.words ? v.cut : null;
    return h('div.sp-tap',
      l.restarts ? h('p.hint', `The update restarts this dashboard. Turns that are still running are waited for, up to ${l.shown.turnSeconds} seconds.`) : null,
      mixed ? h('div.banner.warn', icon('alert', { size: 18 }), h('span', `Its check passed ${ready.check.passed} time${ready.check.passed === 1 ? '' : 's'} and failed ${ready.check.failed} time${ready.check.failed === 1 ? '' : 's'}. It only goes live if you tap: never by itself.`)) : null,
      failedBefore ? h('div.banner.warn', icon('alert', { size: 18 }), h('span', `${ready.name} went live once and was taken back. It goes live again only if you tap.`)) : null,
      cut ? h('div.banner.warn', { role: 'alert' }, icon('alert', { size: 18 }), h('span', cut.words)) : null,
      press(cut ? 'danger' : 'primary', cut ? 'Restart anyway' : `Go live with ${ready.name}`, () => tap(ready, cut), 'zap'));
  }

    /** The tap: what will run, once more, then the step. */
  async function tap(ready, cut) {
    const l = v.live.shown;
    const run = v.tap && v.tap.id === ready.id ? v.tap : l;
    const words = tapWords({ name: ready.name, commit: run.commit, before: run.before, autoBack: v.switches.autoBack });
    const ok = await openSheet({ title: `Go live with ${ready.name}?`, subtitle: v.project }, (close) => [
      cmdList('This runs now, in the project\'s folder:', run.update),
      words.ids ? h('p.hint', words.ids) : null,
      cmdList('Then it must answer:', run.verify),
      run.keep && run.keep.length ? h('p.hint', 'Then the files you keep are compared with before: ', run.keep.map((k, i) => [i ? ', ' : '', h('code', k)])) : null,
      h('p.hint', githubWords(run.github)),
      h('p.hint', words.after),
      cmdList('', run.back),
      cut ? h('div.banner.warn', icon('alert', { size: 18 }), h('span', cut.words)) : null,
      h('div.sp-actions', btn('secondary', { label: 'Cancel', onclick: () => close(false) }), btn(cut ? 'danger' : 'primary', { label: cut ? 'Restart anyway' : 'Go live', icon: 'zap', onclick: () => close(true), 'data-sp': 'tap-yes' })),
    ]);
    if (!ok) return;
    await call('/live', { id: ready.id, seen: l.hash, ...(cut ? { anyway: { turns: cut.turns.map((x) => x.id), terminals: cut.terminals } } : {}) }, 'Going live', { focus: 'step' });
  }

  // ---------- 4. the step as it goes, and its outcome ----------
  function stepCard(s) {
    if (s.unreadable) return h('div.banner.error-box', icon('alert', { size: 18 }), h('span', 'The record of a go-live cannot be read. Nothing goes live until it is looked at.'));
    const order = ['picture', 'update', 'verify', 'again'];
    const at = order.indexOf(s.part);
    return h('section.card.sp-card.sp-step', { 'aria-live': 'polite' },
      focusable(h('h2.sp-title', icon('clock', { size: 18 }), h('span', `Going live with ${s.name}`)), 'step'),
      s.waiting ? h('p', `Waiting for the turns that are still running to end (up to ${s.turnSeconds} seconds) before the restart. Nothing has run yet.`) : null,
      h('ol.sp-parts', order.map((p, i) => h(`li.sp-p-${i < at ? 'done' : i === at ? 'now' : 'wait'}`, icon(i < at ? 'check' : i === at ? 'refresh' : 'clock', { size: 16 }), h('span', PART[p])))),
      s.runningElsewhere ? h('p.hint', 'Another Hoprig runs it. This page shows it when it has ended.') : h('p.hint', 'It goes on if this page is closed or the dashboard restarts.'));
  }

  function lastCard(s) {
    const good = s.outcome === 'live' || (s.outcome === 'taken-back' && s.keptSame === true);
    const canBack = ['not-verified', 'changed', 'update-cut', 'live', 'back-failed', 'back-cut'].includes(s.outcome);
    const title = outcomeTitle(s);
    const results = (s.parts || []).flatMap((p) => (p.results || []).map((r) => h(`li.sp-r-${r.ok ? 'ok' : 'bad'}`, icon(r.ok ? 'check' : 'x', { size: 14 }), h('code', r.shown), h('span.sp-muted', ` ${r.ended}`))));
    return h(`section.card.sp-card.sp-last.sp-last-${good ? 'good' : 'bad'}`, { 'aria-live': 'polite' },
      focusable(h('h2.sp-title', icon(good ? 'check' : 'alert', { size: 18 }), h('span', title)), 'last'),
      s.why ? h('p', s.why) : null,
      canBack && s.outcome !== 'live' && s.before ? h('p', `Take it back to go back to ${s.before}, the commit the project was on before.`) : null,
      s.autoBackFailed ? h('p', `It was not taken back by itself: ${s.autoBackFailed}. Take it back with the press below.`) : null,
      s.changed && s.changed.length ? h('p', 'Files you keep that changed: ', s.changed.map((c, i) => [i ? ', ' : '', h('code', c.path), ` (${c.what})`]), s.more ? ` and ${s.more} more` : '') : null,
      s.outcome === 'taken-back' ? h('p', s.keptSame === false ? 'It was taken back, but files you keep are not as they were before.' : s.keptSame === true ? 'It was taken back. The files you keep are as they were before.' : 'It was taken back. The files you keep were not compared: no picture of them from before the go-live was kept.') : null,
      results.length ? h('details.sp-details', h('summary', 'What ran'), h('ul.sp-results', results)) : null,
      canBack ? h('div.sp-actions', press(s.outcome === 'live' ? 'secondary' : 'primary', 'Take it back', async () => {
        const ok = await openSheet({ title: 'Take it back?', subtitle: v.project }, (close) => [cmdList('This runs now, in the project\'s folder:', s.back || []), h('div.sp-actions', btn('secondary', { label: 'Cancel', onclick: () => close(false) }), btn('primary', { label: 'Take it back', onclick: () => close(true) }))]);
        if (ok) await call('/back', {}, 'Taken back', { focus: 'last' });
      }, 'undo')) : null);
  }

  // ---------- 5. by itself ----------
  function autoCard() {
    const s = v.switches;
    if (!v.live.shown) return null;
    const from = h('input.field.sp-time', { type: 'time', value: auto.from ?? s.from, 'aria-label': 'From', 'data-sp': 'auto-from', oninput: () => (auto.from = from.value) });
    const to = h('input.field.sp-time', { type: 'time', value: auto.to ?? s.to, 'aria-label': 'To', 'data-sp': 'auto-to', oninput: () => (auto.to = to.value) });
    const typed = h('input.field.sp-name', { type: 'text', value: auto.typed, placeholder: v.project, 'aria-label': `Type ${v.project} to turn it on`, autocapitalize: 'off', spellcheck: false, 'data-sp': 'auto-typed', oninput: () => (auto.typed = typed.value) });
    // A press here forgets what was typed; whether the card is open is his to keep.
    const saved = { focus: 'auto-head', ok: () => Object.assign(auto, { typed: '', from: null, to: null }) };
    const card = h('details.card.sp-card.sp-auto', { open: auto.open ?? s.auto, ontoggle: () => (auto.open = card.open) },
      h('summary.sp-title', { 'data-sp': 'auto-head' }, icon('refresh', { size: 18 }), h('span', `Go live by itself: ${s.auto ? `on, ${s.from} to ${s.to}` : 'off'}`)),
      h('p.hint', 'When a check passes, it goes live without your tap: only inside these hours, once per put-together, never for one that also failed, and never while a session\'s turn would be cut. Publishing stays your own press.'),
      h('div.sp-actions.sp-hours', h('label.sp-inline', h('span', 'From'), from), h('label.sp-inline', h('span', 'to'), to)),
      s.auto
        ? h('div.sp-actions', press('secondary', 'Save the hours', () => call('/auto', { from: from.value, to: to.value }, 'Saved', saved)), press('danger', 'Turn it off', () => call('/auto', { on: false }, 'Turned off', saved)))
        : h('div.sp-actions', h('label.sp-inline', h('span', `Type ${v.project} to turn it on`), typed), press('secondary', 'Turn it on', () => call('/auto', { on: true, typed: typed.value.trim(), from: from.value, to: to.value }, 'Turned on', saved))),
      h('label.sp-inline.sp-autoback', h('input', { type: 'checkbox', checked: s.autoBack, 'data-sp': 'auto-back', onchange: (e) => call('/auto', { autoBack: e.target.checked }, null, { focus: 'auto-back' }) }), h('span', 'Take it back by itself when it is not verified')));
    return card;
  }

  start();
  return { refresh: load, stop: () => { alive = false; clearTimeout(timer); } };
}

// ---------- Settings → Go live: the limiter ----------

/**
 * The words typed in the limiter's field → { run } (a list of words) | { error }. They are written as a list, the same
 * as a project's commands: ["nice", "-n", "15"]. Empty means none.
 */
export function limiterInput(text) {
  const t = String(text || '').trim();
  if (!t) return { run: null };
  let v;
  try {
    v = JSON.parse(t);
  } catch {
    return { error: 'Write it as a list of words in quotes, such as ["nice", "-n", "15"].' };
  }
  if (!Array.isArray(v) || !v.length || v.some((w) => typeof w !== 'string' || !w)) return { error: 'Write it as a list of words in quotes, such as ["nice", "-n", "15"].' };
  return { run: v };
}

function limiterPage() {
  const box = h('div.sp-settings', skeletonRows(2));
  const paint = (lim) => {
    const field = h('textarea.field', { rows: 2, id: 'sp-limiter', 'aria-describedby': 'sp-limiter-hint', spellcheck: 'false', value: lim.run ? JSON.stringify(lim.run) : '' });
    field.value = lim.run ? JSON.stringify(lim.run) : '';
    const err = h('p.hint.err', { role: 'alert' });
    const save = async () => {
      const r = limiterInput(field.value);
      if (r.error) return fill(err, r.error);
      fill(err);
      if (!r.run) {
        if (!lim.run) return;
        paint(await api('/api/ship/limiter', { run: null }));
        return toast('No limiter: checks run as they are');
      }
      const shown = r.run.map((w) => (/^[A-Za-z0-9_./:=@%+,{}~-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`)).join(' ');
      const ok = await openSheet({ title: 'Run every check through this?', subtitle: 'The limiter' }, (close) => [
        h('p.sheet-text', 'Every check command will run behind these words, on this computer, as you:'),
        h('p', h('code', `${shown} <the check command>`)),
        h('p.hint', 'Your yes covers these words. A change to them asks again.'),
        h('div.sp-actions', btn('secondary', { label: 'Cancel', onclick: () => close(false) }), btn('primary', { label: 'Confirm', onclick: () => close(true) })),
      ]);
      if (ok !== true) return;
      try {
        paint(await api('/api/ship/limiter', { run: r.run, seen: shown }));
        toast('Confirmed: checks run through the limiter');
      } catch (e) {
        fill(err, e.message);
      }
    };
    fill(box, panel({ icon: 'clock', title: 'The limiter', desc: 'A program every check runs behind, so that checks share the computer with your other heavy work. Leave it empty to run checks as they are (one at a time, at low priority).' },
      h('label.field-label', { for: 'sp-limiter' }, 'Words before each check command'),
      field,
      h('p.hint', { id: 'sp-limiter-hint' }, 'A list of words, such as ["nice", "-n", "15"] or ["bash", "/path/to/limit.sh"]. They run without a shell.'),
      lim.run ? h('p.hint', lim.confirmed ? 'Confirmed on this computer: ' : 'Not confirmed yet (checks wait until it is): ', h('code', lim.shown)) : null,
      err,
      h('div.sp-actions', btn('primary', { label: lim.run && !lim.confirmed ? 'Look at it and confirm' : 'Save', onclick: save }))));
  };
  api('/api/ship/limiter').then(paint, (e) => fill(box, errorBox(`Could not load the limiter: ${e.message}`, () => fill(box, limiterPage()))));
  return box;
}
registerSettingsPage({
  id: 'golive', title: 'Go live', icon: 'zap', order: 19,
  desc: 'How the checks of Work → Go live share this computer: a limiter every check runs behind.',
  summary: () => '', render: limiterPage,
});
