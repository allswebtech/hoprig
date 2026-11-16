// Providers (#/providers, #/providers/<name>): what happens when a provider reaches its limit (Auto mode and its order),
// the accounts with their usage, each with a page of its own, and the Add account wizard (src/server/accounts.mjs).
// The ways to add one:
//   Claude subscription   sign in through a link, paste the code back; the computer keeps the token
//   Claude API            a key from console.anthropic.com or a gateway that speaks Claude's API
//   OpenAI API key        a key for OpenAI's API or a service that speaks it (for OpenCode)
//   Codex sign-in         the ChatGPT account Codex keeps itself (Sign in on its page opens Hoprig's `codex login`);
//                         offered only while Codex is (the server sends defaults.codex then). A file of this kind
//                         from a version that offered it comes with `unusable`: one plain line, not an error
// A provider that serves no coding tool of this version (that sign-in, or a key that answers only Codex's API) is
// `unusable` (src/profiles.mjs): muted, listed last, and its page says so and offers Remove.
//   Other providers       OpenAI, Gemini, OpenRouter, local models… through the TRouteAI add-on
// Every provider says which coding tools it works with ("Test" asks the endpoint which APIs it answers).
// "Use the terminal instead" stays for when the page flow does not work. Accounts are added on the computer whose
// page this is (this dashboard's own): a key or a sign-in never travels to another computer through this page.
import { COMMAND } from './brand.js';
import { accountText, loadAccount, signOut, switchAccount, usesStoredLogin } from './claudeaccount.js';
import { claudeSignIn } from './claudelogin.js';
import { icon } from './icons.js';
import {
  add, ago, api, at, btn, confirmSheet, copyText, fill, h, insecure, kindLabel, link, machine, openSheet, profileState, promptSheet,
  servesClaude, startOrder, subscriptionsNote, toast, toolsText, until,
} from './lib.js';
import { gatewaysPanel } from './gateways.js';
import { registerPage } from './registry.js';
import { emptyState, errorBox, fold, groupHead, openLabel, panel, radioCards, saveBar, savedMark, steps, toggle } from './shell.js';
import { store } from './store.js';

const A = (p) => at(machine.current, `/api/accounts${p}`); // the accounts of the computer whose page is open

const field = (label, input, hint) => h('label.fieldrow', h('span.field-label', label), input, hint ? h('span.hint', hint) : null);
const busy = (text) => h('div.empty.compact', h('div.spinner', { 'aria-hidden': 'true' }), h('p', text));

const KEYED = ['api', 'openai']; // providers with an address and a key
const kindIcon = (k) => (KEYED.includes(k) ? 'key' : 'user');
/** "Works with Claude Code · OpenCode", or null for a computer too old to say. */
const worksWith = (a) => (toolsText(a) ? `Works with ${toolsText(a)}` : null);
const CLAUDE_SIGNIN = ['login', 'subscription'];
// What a provider is, in words: a sign-in reads "Subscription" whether the computer's stored sign-in or its own
// (after "Sign in again" the kind changes from one to the other: the row must not change), with its plan.
const PLAN = (p) => p.charAt(0).toUpperCase() + p.slice(1);
// A provider that uses another computer's gateway: where it is, or why it cannot be used now (src/gateway).
const remoteText = (a) => (!a.remote ? null : a.remote.state === 'online' ? `${a.remote.title || 'Gateway'} on ${a.remote.computer}` : a.remote.text);
const kindText = (a) => [kindLabel(a), a.plan ? PLAN(a.plan) : null].filter(Boolean).join(' · ');

