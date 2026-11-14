// Home → "Get started": the steps a new owner goes through (GET /api/onboarding, src/setup/onboarding.mjs), as a
// compact checklist. Done steps are ticked and quiet, the next one is prominent with its one button, optional ones
// wait under "Later". Once every required step is done it shrinks to one line; closing it is remembered on the
// server (server.getStartedDismissed), so it stays closed on the phone too.
import { icon } from './icons.js';
import { api, fill, h, link, toast } from './lib.js';
import { gitDone, gitRows, openGitSetup } from './gitsetup.js';
import { store } from './store.js';

/** Where a "page" action leads. */
export const TARGETS = {
  'pc/setup': '#/computer/setup',
  'pc/projects': '#/workspace',
  'settings/skills': '#/skills',
  'settings/signin-device': '#/settings/security',
  'settings/accounts': '#/providers',
  'settings/computers': '#/computers',
};

export const PITCH = 'Install it on a fresh computer and it sets everything up; on a computer that already has things, it shows what is there and sets up what is missing.';

/**
 * A hub (`hoprig setup --hub`: a small server that links the owner's computers and codes on none) gets its own short
 * checklist instead of the coding one: it is reachable, a first computer joined, the phone signed in. `onb` is the
 * server's checklist (its "phone" step is reused), `ctx`: { https, joined }. The same shape as GET /api/onboarding.
 */
export function hubOnboarding(onb, { https, joined }) {
  const phone = onb && Array.isArray(onb.steps) ? onb.steps.find((s) => s.id === 'phone') : null;
  const steps = [
    { id: 'reachable', title: 'This hub is reachable', done: !!https, optional: false,
      detail: https ? 'Open over HTTPS at its own address.' : 'Open it at its HTTPS address; the setup of the hub gives it one.', action: https ? null : { kind: 'page', target: 'settings/security' } },
    { id: 'computer', title: 'A first computer joined', done: !!joined, optional: false,
      detail: joined ? '' : 'Add the computer you code on: its sessions then show here.', action: { kind: 'page', target: 'settings/computers' } },
    { id: 'phone', title: phone ? phone.title : 'Your phone signed in', done: !!(phone && phone.done), optional: false,
      detail: phone ? phone.detail : '', action: phone ? phone.action : { kind: 'page', target: 'settings/signin-device' } },
  ];
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length };
}

/** True when this dashboard is a hub: marked by its setup, or (an older setup) no Claude Code here and others linked. */
/**
 * The coding checklist with the Git and GitHub step added (GET /api/workspace/git `g`; null: an older computer, the
 * list as the server gave it). It comes after the server's steps; its button opens the guided terminal step.
 */
export function withGitStep(onb, g) {
  if (!onb || !Array.isArray(onb.steps) || !g || onb.steps.some((s) => s.id === 'git')) return onb;
  const done = gitDone(g);
  const step = { id: 'git', title: 'Git and GitHub set up', optional: false, done,
    detail: done ? `signed in as ${g.gh.account}` : gitRows(g).filter((r) => !r.ok).map((r) => `${r.title.toLowerCase()}: ${r.text.toLowerCase()}`).join('; '),
    action: done ? null : { kind: 'git' } };
  return { ...onb, steps: [...onb.steps, step], done: (onb.done ?? onb.steps.filter((s) => !s.optional && s.done).length) + (done ? 1 : 0), total: (onb.total ?? onb.steps.filter((s) => !s.optional).length) + 1 };
}

export function isHub(own, onb, computers) {
  if (own && own.hub) return true;
  const claude = onb && Array.isArray(onb.steps) ? onb.steps.find((s) => s.id === 'claude') : null;
  return !!(claude && !claude.done && /not installed/i.test(claude.detail || '') && computers > 1);
}

/**
 * What to show. mode: "hidden" (closed by the owner, or nothing to show), "open" (a required step is missing) or
 * "collapsed" (every required step done). `next` is the first required step not done.
 */
export function planGetStarted(onb, { dismissed = false } = {}) {
  if (!onb || !Array.isArray(onb.steps) || !onb.steps.length) return { mode: 'hidden', steps: [], later: [], next: null, done: 0, total: 0, claudeReady: false };
  const steps = onb.steps.filter((s) => !s.optional);
  const later = onb.steps.filter((s) => s.optional);
  const next = steps.find((s) => !s.done) || null;
  const done = Number.isInteger(onb.done) ? onb.done : steps.filter((s) => s.done).length;
  const total = Number.isInteger(onb.total) ? onb.total : steps.length;
  const claude = onb.steps.find((s) => s.id === 'claude');
  return {
    mode: dismissed ? 'hidden' : next ? 'open' : 'collapsed',
    steps, later, next, done, total,
    claudeReady: !!(claude && claude.done),
  };
}

/** The label of a step's one button. */
export function actionLabel(a) {
  if (!a) return null;
  if (a.kind === 'terminal') return a.label || 'Open a terminal';
  if (a.kind === 'git') return 'Set up git and GitHub';
  if (a.kind === 'request') return 'Do it';
  return 'Open';
}

/** Run a step's action: open a part of the page, a terminal session, or call a route. */
export async function runAction(a, after) {
  try {
    if (a.kind === 'git') await openGitSetup();
    else if (a.kind === 'page') location.hash = link(TARGETS[a.target] || '#/settings');
    else if (a.kind === 'terminal') {
      const r = await api('~/api/onboarding/run', { run: a.run });
      location.hash = `#/s/${encodeURIComponent(r.session)}`;
    } else if (a.kind === 'request') {
      await api(`~${a.path}`, a.body || {}, a.method || 'POST');
      toast('Done');
      after?.();
    }
  } catch (e) {
    toast(e.message, { kind: 'error' });
  }
}

