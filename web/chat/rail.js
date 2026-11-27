// The session details beside the chat on a wide screen, as the Claude Code desktop app's session rail: cards that
// say where the session runs (Where it works: computer, folder, provider, branch), what it changed (Changes: +N −M,
// opens the editor's Changes), how full its context is (Context: the percent; opened, what fills it). The
// background tasks are not here: they are a part above the box (agents.js). "Hide session rail" / "Show session rail" in the
// title bar and the more menu, remembered in this browser. A card with nothing true to say is left out (a coding
// tool that does not say its context, a folder that is no git repository, an older computer that has no route for
// it). Narrower screens and phones have no rail: the status line and the agents strip say these things there.
import { icon } from '../icons.js';
import { api, chooseSheet, confirmSheet, copyText, errorWords, fill, h, toast } from '../lib.js';
import { place } from './agents.js';
import { CONTEXT_SAID, billed, caps, contextPercent, hasPlan, inFolder, kilo, limitsLine, money, toolWord } from './words.js';
import { partsCard } from './parts.js';


const RAIL_KEY = 'chat.rail'; // "off" when the owner hid it
export const RAIL_MIN_PX = 1100; // the width from which the rail shows (rail.css says the same)

/** Whether the owner hid the rail (in this browser). */
export function railHidden() {
  try {
    return localStorage.getItem(RAIL_KEY) === 'off';
  } catch {
    return false;
  }
}
/** The screen is wide enough for the rail (asked each time). */
export const railFits = () => typeof matchMedia !== 'undefined' && matchMedia(`(min-width: ${RAIL_MIN_PX}px)`).matches;

/** "provider" in plain words, said once beside the Provider row (the same words as Get started's). */
export const PROVIDER_SAID = 'The AI account this chat runs on (a Claude subscription, an API key, a gateway).';

/** The Environment card's rows: [label, text]. o: { computer (its name), view (the transcript view) } */
export function environmentRows(v, { computer = 'This computer', view = 'normal' } = {}) {
  const lim = hasPlan(v) ? limitsLine(v.limits) : '';
  return [
    ['Computer', computer],
    v.cwd ? ['Folder', v.short || v.cwd] : null,
    v.engine && v.engine.id && v.engine.id !== 'claude' ? ['Coding tool', v.engine.label || v.engine.id] : null,
    v.profile ? ['Provider', v.profile.label] : null,
    v.branch ? ['Branch', v.branch] : null,
    lim ? ['Plan usage', lim] : null,
    // Dollars only in the Verbose view and only for a provider billed by use (a subscription's mislead).
    view === 'verbose' && billed(v) && Number.isFinite(v.costTotal) && v.costTotal > 0 ? ['Cost so far', money(v.costTotal)] : null,
  ].filter(Boolean);
}

/** Copy branch name, as the desktop app's branch name does on a click (the rail, the status line, the session menu). */
export async function copyBranch(name) {
  if (await copyText(name)) toast(`Copied: ${name}`);
  else toast(`The browser did not let the page copy. The branch is ${name}`, { kind: 'error', ms: 8000 });
}

// What the Create PR button and Auto-fix say to the coding tool, fixed words (the desktop app's way: the tool commits and pushes, there is no commit box).
export const CREATE_PR_MESSAGE = 'Commit my changes, push the branch, and open a pull request with gh. Tell me its link when it is open.';
export const autoFixMessage = (n) => `The checks of pull request #${n} are failing. Look at them with gh pr checks, fix what fails, commit and push.`;
export const CHECKS_SAID = { passing: 'Checks passing', failing: 'Checks failing', running: 'Checks running' };

const lines = (n) => `${n} line${n === 1 ? '' : 's'}`;
const BACK_MS = 5000; // the tab came back: the changes are asked at most this often

/**
 * What the page's events (stream.js: { reset, events }) tell the rail: 'turn' (a turn ended), 'changed' (the folder
 * may have changed: a tool ran, a notice such as a rewind of files, a reconnect that drew everything again) or null.
 */
export function folderNews(r) {
  const kinds = new Set((r.events || []).map((x) => x.kind));
  if (r.reset) return 'changed';
  if (kinds.has('turn-end')) return 'turn';
  return kinds.has('tool-result') || kinds.has('notice') ? 'changed' : null;
}

/**
 * o: { A (the chat's API path), view() (the transcript view), computer() (the computer's name), changes() (open the editor's Changes), providers() (the provider menu), onToggle(hidden),
 * clock() (tests) }
 * → { el, paint(v), hidden(), toggle(), changed(), turnEnded(), stop() }
 */
