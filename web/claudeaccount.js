// The Claude account behind Claude Code's stored sign-in, from the page (src/server/claudelogin.mjs): who is signed
// in, sign out, and sign in with another account. The last one is what a usage limit is for: the work goes on under
// the same provider with the other account, and the sessions that stood at the limit continue.
//
// Offered where a limit shows (a session's and a chat's limit card, Home's line about the providers, Providers) and
// on the provider's own page. Only on this dashboard's own computer: a sign-in never goes through another
// computer's page.
import { claudeSignIn } from './claudelogin.js';
import { icon } from './icons.js';
import { REPO_URL } from './brand.js';
import { add, api, btn, fill, h, limitActions, machine, openSheet, toast } from './lib.js';
import { errorBox } from './shell.js';
import { store } from './store.js';

const R = (p = '') => `~/api/accounts/claude-login${p}`; // always this dashboard's own computer
const PLAN = (p) => p.charAt(0).toUpperCase() + p.slice(1);
const RECENT_MS = 6 * 3600 * 1000;

/** A provider that uses Claude Code's stored sign-in (not an account token of its own, not an API key). */
export const usesStoredLogin = (p) => !!p && p.kind === 'login';
/** A session, chat or provider of this dashboard's own computer. */
const onThisComputer = (x) => ('machine' in x ? x.machine : machine.current) === null;
const own = () => store.all.find((m) => m.machine === null) || { sessions: [], profiles: [], autoSwitch: {} };
const nameOf = (s) => s.display || s.name;

/** Who is signed in: { loggedIn, plan, email, org }. Asked from Claude Code; for the owner's eyes only. */
export const loadAccount = (fresh = false) => api(R(`/account${fresh ? '?fresh=1' : ''}`));

/** "name@example.com · Organisation · Max", as far as Claude Code tells. */
export const accountText = (a) => [a.email, a.org, a.plan ? PLAN(a.plan) : null].filter(Boolean).join(' · ');

/** The sessions and chats of this computer that run on the stored sign-in (an Auto session: while it is served by it). */
export function onStoredLogin(sessions = own().sessions, profiles = own().profiles) {
  const stored = new Set(profiles.filter(usesStoredLogin).map((p) => p.name));
  return sessions.filter((s) => s.profile && (stored.has(s.profile.name) || (s.autoOn && stored.has(s.autoOn.name))));
}
const atLimit = (s) => !!(s.limit || s.runLimit);
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Let a session that stands at its limit go on, on the provider it is on. A chat gets the continue message; a
 * terminal session gets it typed, unless a menu is open on its screen (typing would answer the menu): then nothing
 * is typed and { menu: true } comes back, and `restart` starts the conversation again in place, then continues.
 */
export async function continueHere(s, { restart = false } = {}) {
  if (s.kind === 'chat') {
    await api(`~/api/chats/${s.chatId}/send`, { text: own().autoSwitch.prompt || 'Continue from where you stopped.' });
    return { ok: true };
  }
  return api(`~/api/sessions/${encodeURIComponent(s.name)}/continue`, restart ? { restart: true } : {});
}

/** One line per session that was asked to go on: what happened, and the restart where a menu was in the way. */
function continueRow(s) {
  const out = h('span.row-sub', 'Continuing…');
  const row = h('div.row.static', h('span.row-icon', icon(s.kind === 'chat' ? 'text' : 'terminal')), h('span.row-main', h('span.row-title', nameOf(s)), out));
  const go = async (restart) => {
    try {
      const r = await continueHere(s, { restart });
      if (r.ok) return fill(out, restart ? 'Restarted; it goes on with the new account.' : 'It goes on with the new account.');
      fill(out, 'A menu is open in this session, so nothing was typed. ',
        h('button.btn.small.secondary', { type: 'button', onclick: () => { fill(out, 'Restarting…'); go(true); } }, 'Restart it and continue'));
    } catch (e) {
      fill(out, e.message);
    }
  };
  go(false);
  return row;
}

/**
 * After a sign-in with another account, in the same sheet: the session it was started for goes on by itself, and
 * the others that stand at a limit of the stored sign-in go on with one press.
 */