async function terminalWay() {
  try {
    const { name } = await api('~/api/profiles/add', {});
    location.hash = `#/s/${encodeURIComponent(name)}`;
  } catch (e) {
    toast(e.message, { kind: 'error' });
  }
}
// A provider that uses Claude Code's stored login is signed in with Claude Code's own sign-in (`claude auth login`), and
// stays such a provider; one with its own token gets a new token (`claude setup-token`, the wizard).
const signInAgain = (a, data, done) => (a.kind === 'login' ? claudeSignIn({ done }) : addWizard(data, done, { signIn: a }));
const terminalLink = () => h('p.hint', 'Not working? ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); terminalWay(); } }, 'Use the terminal instead'), ' — it runs the same steps in a terminal on the computer.');

// ======================= the page =======================

/**
 * The usage of a provider: the last known numbers, with their age ("as of 2 h ago") while no session of it runs
 * (`running` false: they are not fresh then); one quiet line when its plan does not report usage
 * (`usageReported: false`); null when nothing is known yet. A window the server left out is unknown, not 0%.
 */
export function usageBars(u, reported = null, running = false) {
  if (!u || !(u.fiveHour || u.week)) return reported === false ? h('p.hint.limit-none', 'This plan does not report its usage.') : null;
  const bar = (label, x) =>
    x && Number.isFinite(x.pct)
      ? h('div.limitbar',
        h('div.limitbar-top', h('span', label), h('span.limitbar-pct', `${Math.round(x.pct)}% used${x.resetsAt ? ` · resets ${until(x.resetsAt)}` : ''}`)),
        h(`div.meter${x.pct >= 90 ? '.hot' : ''}`, h('i', { style: { width: `${Math.min(100, Math.max(0, x.pct))}%` } })))
      : null;
  const old = !running && Number.isFinite(u.at);
  return h('div.limitbars', bar('5-hour limit', u.fiveHour), bar('Weekly limit', u.week), old ? h('span.limitbars-age', `as of ${ago(u.at)}`) : null);
}

const ORDINAL = (n) => `${n}${[, 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th'}`;

/** The accounts in the Auto order; the others after it, subscriptions first. */
function inOrder(accounts, order) {
  const rank = (a) => (order.includes(a.name) ? order.indexOf(a.name) : order.length + (a.unusable ? 2 : CLAUDE_SIGNIN.includes(a.kind) ? 0 : 1));
  return [...accounts].sort((a, b) => rank(a) - rank(b));
}

/** The accounts of the open computer: from its accounts route, or (an older computer) from its state. */
async function loadAccounts() {
  try {
    return { ...(await api(A(''))), full: true };
  } catch (e) {
    if (!machine.current) throw e;
    const st = await api('/api/state');
    return { accounts: st.profiles.filter((p) => !p.virtual).map((p) => ({ ...p, inAuto: (st.autoSwitch.order || []).includes(p.name) })), full: false };
  }
}

/** "When an account reaches its limit": stop and ask (the default) or carry on with the next one (Auto mode). */
function limitPanel(auto, accounts, refresh, flash) {
  const rows = (auto.order || []).filter((n) => accounts.some((p) => p.name === n));
  // Kept at once: "Saved" next to the title, also after the page is drawn again with the new choice.
  const mark = savedMark();
  if (flash) setTimeout(() => mark.show(), 0);
  const save = async (patch) => {
    try {
      await api('/api/settings', { autoSwitch: patch });
      refresh(true);
    } catch (e) {
      toast(e.message, { kind: 'error' });
      refresh();
    }
  };
  const list = h('ol.orderlist');
  const move = (i, d) => {
    [rows[i + d], rows[i]] = [rows[i], rows[i + d]];
    paint();
    save({ order: rows });
  };
  const paint = () =>
    fill(list, rows.map((name, i) => {
      const p = accounts.find((x) => x.name === name);
      return h(`li.orderrow.ps-${profileState(p).key}`,
        h('span.order-n', String(i + 1)),
        h('span.order-main',
          h('span.row-title', p.label),
          h('span.row-sub', `${kindText(p)} · ${profileState(p).text}`)),
        btn('icon ghost', { icon: 'up', title: `Move ${p.label} up`, disabled: i === 0, onclick: () => move(i, -1) }),
        btn('icon ghost', { icon: 'down', title: `Move ${p.label} down`, disabled: i === rows.length - 1, onclick: () => move(i, 1) }));
    }));
  paint();
  const choice = auto.enabled ? 'carry' : 'stop';
  return panel({ icon: 'zap', title: h('span', 'When a provider reaches its limit', mark) },
    radioCards('at-limit', [
      { value: 'stop', title: 'Stop and ask me', sub: 'The session waits at its limit. You pick another provider with one tap, or wait until the limit resets.' },
      { value: 'carry', title: 'Carry on with the next provider', sub: 'Work continues on the next provider in the order below, without you doing anything. This is called Auto mode.' },
    ], choice, (v) => save({ enabled: v === 'carry', ...(v === 'carry' && !rows.length ? { order: startOrder(accounts, auto.payPerUse === true) } : {}) })),
    fold('auto-how', 'How it works',
      h('ul.howlist',
        h('li', 'On an API provider the session goes on without stopping.'),
        h('li', 'On another subscription, Claude restarts on that provider and carries on with the same conversation.'),
        h('li', 'Providers lower in the order are used only while the ones above are at their limit.'),
        h('li', 'An API key straight to Anthropic costs money for every use; Auto mode uses one only when you allow it below.'),
        h('li', 'Auto mode, plan usage and Tia work with Claude Code only. An OpenCode session stays on the provider you start it on.')),
      subscriptionsNote(rows.map((n) => accounts.find((p) => p.name === n)))),
    choice === 'carry' ? [
      h('div.field-label', 'Order of providers'),
      rows.length ? list : h('p.muted', accounts.length ? 'No provider takes part yet: open a provider below and turn on "Use in Auto mode".' : 'Add a provider first.'),
      toggle('Also use pay-per-use API keys', auto.payPerUse === true, (v) => save({ payPerUse: v }),
        'API keys billed for every use go at the end of the order; while this is off, Auto mode never uses them.'),
    ] : null);
}

/** Advanced: sessions started on one fixed account while Auto mode is on. */
function fixedPanel(auto) {
  const st = { returnToPreferred: auto.returnToPreferred, prompt: auto.prompt || '' };
  return panel({ icon: 'swap', title: 'Sessions on one provider', desc: 'For sessions started on a fixed provider instead of Auto, while Auto mode is on: what happens at a limit.' },
    toggle('Go back to the first provider', st.returnToPreferred, (v) => { st.returnToPreferred = v; return false; }, // kept by Save below
      'When a provider higher in the order is free again, the session moves back at the end of its current reply.'),
    h('label.fieldrow', h('span.field-label', 'Message after a move'), h('input.field', { value: st.prompt, maxlength: 500, oninput: (e) => (st.prompt = e.target.value) }),
      h('span.hint', 'Typed into the session after it moved to another provider, so Claude carries on with the work.')),
    saveBar('Save', () => api('/api/settings', { autoSwitch: { returnToPreferred: st.returnToPreferred, prompt: st.prompt } })));
}

/**
 * One provider in the list. `signIn(a)`: starts its sign-in again (a sign-in provider that is not signed in).
 * `another(a)`: signs in with another Claude account (a provider on the stored sign-in that is at its limit).
 */
function accountRow(a, place, autoOn, signIn, another) {
  const ps = profileState(a);
  const page = link(`#/providers/${encodeURIComponent(a.name)}`);
  // A row with its own button is not a link element (a button inside a link is not allowed): it opens on a tap.
  return h(`div.row.acct.ps-${ps.key}${a.remote && a.remote.state !== 'online' ? '.gw-off' : ''}`, {
    tabindex: 0, role: 'link', 'aria-label': `${a.label}: ${ps.text}`,
    onclick: () => (location.hash = page),
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) location.hash = page; },
  },
  h('span.row-icon', icon(kindIcon(a.kind))),
  h('span.row-main',
    h('span.row-title', a.label, autoOn && place ? h('span.badge.soft', `${ORDINAL(place)} in the order`) : null),
    h('span.row-sub.state', [kindText(a), remoteText(a), ps.text].filter(Boolean).join(' · ')),
    worksWith(a) ? h('span.row-sub.acct-tools', worksWith(a)) : null,
    ps.key === 'signin' ? null : usageBars(a.usage, a.usageReported, a.inUse > 0),
    // Under the figures, not beside them: its words would squeeze the row on a phone.
    ps.key === 'limit' && another && usesStoredLogin(a)
      ? h('span.acct-more', h('button.btn.small.secondary', { type: 'button', onclick: (e) => { e.stopPropagation(); another(a); } }, icon('user', { size: 15 }), h('span', 'Sign in with another Claude account')))
      : null),
  ps.key === 'signin' && signIn ? h('button.btn.small.primary.acct-signin', { type: 'button', onclick: (e) => { e.stopPropagation(); signIn(a); } }, icon('user', { size: 15 }), h('span', 'Sign in')) : null,
  h('span.row-end', icon('chevronRight', { size: 18 })));
}