export function createRail(o) {
  const parts = partsCard(o); // Lead model: who did what
  let v = null;
  let hidden = railHidden();
  const env = h('dl.chat-rail-rows');
  const envCard = h('section.chat-rcard', h('h2.chat-rcard-head', h('span', 'Where it works')), env);
  const changesBody = h('div.chat-rcard-body');
  const changesCount = h('span.chat-rcard-end');
  const changesCard = h('section.chat-rcard.hidden', h('h2.chat-rcard-head', h('span', 'Changes'), changesCount), changesBody);
  const ctxPct = h('span.chat-rcard-end');
  const ctxBody = h('div.chat-rcard-body');
  const ctxCard = h('details.chat-rcard.chat-rcard-fold.hidden', h('summary.chat-rcard-head', { title: CONTEXT_SAID, 'aria-label': CONTEXT_SAID }, icon('chevronRight', { size: 14 }), h('span', 'Context'), ctxPct), ctxBody);
  const el = h('aside.chat-rail', { 'aria-label': 'Session details' }, envCard, parts.el, changesCard, ctxCard);

  // ---------- Changes: asked of the server when the session opens and after each turn or tool ----------
  let lastC = null; // the last Changes answer
  let pr = null; // the last answer of GET /pr: { remote, ahead, gh, pr }; asked after a turn and when the rail opens, never on a timer
  let wantPr = true;
  let changesNone = false; // an older computer without the route: the card stays out for the life of the page
  let loading = null;
  let again = false;
  // One question at a time; news while it is asked asks once more after it.
  function loadChanges() {
    if (stopped || changesNone || hidden || !railFits()) return;
    if (loading) {
      again = true;
      return;
    }
    loading = askChanges().finally(() => {
      loading = null;
      if (again) {
        again = false;
        loadChanges();
      }
    });
  }
  // +N −M as the desktop app's card says it (a new file's lines count as added), and as there a click on it opens
  // the changes; nothing counted (only binary new files): no "+0 −0". Then the pull request: its line when there is
  // one, else Create PR when the folder has a remote and something to send.
  function drawChanges() {
    const c = lastC;
    if (!c) return;
    const open = pr && pr.pr;
    fill(changesCount, c.added || c.removed ? h('button.chat-rcard-count', { type: 'button', title: 'Open the changes', 'aria-label': `${lines(c.added)} added, ${c.removed} removed: open the changes`, onclick: () => o.changes() },
      h('span.chat-plus', `+${c.added}`), ' ', h('span.chat-minus', `−${c.removed}`)) : '');
    const canCreate = o.send && pr && pr.gh && pr.remote && !open && (c.files > 0 || pr.ahead !== 0);
    fill(changesBody, c.files
      ? [h('button.btn.small.ghost.chat-rail-link', { type: 'button', onclick: () => o.changes() }, `${c.files === 1 ? '1 file' : `${c.files} files`} changed${c.untracked ? ` (${c.untracked} new)` : ''}`, icon('chevronRight', { size: 14 })),
        h('ul.chat-rail-files', c.list.slice(0, 6).map((f) => h('li', h('span.chat-rail-file', inFolder(f.path, '')), f.new ? h('span.chat-rail-new', 'new') : h('span.chat-rail-n', `+${f.added} −${f.removed}`))))]
      : h('p.chat-hint', 'No changes yet since the last save point.'),
    open ? prLine(pr.pr) : null,
    canCreate ? createButton() : null);
  }
  const createButton = () => h('button.btn.small.secondary.chat-rail-create', { type: 'button', title: 'Ask the coding tool to commit, push the branch and open a pull request', onclick: async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      await o.send(CREATE_PR_MESSAGE);
    } catch (err) {
      toast(`The message did not go: ${errorWords(err) || 'try again'}`, { kind: 'error' });
    } finally {
      b.disabled = false;
    }
  } }, icon('git', { size: 14 }), h('span', 'Create PR'));
  function prLine(p) {
    const said = CHECKS_SAID[p.checks] || '';
    const label = `Pull request #${p.number} ${p.title}${said ? `, ${said.toLowerCase()}` : ''}: open its menu`;
    return h('div.chat-rail-pr',
      h('button.btn.small.ghost.chat-rail-link.chat-rail-prtitle', { type: 'button', title: p.title, 'aria-label': label, onclick: () => prMenu(p) },
        h('span.chat-rail-prtext', `#${p.number} ${p.title}`), icon('chevronDown', { size: 12 })),
      said ? h(`p.chat-rail-checks.chat-pr-${p.checks}`, h('span.chat-pr-dot', { 'aria-hidden': 'true' }), said) : null);
  }
  async function prMenu(p) {
    const pick = await chooseSheet({ title: `#${p.number} ${p.title}`, subtitle: CHECKS_SAID[p.checks] || 'Pull request', items: [
      { value: 'open', label: 'Open', sub: 'The pull request on the web, in a new tab', icon: 'external', disabled: !p.url },
      { value: 'fix', label: 'Auto-fix', sub: p.checks === 'failing' ? 'Ask the coding tool to fix the failing checks' : 'For when the checks fail', icon: 'zap', disabled: p.checks !== 'failing' || !o.send },
      { value: 'merge', label: 'Merge when ready', sub: 'Squash and merge as soon as the checks pass', icon: 'git' },
    ] });
    if (pick === 'open' && p.url) window.open(p.url, '_blank', 'noopener');
    else if (pick === 'fix') {
      try {
        await o.send(autoFixMessage(p.number));
      } catch (err) {
        toast(`The message did not go: ${errorWords(err) || 'try again'}`, { kind: 'error' });
      }
    } else if (pick === 'merge') {
      // Others see a merge: it is never one press.
      if (!(await confirmSheet({ title: `Merge #${p.number} when ready?`, text: 'The pull request is squashed into its base branch as soon as its checks pass. Other people who work on this repository will see it.', ok: 'Merge when ready' }))) return;
      try {
        await api(`${o.A}/pr/merge`, { confirm: true, number: p.number });
        toast(`#${p.number} will merge when its checks pass`);
      } catch (err) {
        toast(`Not merged: ${errorWords(err) || 'try again'}`, { kind: 'error', ms: 8000 });
      }
    }
  }
  // The pull request of this branch (gh, on the session's computer). An older computer without the route has none.
  async function askPr() {
    try {
      const r = await api(`${o.A}/pr`);
      pr = r && typeof r === 'object' ? r : null;
    } catch {
      pr = null;
    }
    drawChanges();
  }
  async function askChanges() {
    try {
      const c = await api(`${o.A}/changes`);
      if (!c || !c.git) {
        changesCard.classList.add('hidden');
        return;
      }
      changesCard.classList.remove('hidden');
      lastC = c;
      drawChanges();
      if (wantPr) {
        wantPr = false;
        askPr(); // not waited for: gh may take seconds, and the next change is drawn meanwhile
      }
    } catch (e) {
      // No such route (the server's own "not found"): the computer is on an older Hoprig, not asked again. Any other
      // failure (this session not open for a moment, the connection) hides the card until the next news.
      if (e && e.status === 404 && e.data && e.data.error === 'not found') changesNone = true;
      changesCard.classList.add('hidden');
    }
  }

  // ---------- Context: the percent; opened, what fills it (asked of the running coding tool) ----------
  async function loadContext() {
    if (!v || !caps(v).usage || !v.running) return paintContext();
    try {
      const r = await api(`${o.A}/usage`);
      if (r && r.usage) v = { ...v, usage: r.usage };
    } catch {
      /* not running any more: what is known stays */
    }
    paintContext();
  }
  ctxCard.addEventListener('toggle', () => ctxCard.open && loadContext());
  // The window grew wide enough (or the rail came back): drawn now, not at the next news. Only while the page is
  // open: stop() removes the listener (a page left behind would ask git again at every change of the width).
  let stopped = false;
  const wide = typeof matchMedia !== 'undefined' ? matchMedia(`(min-width: ${RAIL_MIN_PX}px)`) : null;
  const onWide = (e) => e.matches && v && !stopped && rail.paint(v, true);
  wide?.addEventListener?.('change', onWide);
  // Back to the tab (or the window): what was changed outside a tool (the editor, a terminal) shows, at most every
  // few seconds.
  const clock = o.clock || Date.now;
  let backAt = 0;
  const onBack = () => {
    if (!v || document.visibilityState === 'hidden' || clock() - backAt < BACK_MS) return;
    backAt = clock();
    loadChanges();
  };
  document.addEventListener('visibilitychange', onBack);
  window.addEventListener('focus', onBack);
  function paintContext() {
    const u = (v && v.usage) || {};
    const p = contextPercent(u);
    // A coding tool that does not say how full its context is gets no card (never an empty box).
    ctxCard.classList.toggle('hidden', p === null);
    if (p === null) return;
    fill(ctxPct, `${p}%`);
    const cats = Array.isArray(u.contextCategories) ? u.contextCategories : [];
    const total = Number.isFinite(u.contextWindow) && u.contextWindow > 0 ? u.contextWindow : null;
    fill(ctxBody,
      h('div.chat-rail-bar', { role: 'img', 'aria-label': `${p}% of the context used` }, h('span', { style: { width: `${Math.min(100, p)}%` } })),
      Number.isFinite(u.contextUsed) ? h('p.chat-hint', `${kilo(u.contextUsed)} of ${kilo(u.contextWindow || 0)} tokens`) : null,
      cats.length ? h('dl.chat-rail-rows', cats.map((c) => [h('dt', c.name), h('dd', `${kilo(c.tokens)}${total ? ` · ${Math.round((c.tokens / total) * 1000) / 10}%` : ''}`)])) : caps(v).usage ? h('p.chat-hint', v.running ? 'Open again for what fills it.' : `What fills it is known while ${toolWord(v)} runs.`) : null);
  }

  // Each Environment row is kept by its name: what changes is written into it, a new one is put in its place, and one
  // that stays is never taken out of the page (every state update paints the rail, and a control taken out loses the
  // keyboard's focus: the Provider link). The background tasks are the part above the box (agents.js).
  const envRows = new Map(); // label → { nodes: [dt, dd], text, set(text) }
  function envRow(k) {
    const dt = h('dt', k);
    if (k === 'Provider') {
      // "provider" said in plain words where a newcomer meets it in the chat: in the row's tooltip (not as a block of text).
      dt.setAttribute('title', PROVIDER_SAID);
      const label = h('span');
      const btn = h('button.btn.small.ghost.chat-rail-link', { type: 'button', title: `${PROVIDER_SAID} Continue on another provider`, onclick: () => o.providers() }, label, icon('chevronDown', { size: 12 }));
      const dd = h('dd', btn);
      return { nodes: [dt, dd], set: (x) => {
        fill(label, x);
        btn.setAttribute('aria-label', `Provider ${x}: ${PROVIDER_SAID} Continue on another provider`);
      } };
    }
    if (k === 'Branch') {
      let now = '';
      const label = h('span.chat-chip-label');
      const btn = h('button.btn.small.ghost.chat-rail-link.chat-branch', { type: 'button', title: 'Copy branch name', onclick: () => copyBranch(now) }, label, icon('copy', { size: 12 }));
      return { nodes: [dt, h('dd', btn)], set: (x) => {
        now = x;
        fill(label, x);
        btn.setAttribute('aria-label', `Copy branch name ${x}`);
      } };
    }
    const dd = h('dd');
    return { nodes: [dt, dd], set: (x) => {
      fill(dd, x);
      dd.setAttribute('title', x);
    } };
  }
  function paintEnv() {
    const rows = environmentRows(v, { computer: o.computer(), view: o.view() });
    for (const k of [...envRows.keys()]) if (!rows.some(([name]) => name === k)) envRows.delete(k);
    place(env, rows.flatMap(([k, x]) => {
      let row = envRows.get(k);
      if (!row) envRows.set(k, (row = envRow(k)));
      if (row.text !== x) row.set((row.text = x));
      return row.nodes;
    }));
  }

  const rail = {
    el,
    hidden: () => hidden,
    toggle() {
      hidden = !hidden;
      try {
        localStorage.setItem(RAIL_KEY, hidden ? 'off' : 'on');
      } catch {
        /* a private window: for this page only */
      }
      o.onToggle?.(hidden);
      if (!hidden && v) rail.paint(v, true);
    },
    paint(state, force = false) {
      const first = !v;
      v = state;
      if (hidden || !railFits()) return; // nothing drawn that nobody sees; drawn again when it shows
      paintEnv();
      paintContext();
      if (first || force) {
        wantPr = true;
        loadChanges();
        parts.load(v);
      }
    },
    /** The page went: nothing more is asked or drawn. */
    stop() {
      stopped = true;
      wide?.removeEventListener?.('change', onWide);
      document.removeEventListener('visibilitychange', onBack);
      window.removeEventListener('focus', onBack);
    },
    /** A tool ran, a notice came, the events were drawn again (folderNews): the folder may have changed. */
    changed: () => v && loadChanges(), // before the first state its paint asks
    /**
     * A turn ended: the folder may have changed, and the Context card, while it is open, asks again what fills the
     * context (the parts it shows were of the size before the turn).
     */
    turnEnded() {
      wantPr = true;
      loadChanges();
      parts.load(v);
      if (ctxCard.open) loadContext();
    },
  };
  return rail;
}