function afterSwitch(first) {
  return (r, body, close) => {
    const waiting = onStoredLogin().filter((s) => atLimit(s) && onThisComputer(s));
    const lead = first && waiting.find((s) => s.name === first.name) ? first : null;
    const rest = waiting.filter((s) => !lead || s.name !== lead.name);
    if (!lead && !rest.length) return false;
    const list = h('div.rows', lead ? continueRow(lead) : null);
    const more = rest.length
      ? btn('secondary', { icon: 'play', label: lead ? `Continue ${count(rest.length, 'other session')} too` : `Continue ${count(rest.length, 'session')} that stood at the limit`, onclick: (e) => {
        e.currentTarget.remove();
        for (const s of rest) add(list, continueRow(s));
      } })
      : null;
    add(body, list, h('div.sheet-actions', more, h('button.btn.primary', { type: 'button', onclick: () => { store.refresh(); close(true); } }, 'Done')));
    return true;
  };
}

/**
 * "Sign in with another Claude account": what happens, said before anything does, then the sign-in. `session`: the
 * session or chat it was asked from (it goes on by itself afterwards). Resolves true after a sign-in.
 */
export function switchAccount({ session = null, done = () => {} } = {}) {
  return new Promise((resolve) => {
    let next = null;
    openSheet({ title: 'Sign in with another Claude account', subtitle: 'For when this account is at its limit: the work goes on under the same provider.' }, (close) => {
      const who = h('p.sheet-text', 'Asking Claude Code who is signed in…');
      loadAccount().then((a) => fill(who, a.loggedIn ? ['Signed in now: ', h('strong', accountText(a) || 'a Claude account')] : 'Nobody is signed in now.')).catch(() => fill(who));
      const running = onStoredLogin().filter(onThisComputer);
      const email = h('input.field', { type: 'email', placeholder: 'name@example.com', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'E-mail address of the other account (optional)' });
      return h('form', { onsubmit: (e) => {
        e.preventDefault();
        // Inside the click, so the sign-in tab may open. This sheet makes way for the sign-in's.
        next = claudeSignIn({ another: true, email: email.value.trim(), done, after: afterSwitch(session) });
      } },
      who,
      h('ul.howlist',
        h('li', 'You sign in with the other account in your browser. Until that is complete nothing changes: cancel, and the account of now stays.'),
        h('li', running.length
          ? `${count(running.length, 'session', 'sessions')} run on this sign-in. They keep running and answer as the new account from their next request. No restart is needed (Claude Code 2.1.325 reads the sign-in again before each request).`
          : 'Sessions on this sign-in need no restart: Claude Code 2.1.325 reads the sign-in again before each request.'),
        h('li', 'The new account has its own limits: the limit mark and the usage figures of this provider start again.'),
        session ? h('li', `Afterwards "${nameOf(session)}" goes on by itself.`) : null),
      h('label.fieldrow', h('span.field-label', 'E-mail address of the other account (optional)'), email,
        h('span.hint', 'Claude Code hands it to the sign-in page, so that page can start with this account instead of the one your browser is signed in to.')),
      // The same calm note as under Auto mode's order with several subscriptions (lib.js subscriptionsNote).
      h('p.hint', 'Only an account of your own. Whether going on past a limit with a second account of yours is acceptable is yours to judge against Anthropic\'s terms. ',
        h('a', { href: `${REPO_URL}#is-this-allowed`, target: '_blank', rel: 'noopener' }, 'Is this allowed?')),
      h('div.sheet-actions',
        h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Cancel'),
        h('button.btn.primary', { type: 'submit' }, icon('user', { size: 18 }), h('span', 'Sign in with another account'))));
    }).then(() => (next ? next.then(resolve) : resolve(false)));
  });
}