function viewAccounts({ frame, sub }) {
  store.viewing = null;
  if (sub) return viewAccount(frame, decodeURIComponent(sub));
  const here = !machine.current;
  const body = h('div', h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Loading providers…')));
  let data = null;
  const refresh = (flash = false) => {
    store.refresh();
    load(flash);
  };
  frame({
    title: 'Providers',
    page: 'providers',
    intro: 'The subscriptions, sign-ins and API keys this computer\'s coding tools use, and what happens when one reaches its limit.',
    primary: here ? { label: 'Add provider', icon: 'plus', onclick: () => data && addWizard(data, refresh) } : null,
    body: [body],
  });
  let alive = true;
  async function load(flash = false) {
    let settings;
    try {
      [data, settings] = await Promise.all([loadAccounts(), api('/api/settings')]);
    } catch (e) {
      return fill(body, errorBox(e.message), btn('secondary', { icon: 'refresh', label: 'Try again', onclick: load }));
    }
    if (!alive) return;
    const auto = settings.autoSwitch;
    const order = (auto.order || []).filter((n) => data.accounts.some((a) => a.name === n));
    const accounts = inOrder(data.accounts, order);
    fill(body,
      limitPanel(auto, data.accounts.filter(servesClaude), refresh, flash),
      groupHead('Providers', accounts.length),
      accounts.length
        ? h('div.rows', accounts.map((a) => accountRow(a, order.indexOf(a.name) + 1, auto.enabled, here ? (x) => signInAgain(x, data, refresh) : null, here ? () => switchAccount({ done: refresh }) : null)))
        : emptyState('user', here ? 'No providers yet. Add the subscription, sign-in or API key your coding tools should use.' : `No providers on ${openLabel()} yet. Add one on that computer's own page.`,
          here ? btn('primary', { icon: 'plus', label: 'Add provider', onclick: () => addWizard(data, refresh) }) : null),
      here ? null : h('p.hint', `Providers of ${openLabel()} are added on that computer's own page: a key or a sign-in never travels through this one.`),
      here ? gatewaysPanel({ useLocal: () => addWizard(data, refresh, { start: 'trouteai' }), changed: () => refresh() }) : null,
      fold('accounts', 'Advanced', fixedPanel(settings.autoSwitch)));
  }
  load();
  return () => {
    alive = false;
  };
}

/** One account's own page: usage, state, in Auto mode or not, rename, and the rest of what can be done with it. */
// "Test" on a provider asks the service one tiny question per API (about ten seconds). The row stays busy until the
// answer is there, and the answer stays on the provider's page (until the page is left), not only in a toast.
const lastTest = new Map(); // provider name → { ok, text }
const TOOL_WORDS = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

function testResult(a) {
  const t = lastTest.get(a.name);
  return t ? h(`p.acct-test.${t.ok ? 'test-ok' : 'test-bad'}`, { role: 'status' }, icon(t.ok ? 'check' : 'alert', { size: 15 }), h('span', t.text)) : null;
}

function testRow(a, refresh) {
  const sub = h('span.row-sub', 'Find out which coding tools can use it');
  const row = h('button.row', { type: 'button', onclick: async () => {
    if (!a.model) return modelSheet(a, refresh);
    row.disabled = true;
    row.setAttribute('aria-busy', 'true');
    row.classList.add('row-busy');
    sub.textContent = 'Testing: one short question per API, about ten seconds…';
    try {
      const r = await api(A(`/${encodeURIComponent(a.name)}/test`), {});
      const tools = (r.tools || []).map((t) => TOOL_WORDS[t] || t).join(' · ') || 'no coding tool';
      const kept = (r.kept || []).length ? ` Some APIs did not answer this time (busy or unreachable): what was known about them is kept.` : '';
      lastTest.set(a.name, r.ok ? { ok: true, text: `Tested just now: works with ${tools}.${kept}` } : { ok: false, text: `Tested just now: ${r.error}` });
    } catch (e) {
      lastTest.set(a.name, { ok: false, text: `Tested just now: ${e.message}` });
    }
    refresh();
  } }, h('span.row-icon', icon('check')), h('span.row-main', h('span.row-title', 'Test'), sub), h('span.row-end', icon('chevronRight', { size: 18 })));
  return row;
}

/**
 * A Codex sign-in: whether Codex is signed in here, and Sign in, which opens a terminal in the page with Codex's own
 * device sign-in (Hoprig's copy of Codex: a link and a code for the browser). The terminal ends when it is done.
 */
function codexSigninBox(a, d) {
  if (a.signedIn === true) return h('p.acct-works', icon('check', { size: 15 }), h('span', 'Codex is signed in on this computer.'));
  if (a.signedIn == null) {
    return h('div.banner.warn.mbanner', icon('alert', { size: 18 }), h('span', 'Codex is not installed on this computer yet.'),
      h('a.btn.small.primary', { href: link('#/settings/codingtools') }, 'Coding tools'));
  }
  return h('div.banner.warn.mbanner', icon('alert', { size: 18 }), h('span', 'Codex cannot use this provider until it is signed in.'),
    d.full ? btn('small primary', { icon: 'user', label: 'Sign in', onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        const { name } = await api(at(machine.current, '/api/codetools/codex/signin'), {});
        toast('Codex\'s sign-in opened in a terminal: follow its link and enter its code.', { ms: 8000 });
        location.hash = link(`#/s/${encodeURIComponent(name)}`);
      } catch (err) {
        toast(err.message, { kind: 'error', ms: 8000 });
        b.disabled = false;
      }
    } }) : null);
}