/** The checklist card, or null. `opts`: { dismissed, expanded, onDismiss, onToggle, refresh, firstRun }. */
export function getStartedCard(onb, opts = {}) {
  const p = planGetStarted(onb, { dismissed: opts.dismissed });
  if (p.mode === 'hidden') return null;
  const close = h('button.btn.icon.ghost.small', { type: 'button', title: 'Close Get started', 'aria-label': 'Close Get started', onclick: opts.onDismiss }, icon('x', { size: 16 }));
  if (p.mode === 'collapsed' && !opts.expanded) {
    return h('section.getstarted.collapsed', { 'aria-label': 'Get started' },
      h('span.gs-tick', icon('check', { size: 16 })),
      h('span.gs-line', h('strong', 'Set up'), ` · all ${p.total} done`),
      p.later.length ? h('button.btn.small.ghost', { type: 'button', onclick: opts.onToggle }, `Later (${p.later.filter((s) => !s.done).length})`) : null,
      close);
  }
  const step = (s) => {
    const isNext = p.next && s.id === p.next.id;
    return h(`li.gs-step${s.done ? '.done' : ''}${isNext ? '.next' : ''}`,
      h('span.gs-mark', s.done ? icon('check', { size: 14 }) : h('span.gs-dot')),
      h('span.gs-body',
        h('span.gs-title', s.title),
        s.detail && (isNext || !s.done) ? h('span.gs-detail', s.detail) : null),
      !s.done && s.action && (isNext || s.optional)
        ? h(`button.btn.small${isNext ? '.primary' : '.secondary'}`, { type: 'button', onclick: () => runAction(s.action, opts.refresh) }, actionLabel(s.action))
        : null);
  };
  const head = h('header.gs-head',
    h('h2.gs-heading', 'Get started', h('span.gs-count', ` · ${p.done} of ${p.total}`)),
    p.mode === 'collapsed' ? h('button.btn.small.ghost', { type: 'button', onclick: opts.onToggle }, 'Less') : null,
    close);
  const meter = h('div.gs-meter', { role: 'progressbar', 'aria-label': 'Steps done', 'aria-valuemin': 0, 'aria-valuemax': p.total, 'aria-valuenow': p.done }, h('i', { style: { width: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%` } }));
  // Some steps done: only the next one, so the sessions stay in view; the rest opens in place.
  if (p.mode === 'open' && p.done > 0 && !opts.expanded) {
    return h('section.getstarted.compact', { 'aria-label': 'Get started' },
      head, meter,
      h('ol.gs-steps', step(p.next)),
      h('button.gs-more', { type: 'button', onclick: opts.onToggle }, `Show all ${p.total} steps`));
  }
  return h('section.getstarted', { 'aria-label': 'Get started' },
    head,
    opts.firstRun && (opts.expanded || p.done === 0) ? h('p.gs-pitch', PITCH) : null,
    meter,
    h('ol.gs-steps', p.steps.map(step)),
    p.later.length
      ? h('details.gs-later', { open: p.mode === 'collapsed' },
        h('summary', `Later · ${p.later.length} optional`),
        h('ol.gs-steps', p.later.map(step)))
      : null,
    p.mode === 'open' && p.done > 0 ? h('button.gs-more', { type: 'button', onclick: opts.onToggle }, 'Show less') : null);
}

/** Home's "Get started" area: loads the steps, keeps them fresh while Home is open. Returns { el, stop }. */
export function getStartedArea({ firstRun = () => false, onChange = () => {} } = {}) {
  const el = h('div.gs-area');
  let onb = null;
  let expanded = false;
  let timer = null;
  let stopped = false;
  const own = () => store.all.find((m) => m.machine === null) || null;
  const dismissed = () => !!(own() && own().getStartedDismissed);
  const hub = () => isHub(own(), onb, store.all.length);
  // On a hub the checklist is the hub's own (hubOnboarding); elsewhere the coding one from the server.
  let git = null; // GET /api/workspace/git, for the Git and GitHub step
  const steps = () => (onb && hub() ? hubOnboarding(onb, { https: location.protocol === 'https:', joined: store.all.length > 1 }) : withGitStep(onb, git));
  const paint = () => {
    fill(el, getStartedCard(steps(), {
      dismissed: dismissed(),
      expanded,
      firstRun: firstRun() && !hub(),
      refresh: load,
      onToggle: () => {
        expanded = !expanded;
        paint();
      },
      onDismiss: async () => {
        try {
          await api('~/api/settings', { server: { getStartedDismissed: true } });
          await store.refresh();
          toast('Closed. Settings → About and updates brings it back.');
        } catch (e) {
          toast(e.message, { kind: 'error' });
        }
        paint();
        onChange();
      },
    }));
    onChange();
  };
  async function load() {
    clearTimeout(timer);
    try {
      [onb, git] = await Promise.all([api('~/api/onboarding'), api('~/api/workspace/git').catch(() => null)]);
    } catch {
      onb = null; // another dashboard's token, an old server: no checklist
    }
    if (stopped) return;
    paint();
    timer = setTimeout(load, 60_000);
  }
  load();
  // Closed on another device, or the state arrived after the steps: draw again when "dismissed" changes.
  let was = '';
  const unsubscribe = store.subscribe(() => {
    const now = JSON.stringify([dismissed(), hub(), store.all.length]);
    if (now !== was) {
      was = now;
      if (onb) paint();
    }
  });
  return { el, repaint: paint, plan: () => planGetStarted(steps(), { dismissed: dismissed() }), stop: () => { stopped = true; clearTimeout(timer); unsubscribe(); } };
}