/** "Sign out": what it means for what runs, then `claude auth logout` on the computer. Resolves true when signed out. */
export function signOut({ done = () => {} } = {}) {
  return openSheet({ title: 'Sign out of Claude Code?' }, (close) => {
    const who = h('p.sheet-text', 'Asking Claude Code who is signed in…');
    loadAccount().then((a) => fill(who, a.loggedIn ? ['Signed in now: ', h('strong', accountText(a) || 'a Claude account')] : 'Nobody is signed in now.')).catch(() => fill(who));
    const running = onStoredLogin().filter(onThisComputer);
    const out = h('div');
    const go = h('button.btn.danger', { type: 'button', onclick: async () => {
      go.disabled = true;
      try {
        await api(R('/logout'), {});
        toast('Signed out of Claude Code');
        store.refresh();
        done();
        close(true);
      } catch (e) {
        go.disabled = false;
        fill(out, errorBox(e.message));
      }
    } }, 'Sign out');
    return [
      who,
      h('ul.howlist',
        h('li', 'Claude Code forgets this sign-in on this computer, and what it saved with it (its sign-ins to MCP servers).'),
        h('li', running.length
          ? `${count(running.length, 'session', 'sessions')} run on this sign-in. Their next request ends in "Not logged in" until someone signs in again; then they go on. Their conversations are kept.`
          : 'A session on this sign-in cannot answer until someone signs in again. Conversations are kept.'),
        h('li', 'To change the account, use "Sign in with another account" instead: it needs no sign-out.')),
      out,
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(false) }, 'Cancel'), go),
    ];
  }).then((v) => v === true);
}

// ---------- at a limit ----------

/** Another Claude account signed in after this session reached its limit: it can simply go on. */
function newAccountSince(s, p) {
  if (!p || !p.accountAt) return false;
  return s.limitAt ? s.limitAt < p.accountAt : Date.now() - p.accountAt < RECENT_MS;
}

/**
 * The buttons at a limit of a session or chat on the stored sign-in, next to "Continue on <provider>": "Continue with
 * the new account" once another account signed in, and "Sign in with another Claude account". Null when the session
 * is not on the stored sign-in, or not on this computer. `after()`: the session was restarted.
 */
export function accountLimitActions(s, profiles, after) {
  if (!s.profile || !onThisComputer(s)) return null;
  const p = profiles.find((x) => x.name === s.profile.name);
  if (!usesStoredLogin(p)) return null;
  const quiet = (fn) => async (e) => {
    e.preventDefault();
    e.stopPropagation(); // on a card: act, do not open the session
    const b = e.currentTarget;
    b.disabled = true;
    try {
      await fn();
    } catch (err) {
      toast(err.message, { kind: 'error' });
    } finally {
      b.disabled = false;
    }
  };
  const goOn = async (restart = false) => {
    const r = await continueHere(s, { restart });
    if (r.ok) {
      toast(`${nameOf(s)} goes on with the new account`);
      if (restart) after?.(); // it starts again: "Starting" until Claude reports
      return store.refresh();
    }
    // A menu on its screen: nothing was typed. The restart is the owner's to choose.
    openSheet({ title: `Restart ${nameOf(s)} to continue?` }, (close) => [
      h('p.sheet-text', 'A menu is open in this session, so nothing was typed into it. Restarting starts the same conversation again in place, on the same provider, and then continues it.'),
      h('div.sheet-actions',
        h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Cancel'),
        h('button.btn.primary', { type: 'button', onclick: () => { close(); goOn(true).catch((err) => toast(err.message, { kind: 'error' })); } }, 'Restart and continue')),
    ]);
  };
  return [
    newAccountSince(s, p) ? h('button.btn.small.primary', { type: 'button', onclick: quiet(() => goOn()) }, icon('play', { size: 16 }), h('span', 'Continue with the new account')) : null,
    h('button.btn.small.secondary', { type: 'button', onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      switchAccount({ session: s });
    } }, icon('user', { size: 16 }), h('span', 'Sign in with another Claude account')),
  ];
}
limitActions.push(accountLimitActions); // every limit card (lib.js limitBox): Home, Workspace, the session page

/**
 * Under Home's line about the providers: the button, while a provider of this computer that uses the stored sign-in
 * is at its limit. Null otherwise.
 */
export function limitStripAction(machines) {
  const here = machines.find((m) => m.machine === null);
  const p = here && (here.profiles || []).find((x) => usesStoredLogin(x) && x.limited && x.signedIn !== false);
  if (!p) return null;
  return h('div.accountsline-actions',
    h('button.btn.small.secondary', { type: 'button', onclick: () => switchAccount() }, icon('user', { size: 16 }), h('span', 'Sign in with another Claude account')));
}