// What Remove takes away: a provider with a key or a token of its own loses it; one that only points at a sign-in
// kept elsewhere (Claude Code's stored login, another coding tool's sign-in) is only an entry here.
const REMOVES_NOTHING_ELSE = ['login', 'chatgpt'];
async function removeProvider(a) {
  const text = REMOVES_NOTHING_ELSE.includes(a.kind)
    ? 'Only this entry is removed; nothing else on the computer changes. Conversations are kept and can continue on another provider.'
    : 'Its stored key or token is removed from the computer. Conversations are kept and can continue on another provider.';
  if (!(await confirmSheet({ title: `Remove ${a.label}?`, text, ok: 'Remove', danger: true }))) return;
  try {
    await api(A(`/${encodeURIComponent(a.name)}/delete`), {});
    toast(`${a.label} removed`);
    store.refresh();
    location.hash = link('#/providers');
  } catch (e) {
    toast(e.message, { kind: 'error' });
  }
}

/** A provider no coding tool of this version can use: why, in one line, and the one thing to do (Remove). */
function unusableBox(a, d) {
  const why = a.kind === 'chatgpt'
    ? 'This is the sign-in of a coding tool that this version of Hoprig does not offer, so nothing uses it. It is kept until you remove it.'
    : `No coding tool of this version of Hoprig can use this provider, so nothing uses it.${KEYED.includes(a.kind) ? ' If its address answers more now, Test it again; otherwise remove it.' : ''}`;
  return h('div.banner.muted.mbanner.acct-unusable', icon('info', { size: 18 }), h('span', why),
    d.full ? btn('small danger', { icon: 'trash', label: 'Remove', onclick: () => removeProvider(a) }) : null);
}

