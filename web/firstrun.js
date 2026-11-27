// Home on a new install (the first-run design): ONE card of two steps instead of the empty Home. Step 1 signs in to
// Claude (found already done when Claude Code is signed in on this computer); step 2 starts the first chat, in a new
// folder (New project) or in the person's own. It goes for good when the first chat exists: the server marks it done
// (POST /api/onboarding/first-chat sets server.getStartedDismissed) and a chat is a session on Home.
import { claudeSignIn } from './claudelogin.js';
import { markFirstChat } from './chat/firstchat.js';
import { icon } from './icons.js';
import { api, btn, h, toast } from './lib.js';

/** The words of the card (a test holds them). */
export const FIRST_WORDS = {
  title: 'Welcome to Hoprig',
  signIn: 'Sign in to Claude',
  signedIn: 'Signed in to Claude',
  signInButton: 'Sign in',
  paid: 'No Claude plan? Pay as you use',
  start: 'Start your first chat',
  project: 'New project',
  own: 'My own folder',
};

/**
 * Whether Home shows the first-run card: the checklist is there, this dashboard is not a hub, the card was not closed
 * (or marked done by a first chat) and this computer has no session at all.
 */
export const isFirstRun = ({ onb, hub, dismissed, sessions }) => !!(onb && Array.isArray(onb.steps) && !hub && !dismissed && sessions === 0);

/** Step 1 as the server lists it: { done, action }. */
export const signInStep = (onb) => {
  const s = onb && Array.isArray(onb.steps) ? onb.steps.find((x) => x.id === 'claude') : null;
  return { done: !!(s && s.done), action: s && !s.done ? s.action : null };
};

/** New project: the folder is made by the server, then the chat opens in it. */
export async function newProject() {
  try {
    const { dir } = await api('~/api/onboarding/first-chat', {});
    markFirstChat();
    await (await import('./chat/start.js')).startChat(dir, {});
  } catch (e) {
    toast(e, { kind: 'error' });
  }
}

/** The card. `o`: { refresh(), run(action) (the checklist's own way to install Claude Code), onDismiss() }. */
export function firstRunCard(onb, o = {}) {
  const one = signInStep(onb);
  const w = FIRST_WORDS;
  const mark = (done) => h('span.gs-mark', done ? icon('check', { size: 14 }) : h('span.gs-dot'));
  const signIn = h('li.gs-step' + (one.done ? '.done' : '.next'),
    mark(one.done),
    h('span.gs-body', h('span.gs-title', one.done ? w.signedIn : w.signIn),
      one.done ? null : h('a.gs-paid', { href: '#', onclick: (e) => { e.preventDefault(); claudeSignIn({ done: o.refresh, console: true }); } }, w.paid)),
    one.done ? null : h('button.btn.small.primary', { type: 'button', onclick: () => (one.action && one.action.kind === 'install-claude' && o.run ? o.run(one.action) : claudeSignIn({ done: o.refresh })) },
      one.action && one.action.kind === 'install-claude' ? one.action.label || 'Install Claude Code' : w.signInButton));
  const start = h('li.gs-step' + (one.done ? '.next' : ''),
    mark(false),
    h('span.gs-body', h('span.gs-title', w.start)),
    h('span.gs-buttons',
      btn(one.done ? 'primary.small' : 'secondary.small', { label: w.project, onclick: newProject }),
      btn('secondary.small', { label: w.own, onclick: async () => (await import('./newsession-popup.js')).openNewSession() })));
  return h('section.getstarted.firstrun', { 'aria-label': w.title },
    h('header.gs-head', h('h2.gs-heading', w.title),
      h('button.btn.icon.ghost.small', { type: 'button', title: 'Close', 'aria-label': 'Close', onclick: o.onDismiss }, icon('x', { size: 16 }))),
    h('ol.gs-steps', signIn, start));
}