function viewAccount(frame, name) {
  const body = h('div', h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Loading…')));
  // The title is the account's name: drawn again once it is known (and after a rename).
  const draw = (title, intro = null) => frame({ title, intro, page: 'providers', back: link('#/providers'), backLabel: 'Providers', body: [body] });
  draw(((store.data && store.data.profiles) || []).find((p) => p.name === name)?.label || 'Provider');
  let alive = true;
  const refresh = () => {
    store.refresh();
    load();
  };
  async function load() {
    let d;
    try {
      d = await loadAccounts();
    } catch (e) {
      return fill(body, errorBox(e.message));
    }
    if (!alive) return;
    const a = d.accounts.find((x) => x.name === name);
    if (!a) return fill(body, emptyState('user', 'There is no such provider on this computer.', h('a.btn.secondary', { href: link('#/providers') }, 'All providers')));
    const ps = profileState(a);
    const what = [kindText(a), a.remote ? remoteText(a) : a.viaTrouteai ? 'via TRouteAI' : a.host || '', a.model ? `model ${a.model}` : ''].filter(Boolean).join(' · ');
    draw(a.label, what);
    const claude = servesClaude(a);
    const act = (ic, label, sub, fn) => h('button.row', { type: 'button', onclick: async () => {
      try {
        await fn();
      } catch (e) {
        toast(e.message, { kind: 'error', ms: 8000 });
      }
    } }, h('span.row-icon', icon(ic)), h('span.row-main', h('span.row-title', label), sub ? h('span.row-sub', sub) : null), h('span.row-end', icon('chevronRight', { size: 18 })));
    // Claude Code's stored sign-in, on this dashboard's own computer: who is signed in, and the two things to do
    // with it. (A provider with its own account token is signed in again through its wizard, as before.)
    const stored = usesStoredLogin(a) && d.full && !machine.current;
    const who = stored && ps.key !== 'signin' ? h('p.acct-who.hint', 'Asking Claude Code who is signed in…') : null;
    if (who) {
      loadAccount().then((x) => alive && fill(who, x.loggedIn ? ['Signed in as ', h('strong', accountText(x) || 'a Claude account')] : 'Claude Code reports no sign-in.'))
        .catch(() => alive && fill(who));
    }
    fill(body,
      panel({},
        h(`p.acct-state.ps-${ps.key}`, h('span.dot'), ps.text),
        who,
        a.unusable ? unusableBox(a, d)
          : a.kind === 'chatgpt' ? codexSigninBox(a, d) : ps.key === 'signin'
          ? h('div.banner.warn.mbanner', icon('alert', { size: 18 }), h('span', 'Claude Code cannot use this provider until you sign in again.'),
            d.full ? btn('small primary', { icon: 'user', label: 'Sign in', onclick: () => signInAgain(a, d, refresh) }) : null)
          : CLAUDE_SIGNIN.includes(a.kind) || a.kind === 'api' ? usageBars(a.usage, a.usageReported, a.inUse > 0) || h('p.hint', 'No usage figures yet: they appear after the first answer on this provider.') : null,
        stored && ps.key === 'limit'
          ? h('div.banner.warn.mbanner.acct-limit', icon('alert', { size: 18 }), h('span', 'This account is at its limit. With another Claude account the work goes on under this provider.'),
            btn('small primary', { icon: 'user', label: 'Sign in with another Claude account', onclick: () => switchAccount({ done: refresh }) }))
          : null,
        worksWith(a) ? h('p.acct-works', icon('check', { size: 15 }), h('span', worksWith(a))) : null,
        testResult(a),
        a.kind === 'chatgpt' && !a.unusable ? h('p.hint', 'Codex uses the ChatGPT account it is signed in to on this computer. In a terminal, the same is ', h('code', `${COMMAND} codex login --device-auth`), '.') : null,
        CLAUDE_SIGNIN.includes(a.kind) ? h('p.hint', 'A Claude subscription works with Claude Code only.') : null,
        d.full && claude ? toggle('Use in Auto mode', a.inAuto, async (on) => {
          try {
            await api(A(`/${encodeURIComponent(a.name)}/auto`), { on });
            toast(on ? `${a.label} is used in Auto mode` : `${a.label} is no longer used in Auto mode`);
            refresh();
          } catch (e) {
            toast(e.message, { kind: 'error' });
            refresh();
          }
        }, 'When on, Auto mode moves a session here when the providers above it in the order are at their limit.') : null),
      d.full ? h('div.rows',
        stored && ps.key !== 'signin' ? act('user', 'Sign in with another account', 'Sessions keep running, on the new account', () => switchAccount({ done: refresh })) : null,
        stored && ps.key !== 'signin' ? act('logout', 'Sign out', 'Claude Code forgets this sign-in', () => signOut({ done: refresh })) : null,
        act('pencil', 'Rename', 'The name shown everywhere', async () => {
          const label = await promptSheet({ title: 'Rename provider', value: a.label, ok: 'Rename', check: (v) => (v.trim() && v.length <= 60 ? '' : 'One line, up to 60 characters') });
          if (!label) return;
          await api(A(`/${encodeURIComponent(a.name)}/label`), { label });
          toast('Renamed');
          refresh();
        }),
        KEYED.includes(a.kind) ? act('sparkle', 'Change model', a.model ? `Now: ${a.model}` : 'Pick the model this provider uses', () => modelSheet(a, refresh)) : null,
        KEYED.includes(a.kind) ? testRow(a, refresh) : null,
        a.limited ? act('refresh', 'It is free again', 'Mark it as no longer at its limit', async () => {
          await api(at(machine.current, `/api/profiles/${encodeURIComponent(a.name)}/available`), {});
          toast(`${a.label} is available again`);
          refresh();
        }) : null) : null,
      d.full ? fold('account', 'Advanced',
        h('p.hint', `Short name: ${a.name} (for the command line).`),
        h('div.savebar', btn('danger', { icon: 'trash', label: 'Remove this provider', onclick: () => removeProvider(a) }))) : h('p.hint', 'This computer runs an older version: its providers are changed on its own page.'));
  }
  load();
  return () => {
    alive = false;
  };
}

// ======================= change the model of an API account =======================

async function modelSheet(a, done) {
  await openSheet({ title: `Model for ${a.label}`, subtitle: 'Every request on this provider uses this model' }, (close) => {
    const panel = h('div.wizard', busy('Asking the service for its models…'));
    (async () => {
      let probe;
      try {
        probe = await api(A('/probe'), { account: a.name });
      } catch (e) {
        fill(panel, errorBox(e.message));
        return;
      }
      const pick = modelPicker(probe, a.model, a.smallModel, { withSmall: a.kind === 'api' });
      const out = h('div');
      const save = h('button.btn.primary', { type: 'button' }, 'Test and save');
      save.addEventListener('click', async () => {
        save.disabled = true;
        fill(out, busy('Testing…'));
        try {
          const model = pick.model();
          const t = await api(A('/test'), { probe: probe.probe, model });
          if (!t.ok) {
            fill(out, errorBox(t.error));
            save.disabled = false;
            return;
          }
          await api(A(`/${encodeURIComponent(a.name)}/model`), { probe: probe.probe, model, smallModel: pick.small() });
          toast(`${a.label} now uses ${model}`);
          close(true);
          done();
        } catch (e) {
          fill(out, errorBox(e.message));
          save.disabled = false;
        }
      });
      fill(panel, pick.node, out, h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Cancel'), save));
    })();
    return panel;
  });
}

/** The model list (or a free-text field when the service has none), plus the optional background model. */
function modelPicker(probe, current = '', currentSmall = '', { withSmall = true } = {}) {
  const list = probe.models || [];
  const has = list.length > 0;
  const options = (sel, withNone) => [
    ...(withNone ? [h('option', { value: '' }, 'Same as above / Claude Code\'s default')] : []),
    ...list.map((m) => h('option', { value: m.id, selected: m.id === sel }, m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id)),
  ];
  const main = has ? h('select.field', options(current || list[0].id, false)) : h('input.field.mono', { value: current, placeholder: 'e.g. claude-sonnet-4-5 or provider/model', autocapitalize: 'off', spellcheck: 'false' });
  const small = has ? h('select.field', options(currentSmall, true)) : h('input.field.mono', { value: currentSmall, placeholder: 'optional', autocapitalize: 'off', spellcheck: 'false' });
  return {
    node: h('div.fields',
      probe.note ? h('p.hint', probe.note) : null,
      field('Model', main, has ? `${list.length} model${list.length === 1 ? '' : 's'} found on this service. Every request on this provider goes to the one you pick.` : 'Type the exact model name the service uses.'),
      withSmall ? h('details.adv', h('summary', 'Smaller, faster model for background work (optional)'),
        field('Background model', small, 'Claude Code uses a small model for quick background tasks such as titles. Leave it empty to use the one above.')) : null),
    model: () => main.value.trim(),
    small: () => small.value.trim(),
  };
}

// ======================= Add account =======================

/** Add a provider; with `signIn` (a provider), sign that one in again: straight to the sign-in link. */
function addWizard(data, done, { signIn = null, start = null } = {}) {
  let cleanup = null;
  openSheet(signIn ? { title: `Sign in again to ${signIn.label}`, subtitle: 'With the Claude account this provider uses. Until the code is accepted, nothing changes.' } : { title: 'Add provider', subtitle: 'Choose what you want to add' }, (close) => {
    const panel = h('div.wizard');
    const finish = (text) => {
      toast(text);
      cleanup = null;
      close(true);
      done();
    };
    const choose = () =>
      fill(panel,
        h('div.choice-list',
          choice('user', 'Claude subscription', 'Another Claude Pro or Max account. You sign in through a link; nothing to install.', () => subscription()),
          choice('key', 'Claude API key', 'A key from console.anthropic.com, or a gateway that speaks Claude\'s API.', () => apiForm({ via: 'api' })),
          choice('key', 'OpenAI API key', 'For OpenCode: a key from platform.openai.com, or a service that speaks OpenAI\'s API.', () => apiForm({ via: 'openai' })),
          // Only while Codex is offered (src/codetools/index.mjs): the server sends its defaults then.
          data.defaults && data.defaults.codex ? choice('user', 'Codex sign-in', 'The ChatGPT account Codex signs in to on this computer. For Codex only.', () => codexSignin()) : null,
          choice('sparkle', 'Other providers through TRouteAI (for Claude Code)', 'OpenAI, Gemini, OpenRouter or a local model, translated for Claude Code by TRouteAI, a free gateway on this computer.', () => trouteai())),
        terminalLink());
    const back = () => signIn ? null : h('button.btn.ghost.small.backlink', { type: 'button', onclick: async () => { await cleanup?.(); cleanup = null; choose(); } }, icon('back', { size: 16 }), h('span', 'Other ways'));

    // ---------- Claude subscription ----------
    function subscription() {
      const d = data.defaults.subscription;
      const n = /(\d+)$/.exec(d.name);
      const name = h('input.field.mono', { value: d.name, autocapitalize: 'off', spellcheck: 'false', maxlength: 32 });
      const label = h('input.field', { value: `Claude subscription${n ? ` ${n[1]}` : ''}`, maxlength: 60 });
      const go = h('button.btn.primary.block', { type: 'button' }, icon('play', { size: 18 }), h('span', 'Get the sign-in link'));
      const out = h('div');
      go.addEventListener('click', async () => {
        go.disabled = true;
        fill(out, busy('Starting Claude Code on the computer…'));
        try {
          const r = await api(A('/subscription/start'), { name: name.value, label: label.value });
          cleanup = () => api(A('/subscription/cancel'), {}).catch(() => {});
          linkStep(r);
        } catch (e) {
          fill(out, errorBox(e.message), terminalLink());
          go.disabled = false;
        }
      });
      fill(panel, back(),
        h('p.sheet-text', 'You sign in with the account you want to add; the computer keeps a long-lived key for it. The key never comes to this page.'),
        h('details.adv', h('summary', 'Names'),
          field('Short name', name, `Used on the command line, e.g. ${COMMAND} sub2.`),
          field('Name to show', label)),
        go, out);
    }

    function linkStep(r) {
      const code = h('input.field.mono', { placeholder: 'Paste the code here', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
      const add = h('button.btn.primary', { type: 'button' }, signIn ? 'Sign in' : 'Add provider');
      const out = h('div');
      add.addEventListener('click', async () => {
        if (!code.value.trim()) return code.focus();
        add.disabled = true;
        fill(out, busy('Checking the code…'));
        try {
          const res = await api(A('/subscription/code'), { code: code.value });
          finish(signIn ? `${res.label || signIn.label} is signed in again` : `${res.label} added`);
        } catch (e) {
          cleanup = null;
          fill(out, errorBox(e.message), h('div.savebar', btn('secondary', { icon: 'refresh', label: 'Start again', onclick: subscription })), terminalLink());
        }
      });
      fill(panel, back(),
        steps(
          [h('p', signIn ? 'Open this link and sign in with the Claude account this provider uses.' : 'Open this link and sign in with the account you want to add.'),
            h('div.btnrow',
              h('a.btn.primary', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, icon('external', { size: 18 }), h('span', 'Open the sign-in page')),
              btn('secondary', { icon: 'copy', label: 'Copy link', onclick: async () => toast((await copyText(r.url)) ? 'Link copied' : 'Copy did not work') }))],
          [h('p', 'After you allow access, the page shows a code. Paste it here.'), code],
        ),
        h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: async () => { await cleanup?.(); cleanup = null; close(); } }, 'Cancel'), add),
        out,
        h('p.hint', 'The sign-in stays open for 10 minutes.'));
      code.focus();
    }

    // ---------- an API key (Claude's API directly, or through TRouteAI) ----------
    // ---------- Codex's own sign-in: a provider that says so; the sign-in itself is Hoprig's `codex login` ----------
    function codexSignin() {
      const d = (data.defaults && data.defaults.codex) || { name: 'chatgpt', label: 'Codex sign-in' };
      const name = h('input.field.mono', { value: d.name, autocapitalize: 'off', spellcheck: 'false', maxlength: 32 });
      const label = h('input.field', { value: d.label, maxlength: 60 });
      const out = h('div');
      const add = h('button.btn.primary', { type: 'button' }, 'Add provider');
      add.addEventListener('click', async () => {
        add.disabled = true;
        try {
          const r = await api(A('/codex-signin'), { name: name.value, label: label.value });
          finish(`${label.value || 'Codex sign-in'} added`);
          location.hash = link(`#/providers/${encodeURIComponent(r.name)}`); // where Sign in is
          return r;
        } catch (e) {
          fill(out, errorBox(e.message));
          add.disabled = false;
        }
      });
      fill(panel, back(),
        h('p.sheet-text', 'Codex keeps its own sign-in to a ChatGPT account on this computer. This provider lets Codex sessions use it; it works with Codex only.'),
        steps([h('p', 'Add the provider here.')], [h('p', 'On its page, press Sign in: a terminal opens with Codex\'s own sign-in, a link and a code for your browser. Until then it is "Not signed in".')]),
        h('details.adv', h('summary', 'Names'), field('Short name', name, 'Used on the command line.'), field('Name to show', label)),
        out,
        h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Cancel'), add));
    }

    function apiForm({ via, baseUrl: fixedBase = null, intro = null }) {
      const d = via === 'trouteai' ? data.defaults.trouteai : via === 'openai' ? data.defaults.openai || { name: 'openai', label: 'OpenAI API', baseUrl: 'https://api.openai.com' } : data.defaults.api;
      const baseUrl = h('input.field.mono', { type: 'url', value: fixedBase || d.baseUrl, autocapitalize: 'off', spellcheck: 'false' });
      const key = h('input.field.mono', { type: 'password', placeholder: via === 'trouteai' ? 'The key you created in TRouteAI' : via === 'openai' ? 'sk-…' : 'sk-ant-…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
      const name = h('input.field.mono', { value: d.name, autocapitalize: 'off', spellcheck: 'false', maxlength: 32 });
      const label = h('input.field', { value: d.label, maxlength: 60 });
      const find = h('button.btn.primary.block', { type: 'button' }, h('span', 'Find models'));
      const out = h('div');
      find.addEventListener('click', async () => {
        find.disabled = true;
        fill(out, busy('Asking the service for its models…'));
        try {
          const probe = await api(A('/probe'), { baseUrl: baseUrl.value, key: key.value, ...(via === 'openai' ? { via } : {}) });
          key.value = ''; // sent once; it stays on the computer from here
          fill(panel, back(), h('div.picked-value', icon('key', { size: 18 }), h('span', probe.baseUrl), btn('small ghost', { label: 'Change', onclick: () => apiForm({ via, baseUrl: fixedBase, intro }) })), out);
          modelStep(probe, { via, name, label, out, find });
        } catch (e) {
          fill(out, errorBox(e.message));
          find.disabled = false;
        }
      });
      fill(panel, back(),
        intro,
        field('Address of the API', baseUrl, via === 'trouteai' ? 'TRouteAI on this computer. Change it only if you moved TRouteAI.' : via === 'openai' ? 'Leave it for a key from platform.openai.com; change it for a service that speaks OpenAI\'s API.' : 'Leave it for a key from console.anthropic.com; change it for a gateway.'),
        insecure() ? h('div.banner.warn', icon('lock', { size: 18 }), h('span', 'This page is not encrypted: the key would travel over the network in plain text. Use it only on a network you trust, or ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); terminalWay(); } }, 'use the terminal instead'), '.')) : null,
        field('API key', key, 'Sent to the computer once, checked, and kept only in its provider file there.'),
        h('details.adv', h('summary', 'Names'), field('Short name', name, 'Used on the command line.'), field('Name to show', label)),
        find, out);
    }

    function modelStep(probe, { via, name, label, out, find }) {
      const pick = modelPicker(probe, '', '', { withSmall: via !== 'openai' });
      const result = h('div');
      const save = h('button.btn.primary', { type: 'button' }, 'Test and save');
      const doSave = async (model) => {
        const r = await api(A('/save'), { probe: probe.probe, via, name: name.value, label: label.value, model, smallModel: pick.small() });
        // Which APIs it answers decides which coding tools may use it: asked once now (Test on its page does it again).
        if (via !== 'openai') await api(A(`/${encodeURIComponent(r.name)}/test`), {}).catch(() => {});
        finish(`${label.value || 'Provider'} added`);
        return r;
      };
      save.addEventListener('click', async () => {
        const model = pick.model();
        if (!model) return toast('Pick or type a model first', { kind: 'error' });
        save.disabled = true;
        fill(result, busy('Sending one tiny test request…'));
        try {
          const t = await api(A('/test'), { probe: probe.probe, model });
          if (t.ok) return void (await doSave(model));
          fill(result, errorBox(t.error), h('div.savebar', btn('secondary', { label: 'Save anyway', onclick: () => doSave(model).catch((e) => fill(result, errorBox(e.message))) })));
        } catch (e) {
          fill(result, errorBox(e.message));
        }
        save.disabled = false;
      });
      find.classList.add('hidden');
      fill(out,
        h('div.banner.ok-box', icon('check', { size: 18 }), h('span', `The key works${probe.auth && via !== 'openai' ? ` (sent as ${probe.auth})` : ''}.`)),
        h('details.adv', h('summary', 'Names'), field('Short name', name, 'Used on the command line.'), field('Name to show', label)),
        pick.node, result,
        h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Cancel'), save));
    }

    // ---------- other providers through TRouteAI ----------
    async function trouteai() {
      fill(panel, back(), busy('Checking TRouteAI on the computer…'));
      let st;
      try {
        st = (await api(A(''))).trouteai;
      } catch (e) {
        return fill(panel, back(), errorBox(e.message));
      }
      if (!st) return fill(panel, back(), errorBox('The TRouteAI add-on is not available in this version.'));
      const job = h('pre.output.hidden', { 'aria-live': 'polite' });
      const run = async (action, then) => {
        job.classList.remove('hidden');
        fill(job);
        try {
          await api(`~/api/addons/trouteai/${action}`, {});
          let from = 0;
          for (;;) {
            await new Promise((r) => setTimeout(r, 1000));
            const j = await api(`~/api/addons/trouteai/job?from=${from}`);
            if (j.lines.length) fill(job, job.textContent + j.lines.join('\n') + '\n');
            from = j.next;
            job.scrollTop = job.scrollHeight;
            if (!j.running) {
              if (j.result && !j.result.ok) throw new Error(j.result.error || `TRouteAI could not ${action}`);
              return then();
            }
          }
        } catch (e) {
          add(panel, errorBox(e.message));
        }
      };
      if (!st.installed) {
        return fill(panel, back(),
          h('p.sheet-text', 'TRouteAI is a free gateway that runs on this computer. You add OpenAI, Gemini, OpenRouter or a local model in its own page, and Claude Code uses them through it.'),
          btn('primary block', { icon: 'download', label: 'Install TRouteAI', onclick: (e) => { e.currentTarget.disabled = true; run('install', trouteai); } }),
          job);
      }
      if (!st.running) {
        return fill(panel, back(),
          h('p.sheet-text', 'TRouteAI is installed but not running. Start it, then add your provider in its page and come back with a key.'),
          btn('primary block', { icon: 'play', label: 'Start TRouteAI', onclick: (e) => { e.currentTarget.disabled = true; run('start', trouteai); } }),
          job);
      }
      // Its address as seen from this browser: the PC's own name instead of "localhost" when the page is remote.
      const pcUrl = (st.url || 'http://localhost:20017').replace('localhost', ['localhost', '127.0.0.1'].includes(location.hostname) ? 'localhost' : location.hostname);
      apiForm({
        via: 'trouteai',
        intro: h('div',
          steps(
            [h('p', 'Open TRouteAI and add your provider there (OpenAI, Gemini, OpenRouter, a local model…).'),
              h('div.btnrow', h('a.btn.secondary', { href: pcUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('external', { size: 18 }), h('span', 'Open TRouteAI')), h('span.hint.mono', pcUrl))],
            [h('p', 'In TRouteAI, create an API key.')],
            [h('p', 'Come back and paste the key below.')]),
          h('p.hint', 'TRouteAI starts by itself whenever a session on this provider needs it.')),
      });
    }

    // Signing an existing provider in again: the same sign-in link and code, under its own name.
    async function again() {
      fill(panel, busy('Starting Claude Code on the computer…'));
      try {
        const r = await api(A('/subscription/start'), { mode: 'signin', name: signIn.name });
        cleanup = () => api(A('/subscription/cancel'), {}).catch(() => {});
        linkStep(r);
      } catch (e) {
        // One left open (a page closed mid-way, another device): it can be ended here, then this one starts.
        const busy = /in progress/i.test(e.message);
        fill(panel, errorBox(e.message, busy ? null : again),
          busy ? h('div.savebar.start', btn('secondary', { icon: 'x', label: 'Cancel that sign-in and start again', onclick: async () => { await api(A('/subscription/cancel'), {}).catch(() => {}); again(); } })) : null,
          terminalLink());
      }
    }

    if (signIn) again();
    else if (start === 'trouteai') trouteai(); // "Use here" on this computer's gateway: straight to its steps
    else choose();
    return panel;
  }).then(() => cleanup?.());
}

function choice(ic, title, sub, onclick) {
  return h('button.choice', { type: 'button', onclick },
    h('span.choice-icon', icon(ic)),
    h('span.choice-main', h('span.choice-label', title), h('span.choice-sub', sub)),
    h('span.choice-end', icon('chevronRight')));
}

registerPage({ id: 'providers', title: 'Providers', icon: 'user', group: 'main', order: 20, perComputer: true, render: viewAccounts });
