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
// `unusable` (src/profiles.mjs): muted, listed last, and its page says so and offers Remove. So is one whose gateway
// was removed or not loaded (`gatewayGone`): its sessions would not start.
//   Other providers       OpenAI, Gemini, OpenRouter, local models… through a gateway on this computer (its title and
//                         sentences come from the server: data.gateways); with more than one, it asks which first
// Every provider says which coding tools it works with ("Test" asks the endpoint which APIs it answers).
// "Use the terminal instead" stays for when the page flow does not work. Accounts are added on the computer whose
// page this is (this dashboard's own): a key or a sign-in never travels to another computer through this page.
import { COMMAND } from './brand.js';
import { accountText, loadAccount, signOut, switchAccount, usesStoredLogin } from './claudeaccount.js';
import { askedByRefresh, barsOf, figuresAt, groupRows, readLine, resultOf, rowButton, summaryLine } from './providerwords.js';
import { claudeSignIn } from './claudelogin.js';
import { icon } from './icons.js';
import { middleModel } from './modelpicker.js';
import {
  add, ago, api, at, btn, speedWords, confirmSheet, copyText, fill, h, insecure, isPaid, kindLabel, link, machine, openSheet, profileState, promptSheet,
  servesClaude, clockAt, startOrder, subscriptionsNote, toast, toolsText, until,
} from './lib.js';
import { gatewayPageLink, gatewaysPanel, programFacts, setupBlock } from './gateways.js';
import { viewTrouteai } from './trouteai.js';
import { ownBackupPanel, ownEndpointPanel, ownNote } from './ownendpoint.js';
import { providerHealth } from './providerhealth.js';
import { registerPage } from './registry.js';
import { partOf, showPart } from './showpart.js';
import { emptyState, errorBox, fold, groupHead, listRow, openLabel, panel, radioCards, saveBar, savedMark, steps, toggle } from './shell.js';
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
// A Claude sign-in on a Console account is billed by use (src/routerstate.mjs billedLogin): it is named so, never
// "Subscription", in the list, in Auto mode's order and on its own page.
const BILLED_SIGNIN = 'Claude sign-in billed by use (Console account)';
const kindText = (a) => [CLAUDE_SIGNIN.includes(a.kind) && isPaid(a) ? BILLED_SIGNIN : kindLabel(a), a.plan ? PLAN(a.plan) : null].filter(Boolean).join(' · ');

async function terminalWay() {
  try {
    const { name } = await api('~/api/profiles/add', {});
    location.hash = `#/s/${encodeURIComponent(name)}`;
  } catch (e) {
    toast(e, { kind: 'error' });
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
  const rank = (a) => (order.includes(a.name) ? order.indexOf(a.name) : order.length + (a.unusable || a.gatewayGone ? 2 : CLAUDE_SIGNIN.includes(a.kind) ? 0 : 1));
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

/** The line under a Claude sign-in: a sign-in billed by use (a Console account) is never called a subscription. */
export const signinHint = (a) => (!CLAUDE_SIGNIN.includes(a.kind) ? null
  : isPaid(a) ? 'A Claude sign-in works with Claude Code only.' : 'A Claude subscription works with Claude Code only.');

/** The help of "Also use pay-per-use providers": what src/autoswitch.mjs usableOrder leaves out while it is off. */
export const PAY_PER_USE_HELP = 'API keys billed for every use, and a Claude sign-in on a Console account (billed by use too), take part in Auto mode only while this is on. Turning it on puts them at the end of the order, if they are not in it yet.';

/**
 * The second line of a row of Auto mode's order. A provider billed by use that stays in the saved order while
 * pay-per-use is off (a sign-in that became a Console account's after it was put there) is left out by Auto mode
 * (src/autoswitch.mjs usableOrder), so its row says so instead of "Available".
 */
export const leftOut = (p, payPerUse) => !payPerUse && isPaid(p);
// Left out: the kind of a billed sign-in says "billed by use" already, so its row says it once.
const stateWords = (p, payPerUse) =>
  !leftOut(p, payPerUse) ? profileState(p).text
    : CLAUDE_SIGNIN.includes(p.kind) ? 'Not used while pay-per-use is off' : 'Billed by use · not used while pay-per-use is off';
export const orderRowSub = (p, payPerUse) => `${kindText(p)} · ${stateWords(p, payPerUse)}`;

/** The second line of a provider in the list under the order: the same words as its row in the order. */
export const listRowSub = (a, payPerUse, remote = null) => [kindText(a), remote, stateWords(a, payPerUse)].filter(Boolean).join(' · ');

/**
 * The help of a provider's "Use in Auto mode". A provider billed by use that is new to the order turns "Also use
 * pay-per-use providers" on (src/autoswitch.mjs setAutoSwitch): while that is off, the help says so before the press.
 */
export const autoHelp = (a, payPerUse) =>
  `When on, Auto mode moves a session here when the providers above it in the order are at their limit.${!a.inAuto && !payPerUse && isPaid(a)
    ? ' This provider is billed by use: turning this on also turns on "Also use pay-per-use providers" on the Providers page, so Auto mode can spend money here.'
    : ''}`;

/** The toast after "Use in Auto mode": it names "Also use pay-per-use providers" when the press turned that on. */
export const autoToast = (a, on, r = {}) =>
  !on ? `${a.label} is no longer used in Auto mode`
    : r && r.payPerUseTurnedOn ? `${a.label} is used in Auto mode. "Also use pay-per-use providers" is now on, so Auto mode can spend money here.`
    : `${a.label} is used in Auto mode`;

/**
 * "At a limit": stop and ask (the default) or carry on with the next one (Auto mode), on the Providers page itself: the
 * two choices, how it works, the order, and Advanced. `onSaved(auto)` tells the page.
 */
function limitBody(start, accounts, onSaved) {
  let auto = start;
  const box = h('div.limitsheet');
  const mark = savedMark();
  const save = async (patch) => {
    try {
      await api('/api/settings', { autoSwitch: patch });
      auto = (await api('/api/settings')).autoSwitch;
      onSaved(auto);
      draw(true);
    } catch (e) {
      toast(e, { kind: 'error' });
      draw();
    }
  };
  function draw(flash = false) {
    const rows = (auto.order || []).filter((n) => accounts.some((p) => p.name === n));
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
            h('span.row-sub', orderRowSub(p, auto.payPerUse === true))),
          btn('icon ghost', { icon: 'up', title: `Move ${p.label} up`, disabled: i === 0, onclick: () => move(i, -1) }),
          btn('icon ghost', { icon: 'down', title: `Move ${p.label} down`, disabled: i === rows.length - 1, onclick: () => move(i, 1) }));
      }));
    paint();
    const choice = auto.enabled ? 'carry' : 'stop';
    fill(box,
      radioCards('at-limit', [
        { value: 'stop', title: 'Stop and ask me', sub: 'The session waits. You pick another account, or wait.' },
        { value: 'carry', title: 'Carry on with the next provider', sub: 'The work moves to the next provider in the order. This is called Auto mode.' },
      ], choice, (v) => save({ enabled: v === 'carry', ...(v === 'carry' && !rows.length ? { order: startOrder(accounts, auto.payPerUse === true) } : {}) })),
      flash ? mark : null,
      fold('auto-how', 'How it works',
        h('ul.howlist',
          h('li', 'On an API provider the session goes on without stopping.'),
          h('li', 'On another subscription, Claude Code restarts on that provider and carries on with the same conversation.'),
          h('li', 'Providers lower in the order are used only while the ones above are at their limit.'),
          h('li', 'While Auto mode\'s provider is slow or refusing, a new session starts on another provider that is free of charge and signed in, also one not in this order.'),
          h('li', 'An API key straight to Anthropic costs money for every use; Auto mode uses one only when you allow it.'),
          h('li', 'Auto mode and plan usage work with Claude Code only: an OpenCode session is never moved by itself. Tia starts an OpenCode session in the App when you name it, and every OK of one comes to you.')),
        subscriptionsNote(rows.map((n) => accounts.find((p) => p.name === n)))),
      choice === 'carry' ? [
        h('div.field-label', 'Order of providers'),
        rows.length ? list : h('p.muted', accounts.length ? 'No provider takes part yet: open a provider and turn on "Use in Auto mode".' : 'Add a provider first.'),
        toggle('Also use pay-per-use providers', auto.payPerUse === true, (v) => save({ payPerUse: v }),
          PAY_PER_USE_HELP),
      ] : null,
      // Sessions on one provider: one fold from the list, as it was before.
      fold('limit-advanced', 'Advanced', fixedPanel(auto)));
    if (flash) setTimeout(() => mark.show(), 0);
  }
  draw();
  return box;
}

/** Advanced: sessions started on one fixed account while Auto mode is on. */
function fixedPanel(auto) {
  const st = { returnToPreferred: auto.returnToPreferred, prompt: auto.prompt || '' };
  return panel({ icon: 'swap', title: 'Sessions on one provider', desc: 'For sessions started on a fixed provider instead of Auto, while Auto mode is on: what happens at a limit.' },
    toggle('Go back to the first provider', st.returnToPreferred, (v) => { st.returnToPreferred = v; return false; }, // kept by Save below
      'When a provider higher in the order is free again, the session moves back at the end of its current reply.'),
    h('label.fieldrow', h('span.field-label', 'Message after a move'), h('input.field', { value: st.prompt, maxlength: 500, oninput: (e) => (st.prompt = e.target.value) }),
      h('span.hint', 'Typed into the session after it moved to another provider, so Claude Code carries on with the work.')),
    saveBar('Save', () => api('/api/settings', { autoSwitch: { returnToPreferred: st.returnToPreferred, prompt: st.prompt } })));
}

// What a provider is in one word for its row: the plan of a Claude sign-in (a key has none: Subscription), API, OpenAI API, Codex.
const planWord = (a) => (CLAUDE_SIGNIN.includes(a.kind) ? (isPaid(a) ? 'Billed by use' : a.plan ? PLAN(a.plan) : 'Subscription')
  : a.kind === 'api' ? (a.viaGateway ? '' : 'API') : a.kind === 'openai' ? 'OpenAI API' : a.kind === 'chatgpt' ? 'Codex' : kindLabel(a));

/** The two limit bars of a row, side by side; each 5-hour or Week with its figure, and `back …` from 80%. */
function acctBars(a) {
  const bars = barsOf(a);
  if (!bars.length) return null;
  return h('span.acct-bars', bars.map((x) => h('span.acct-bar',
    h('span.acct-bar-top', h('span.acct-bar-label', x.label), h('span.acct-bar-pct', `${x.pct}%`)),
    h(`span.meter${x.pct >= 90 ? '.hot' : x.pct >= 80 ? '.warm' : ''}`, h('i', { style: { width: `${Math.min(100, Math.max(0, x.pct))}%` } })),
    x.back ? h('span.acct-bar-back', x.back) : null)));
}

/**
 * One provider in the list: its name and plan, its state in words with a dot, its two limits, and the ONE button its
 * state asks for. `signIn(a)`: sign in (again); `another(a)`: sign in with another Claude account; `reading`: the
 * limits of a subscription are being read (a small spinner in place of its bars).
 */
function accountRow(a, place, autoOn, signIn, another, own = null, payPerUse = false, reading = false) {
  const ps = profileState(a);
  // Pay-per-use is Auto mode's switch: only a provider in Auto mode's order is left out by it, never one he picks himself.
  const off = autoOn && place && leftOut(a, payPerUse);
  const page = link(`#/providers/${encodeURIComponent(a.name)}`);
  const button = rowButton(a, Boolean(signIn), usesStoredLogin(a));
  const plan = planWord(a);
  const sub = off ? stateWords(a, false) : ps.text;
  const extra = [remoteText(a), a.kind === 'api' && a.viaGateway && ps.key === 'free' ? 'billed by your gateway' : null].filter(Boolean).join(' · ');
  const slow = a.speed && ['slow', 'refusing'].includes(a.speed.verdict) ? speedWords(a.speed) : null;
  const press = (fn) => (e) => { e.stopPropagation(); fn(a); };
  // A row with its own button is not a link element (a button inside a link is not allowed): it opens on a tap.
  return h(`div.row.acct.ps-${ps.key}${a.remote && a.remote.state !== 'online' ? '.gw-off' : ''}`, {
    tabindex: 0, role: 'link', 'aria-label': `${a.label}: ${ps.text}`,
    onclick: () => (location.hash = page),
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) location.hash = page; },
  },
  h('span.row-icon', icon(kindIcon(a.kind))),
  h('span.row-main',
    h('span.row-title',
      // The round number is the place in the order Auto mode takes; it shows only while Auto mode carries on.
      autoOn && place && !off ? h('span.order-n', { title: `${ORDINAL(place)} in Auto mode's order` }, String(place)) : null,
      h('span.row-name', a.label), plan ? h('span.row-plan', ` · ${plan}`) : null, a.hub ? h('span.hub-word.muted', ' hub') : null),
    h('span.row-sub.state', h('span.dot'), h('span', extra ? `${sub} · ${extra}` : sub)),
    worksWith(a) && !servesClaude(a) ? h('span.row-sub.acct-tools', worksWith(a)) : null,
    slow ? h('span.row-sub.acct-speed', slow) : null,
    own && servesClaude(a) ? h('span.row-sub.own-note', icon('alert', { size: 14 }), h('span', ownNote(own))) : null,
    reading && askedByRefresh(a) ? h('span.acct-reading', h('span.spinner.small', { 'aria-hidden': 'true' }), h('span', 'Reading…'))
      : ps.key === 'signin' || ps.key === 'unusable' ? null : acctBars(a),
    button ? h(`button.btn.small.${button.kind === 'signin' ? 'primary' : 'secondary'}.acct-btn`, { type: 'button', onclick: press(button.kind === 'signin' ? signIn : another) }, icon('user', { size: 15 }), h('span', button.label)) : null),
  h('span.row-end', icon('chevronRight', { size: 18 })));
}

// The addresses of what used to be parts of this page: the gateway's cards moved to the TRouteAI page, the limit rule's
// Advanced fold into the sheet of its row.
export const GATEWAY_PARTS = ['gateways', 'trouteai'];
export const LIMIT_PARTS = ['accounts', 'auto-how', 'at-limit'];

/**
 * The gateway as one row among the providers: its name, one word of status, and which provider uses it. A stopped gateway
 * beside a provider that goes through it says that provider cannot answer, so the two lines never seem to disagree; with
 * no provider through it, the line names the gateway the sessions use instead.
 */
export const gatewayWords = (host, accounts = []) => {
  if (!host) return '';
  const g = (host.gateways || []).find((x) => x.id === 'trouteai' && !x.defined);
  const word = !g || !g.installed ? 'Not installed' : g.problem ? 'Needs attention' : g.running ? 'Running' : 'Stopped';
  if (!g || !g.installed) return word;
  const via = accounts.filter((a) => a.viaGateway && a.viaGateway.id === 'trouteai');
  if (via.length) return g.running && !g.problem ? `${word} · used by ${via[0].label}${via.length > 1 ? ` and ${via.length - 1} more` : ''}` : `${word} · ${via[0].label} cannot answer until it runs`;
  const other = accounts.find((a) => a.viaGateway || a.remote);
  if (other) return `${word} · your sessions use ${other.viaGateway ? other.viaGateway.title : other.remote.title || 'another gateway'}`;
  return word;
};

/** The state lines (and the order of the groups) count down once a minute while the page is open. */
const REDRAW_MS = 60_000;

function viewAccounts({ frame, sub, query }) {
  store.viewing = null;
  if (sub === 'trouteai') return viewTrouteai({ frame, sub, query });
  if (sub) return viewAccount(frame, decodeURIComponent(sub));
  const here = !machine.current;
  // An old address of the gateway's cards lands on its page.
  if (GATEWAY_PARTS.includes(partOf(query))) {
    location.replace(link('#/providers/trouteai'));
    return () => {};
  }
  const body = h('div', h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Loading providers…')));
  let data = null;
  let host = null;
  let auto = null;
  let reading = false;
  let readAt = null; // the last Refresh of this page (the server's own time is data.limitsReadAt)
  const refresh = (flash = false) => {
    store.refresh();
    load(flash);
  };
  frame({
    title: 'Providers',
    page: 'providers',
    primary: here ? { label: 'Add provider', icon: 'plus', onclick: () => data && addWizard(data, refresh) } : null,
    // On a phone in the page head: a floating button sat on the last provider's lines (its sessions, its usage).
    primaryInHead: true,
    body: [body],
  });
  let alive = true;
  const answer = h('div.prov-answer'); // the summary and the groups: drawn again in place, never the whole page
  const signIn = (x) => (x.kind === 'chatgpt' ? (location.hash = link(`#/providers/${encodeURIComponent(x.name)}`)) : signInAgain(x, data, refresh));

  /** Reads every account now (Refresh): busy at once, the rows are drawn again in place when the answer is there. */
  async function readNow() {
    if (reading) return;
    reading = true;
    paint();
    try {
      const r = await api(A('/limits/read'), {});
      readAt = figuresAt(r) || readAt;
      data = { ...(await loadAccounts()), full: true };
      const bad = (r.results || []).filter((x) => x.ok === false && x.error && x.read !== 'signin');
      if (bad.length) toast(`${bad.length === 1 ? bad[0].name : `${bad.length} accounts`} could not be read: ${bad[0].error}`, { kind: 'error', ms: 6000 });
    } catch (e) {
      toast(e, { kind: 'error' });
    }
    reading = false;
    store.refresh();
    if (alive) paint();
  }

  /** The summary line, the Refresh button, and the groups of providers; drawn from `data` (again each minute). */
  function paint() {
    if (!data || !alive) return;
    const order = (auto.order || []).filter((n) => data.accounts.some((a) => a.name === n));
    const groups = groupRows(data.accounts);
    const place = (a) => order.indexOf(a.name) + 1;
    const line = summaryLine(groups);
    const subs = data.accounts.filter(askedByRefresh).length;
    const when = reading ? `Asking ${subs} account${subs === 1 ? '' : 's'} one small question…` : readLine(here, readAt || data.limitsReadAt, data.accounts);
    const rowOf = (a) => accountRow(a, place(a), auto.enabled, here ? signIn : null, here ? () => switchAccount({ done: refresh }) : null, data.ownEndpoint || null, auto.payPerUse === true, reading);
    fill(answer,
      data.accounts.length ? h('div.prov-summary',
        line ? h('p.prov-count', line) : null,
        when || here ? h('div.prov-read', h('span.prov-read-when', when),
          here ? h('button.btn.small.secondary.prov-refresh', { type: 'button', title: 'Asks each subscription one small question; it uses a very small part of its limit', disabled: reading, 'aria-busy': reading ? 'true' : null, onclick: readNow },
            reading ? h('span.spinner.small', { 'aria-hidden': 'true' }) : icon('refresh', { size: 15 }), h('span', reading ? 'Reading…' : 'Refresh')) : null) : null) : null,
      groups.map((g) => [groupHead(g.title, g.rows.length), h('div.rows', g.rows.map(rowOf))]),
      here ? [groupHead('Gateway'), h('div.rows', listRow({ href: link('#/providers/trouteai'), icon: 'swap', title: 'TRouteAI', sub: gatewayWords(host, data.accounts) }))] : null);
  }

  let shownOnce = false;
  let timer = null;
  async function load(flash = false) {
    let settings;
    try {
      [data, settings, host] = await Promise.all([loadAccounts(), api('/api/settings'), here ? api('~/api/gatewayhost').catch(() => null) : null]);
    } catch (e) {
      return fill(body, errorBox(e, load));
    }
    if (!alive) return;
    auto = settings.autoSwitch;
    // The limit rule is on the list itself, open, no press away: after the answer to who can work, because it decides
    // what the numbers on the rows mean. Wide, it is the first card of the right-hand column.
    const limit = data.accounts.length ? panel({ id: 'at-limit', icon: 'zap', title: 'When an account reaches its limit' }, limitBody(auto, data.accounts.filter(servesClaude), () => store.refresh())) : null;
    paint();
    fill(body,
      h('div.prov-grid',
        h('div.prov-main',
          here ? ownEndpointPanel(data.ownEndpoint, () => refresh()) : null,
          here ? ownBackupPanel(data.ownBackup, () => refresh()) : null,
          answer,
          data.accounts.length ? null : emptyState('user', here ? 'No providers yet. Add the subscription, sign-in or API key your coding tools should use.' : `No providers on ${openLabel()} yet. Add one on that computer's own page.`,
            here ? btn('primary', { icon: 'plus', label: 'Add provider', onclick: () => addWizard(data, refresh) }) : null)),
        h('div.prov-side',
          limit,
          here ? gatewaysPanel({ useLocal: (g) => addWizard(data, refresh, { start: g.id }), changed: () => refresh() }) : null,
          here ? null : h('p.hint', `Providers of ${openLabel()} are added on that computer's own page: a key or a sign-in never travels through this one.`),
          // The one switch of the hub's providers: only where another computer of his own is linked, inside a closed fold.
          here && data.hubShare ? fold('hubshare', 'More', toggle('My other computers may use this computer\'s providers', data.hubShare.on === true, async (v) => {
            await api('/api/hubprov/switch', { on: v });
          }, 'They start sessions on these providers without adding any. The keys stay on this computer. Keep a provider to this computer from its own page.')) : null)));
    // The old "?show=<part>" of the limit rule: brought into view once, on the first draw.
    const part = shownOnce ? null : partOf(query);
    shownOnce = true;
    if (LIMIT_PARTS.includes(part)) showPart('at-limit', { alive: () => alive });
    if (!timer) timer = setInterval(() => { if (alive && document.visibilityState !== 'hidden') paint(); }, REDRAW_MS);
  }
  load();
  return () => {
    alive = false;
    clearInterval(timer);
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
      h('a.btn.small.primary', { href: link('#/settings/new-sessions?show=coding-tools') }, 'Coding tools'));
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
        toast(err, { kind: 'error', ms: 8000 });
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
    toast(e, { kind: 'error' });
  }
}

/** A provider no coding tool of this version can use, or whose gateway is gone: why, in one line, and Remove. */
function unusableBox(a, d) {
  const why = a.gatewayGone && a.gatewayGone.notLoaded
    ? `Its gateway ${a.gatewayGone.id} is in config.json but was not loaded (${a.gatewayGone.notLoaded}), so its sessions will not start. Fix it there, or remove this provider.`
    : a.gatewayGone
    ? `Its gateway ${a.gatewayGone.id} was removed from this computer, so its sessions will not start. Add that gateway again, or remove this provider.`
    : a.kind === 'chatgpt'
    ? 'This is the sign-in of a coding tool that this version of Hoprig does not offer, so nothing uses it. It is kept until you remove it.'
    : `No coding tool of this version of Hoprig can use this provider, so nothing uses it.${KEYED.includes(a.kind) ? ' If its address answers more now, Test it again; otherwise remove it.' : ''}`;
  return h('div.banner.muted.mbanner.acct-unusable', icon('info', { size: 18 }), h('span', why),
    d.full ? btn('small danger', { icon: 'trash', label: 'Remove', onclick: () => removeProvider(a) }) : null);
}

/**
 * The head of a provider's page, drawn once. Later the title and the one line under it are changed in place: drawing the
 * whole frame again rebuilt the menu and the head and threw the page back to the top at every press that refreshed.
 */
export function pageHead(frame, first, second) {
  let drawn = false;
  return (title, intro = null) => {
    if (!drawn || !document.querySelector('main.page .page-title')) {
      drawn = true;
      return frame({ title, intro, ...first, ...second });
    }
    document.querySelector('main.page .page-title').textContent = title;
    const row = document.querySelector('main.page .pagehead-text');
    let line = row.querySelector('.page-intro');
    if (!intro) return line && line.remove();
    if (!line) add(row, (line = h('p.page-intro')));
    line.classList.add('acct-intro');
    line.textContent = intro;
  };
}

/** A load that has not answered after this long says so, with Try again. */
export const SLOW_MS = 8000;

function viewAccount(frame, name) {
  const body = h('div', h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Loading…')));
  // The title is the account's name: known at once from the list the page already holds, changed in place when the
  // answer comes (and after a rename), never drawn as a second frame.
  const draw = pageHead(frame, { page: 'providers', back: link('#/providers'), backLabel: 'Providers', body: [body] }, {});
  draw(((store.data && store.data.profiles) || []).find((p) => p.name === name)?.label || 'Provider');
  let alive = true;
  let run = 0;
  let health = null; // the check, the model map and what is left: made once per visit, asked again in place
  const refresh = () => {
    store.refresh();
    load();
  };
  async function load() {
    const mine = ++run;
    // The page keeps what it shows while it asks again; only a first load with nothing yet shows the waiting.
    const slow = setTimeout(() => {
      if (alive && mine === run && !body.querySelector('.card')) {
        fill(body, h('div.empty.compact', h('p', 'This is taking longer than usual. The computer may be busy or not answering.'),
          btn('secondary', { icon: 'refresh', label: 'Try again', onclick: () => { fill(body, h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Loading…'))); load(); } })));
      }
    }, SLOW_MS);
    let d;
    try {
      d = await loadAccounts();
    } catch (e) {
      clearTimeout(slow);
      if (mine !== run) return;
      return fill(body, errorBox(e, load));
    }
    clearTimeout(slow);
    if (mine !== run) return;
    // Asking again keeps the page where it was: the parts that draw themselves a moment later (the check, what is left)
    // would shorten it for that moment and throw a scrolled page to the top, so it keeps its height for a second.
    const keepH = body.querySelector('.card') ? body.offsetHeight : 0;
    if (keepH) {
      body.style.minHeight = `${keepH}px`;
      setTimeout(() => { body.style.minHeight = ''; }, 1500);
    }
    if (!alive) return;
    const a = d.accounts.find((x) => x.name === name);
    if (!a) return fill(body, emptyState('user', 'There is no such provider on this computer.', h('a.btn.secondary', { href: link('#/providers') }, 'All providers')));
    const ps = profileState(a);
    const what = [kindText(a), a.remote ? remoteText(a) : a.viaGateway ? `via ${a.viaGateway.title}` : a.host || '', a.model ? `model ${a.model}` : ''].filter(Boolean).join(' · ');
    draw(a.label, what);
    const claude = servesClaude(a);
    const healthOf = (n) => {
      if (health) health.reload();
      else health = providerHealth(n);
      return health;
    };
    // `quick`: the press asks the computer and does not open a sheet, so the row shows it is busy until the answer is there.
    const act = (ic, label, sub, fn, quick = false) => h('button.row.acct-act', { type: 'button', onclick: async (e) => {
      const row = e.currentTarget;
      if (quick) {
        row.disabled = true;
        row.setAttribute('aria-busy', 'true');
        row.classList.add('row-busy');
      }
      try {
        await fn();
      } catch (err) {
        toast(err, { kind: 'error', ms: 8000 });
      }
      if (quick) {
        row.disabled = false;
        row.removeAttribute('aria-busy');
        row.classList.remove('row-busy');
      }
    } }, h('span.row-icon', icon(ic)), h('span.row-main', h('span.row-title', label), sub ? h('span.row-sub', sub) : null), h('span.row-end', icon('chevronRight', { size: 18 })));
    // Claude Code's stored sign-in, on this dashboard's own computer: who is signed in, and the two things to do
    // with it. (A provider with its own account token is signed in again through its wizard.)
    const stored = usesStoredLogin(a) && d.full && !machine.current;
    const ownPage = d.full && !machine.current; // this dashboard's own computer: the only one that reads limits or signs in
    const needsSignin = ps.key === 'signin' && a.kind !== 'chatgpt' && !a.unusable && !a.gatewayGone;
    const who = stored && ps.key !== 'signin' ? h('p.acct-who.hint', 'Asking Claude Code who is signed in…') : null;
    if (who) {
      loadAccount().then((x) => alive && fill(who, x.loggedIn ? ['Signed in as ', h('strong', accountText(x) || 'a Claude account')] : 'Claude Code reports no sign-in.'))
        .catch(() => alive && fill(who));
    }
    const st = store.all.find((m) => m.machine === machine.current);
    const order = (st && st.autoSwitch && st.autoSwitch.order) || [];
    const reasonLine = a.signinRefused ? `Claude answered at ${clockAt(a.signinRefused.at)} that this sign-in is no longer valid.`
      : a.signedOut ? 'Signed out on this computer.' : a.hub ? 'This provider has no sign-in on this computer yet.' : 'No sign-in yet.';
    const readNowBtn = (ownPage && CLAUDE_SIGNIN.includes(a.kind) && !a.hub && !a.unusable) ? h('div.acct-read',
      h('span.hint', a.usage && a.usage.at ? `Read ${ago(a.usage.at)}` : 'Limits not read yet'),
      btn('small secondary', { icon: 'refresh', label: 'Read now', onclick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        b.setAttribute('aria-busy', 'true');
        try {
          const r = await api(A('/limits/read'), { name: a.name });
          const res = resultOf(r, a.name);
          if (res && res.ok === false && res.read !== 'signin') toast(`${a.label} could not be read: ${res.error}`, { kind: 'error', ms: 6000 });
        } catch (err) {
          toast(err, { kind: 'error' });
        }
        refresh();
      } })) : null;
    const statePanel = panel({},
      h(`p.acct-state.ps-${ps.key}`, h('span.dot'), ps.text),
      who,
      a.unusable || a.gatewayGone ? unusableBox(a, d)
        : a.kind === 'chatgpt' ? codexSigninBox(a, d) : needsSignin
        ? h('div.banner.warn.mbanner', icon('alert', { size: 18 }), h('span', reasonLine),
          d.full ? btn('small primary', { icon: 'user', label: a.hub ? 'Sign in here' : a.signinRefused ? 'Sign in again' : 'Sign in', onclick: () => signInAgain(a, d, refresh) }) : null)
          : CLAUDE_SIGNIN.includes(a.kind) || a.kind === 'api'
          ? usageBars(a.usage, a.usageReported, a.inUse > 0) || (a.kind === 'api' && isPaid(a) ? h('p.hint', 'Billed by use: no limits to show.') : h('p.hint', 'No usage figures yet: they appear after the first answer on this provider.'))
          : null,
      stored && ps.key === 'limit'
        ? h('div.banner.warn.mbanner.acct-limit', icon('alert', { size: 18 }), h('span', 'The work goes on under this provider with the other account.'),
          btn('small primary', { icon: 'user', label: 'Sign in with another account', onclick: () => switchAccount({ done: refresh }) }))
        : null,
      readNowBtn);
    // Where each press stands, in the order he uses them (a press that is card 1's own button is not repeated below).
    const rowsA = d.full && !a.hub ? [
      a.viaGateway && a.viaGateway.id === 'trouteai' ? act('swap', 'TRouteAI', 'Its accounts and their limits', () => { location.hash = link('#/providers/trouteai'); }) : null,
      a.kind === 'subscription' && ownPage && !needsSignin && !a.signedOut ? act('user', 'Sign in again', 'This account or another: the old sign-in stays until the new one works', () => signInAgain(a, d, refresh)) : null,
      (stored && ps.key !== 'signin') || (a.kind === 'subscription' && ownPage && !needsSignin)
        ? act('user', 'Sign in with another account', a.kind === 'subscription' ? 'The old sign-in stays until the new one works' : 'Sessions keep running, on the new account',
          () => (a.kind === 'subscription' ? addWizard(d, refresh, { signIn: a, another: true }) : switchAccount({ done: refresh }))) : null,
      stored && ps.key !== 'signin' ? act('logout', 'Sign out', 'Claude Code forgets this sign-in', () => signOut({ done: refresh }))
        : a.kind === 'subscription' && ownPage && !a.signedOut ? act('logout', 'Sign out', 'This computer forgets the key', () => signOut({ provider: a, done: refresh })) : null,
    ] : [];
    const rowsB = d.full && !a.hub ? [
      act('pencil', 'Rename', 'The name shown everywhere', async () => {
        const label = await promptSheet({ title: 'Rename provider', value: a.label, ok: 'Rename', check: (v) => (v.trim() && v.length <= 60 ? '' : 'One line, up to 60 characters') });
        if (!label) return;
        await api(A(`/${encodeURIComponent(a.name)}/label`), { label });
        toast('Renamed');
        refresh();
      }),
      // Only on the computer that holds the key, and only where another computer of his own is linked.
      typeof a.kept === 'boolean' ? act('lock', a.kept ? 'Share with your other computers' : 'Keep to this computer', a.kept ? 'Now only this computer uses it' : 'Your other computers may use it', async () => {
        await api(`/api/hubprov/${encodeURIComponent(a.name)}/keep`, { on: !a.kept });
        refresh();
      }, true) : null,
      KEYED.includes(a.kind) ? act('sparkle', 'Change model', a.model ? `Now: ${a.model}` : 'Pick the model this provider uses', () => modelSheet(a, refresh)) : null,
      KEYED.includes(a.kind) ? testRow(a, refresh) : null,
      a.limited && a.limited.reason !== 'auth' ? act('refresh', 'It is free again', 'Mark it as no longer at its limit', async () => {
        await api(at(machine.current, `/api/profiles/${encodeURIComponent(a.name)}/available`), {});
        toast(`${a.label} is available again`);
        refresh();
      }, true) : null,
    ] : [];
    const place = order.indexOf(a.name) + 1;
    fill(body,
      statePanel,
      rowsA.some(Boolean) ? h('div.rows', rowsA) : null,
      d.full && claude ? panel({}, toggle('Use in Auto mode', a.inAuto, async (on) => {
        try {
          const r = await api(A(`/${encodeURIComponent(a.name)}/auto`), { on });
          toast(autoToast(a, on, r), r && r.payPerUseTurnedOn ? { ms: 8000 } : undefined);
          refresh();
        } catch (e) {
          toast(e, { kind: 'error' });
          refresh();
        }
      }, autoHelp(a, d.payPerUse === true)), a.inAuto && place ? h('p.hint.acct-place', `${ORDINAL(place)} of ${order.length} in the order`) : null) : null,
      rowsB.some(Boolean) ? h('div.rows', rowsB) : null,
      d.full && claude && !a.unusable && !a.hub ? healthOf(a.name) : null, // its check, its model map, what is left (providerhealth.js)
      a.hub ? h('p.hint', `This provider is ${a.hubLabel ? `${a.hubLabel}'s` : 'your hub\'s'}. It is changed on that computer.`) : null,
      worksWith(a) ? h('p.hint.acct-works', worksWith(a)) : null,
      speedWords(a.speed) ? h('p.hint.acct-speed', speedWords(a.speed)) : null,
      testResult(a),
      a.kind === 'chatgpt' && !a.unusable ? h('p.hint', 'Codex uses the ChatGPT account it is signed in to on this computer. In a terminal, the same is ', h('code', `${COMMAND} codex login --device-auth`), '.') : null,
      signinHint(a) ? h('p.hint', signinHint(a)) : null,
      a.kind === 'login' && a.ownFolder ? h('p.hint.acct-own-folder', 'This provider keeps its Claude Code sign-in in a folder of its own, so this page cannot see or change it. To sign it in, start a terminal session on this provider and type /login there.') : null,
      d.full && !a.hub ? fold('account', 'Advanced',
        h('p.hint', `Short name: ${a.name} (for the command line).`),
        h('div.savebar', btn('danger', { icon: 'trash', label: 'Remove this provider', onclick: () => removeProvider(a) }))) : a.hub ? null : h('p.hint', 'This computer runs an older version: its providers are changed on its own page.'));
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
        fill(panel, errorBox(e));
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
          fill(out, errorBox(e));
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
  const main = has ? h('select.field', options(current || middleModel(list), false)) : h('input.field.mono', { value: current, placeholder: 'e.g. claude-sonnet-4-5 or provider/model', autocapitalize: 'off', spellcheck: 'false' });
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

/**
 * "Other providers" in Add provider: through the one gateway of this computer (its own title and sentence), or, with
 * more than one, a step that asks which (pick: true). Null when the computer knows no gateway.
 */
export function otherProvidersChoice(gws) {
  if (!gws || !gws.length) return null;
  if (gws.length === 1) return { pick: false, id: gws[0].id, title: `Other providers through ${gws[0].title} (for Claude Code)`, sub: gws[0].words.choice };
  return {
    pick: true,
    title: 'Other providers through a gateway (for Claude Code)',
    sub: `OpenAI, Gemini, OpenRouter or a local model, translated for Claude Code by a gateway on this computer: ${gws.map((g) => g.title).join(', ')}.`,
  };
}

/** The step of a gateway that is there but not running: today's sentence for a package with a page of its own. */
export const notRunningText = (g) => `${g.title} is ${g.installable ? 'installed' : 'on this computer'} but not running. Start it, then add your provider ${g.page ? 'in its page' : 'in it'} and come back with a key.`;

/** Add a provider; with `signIn` (a provider), sign that one in again: straight to the sign-in link. */
function addWizard(data, done, { signIn = null, start = null, another = false } = {}) {
  let cleanup = null;
  openSheet(signIn ? { title: another ? `Sign in to ${signIn.label} with another account` : `Sign in again to ${signIn.label}`, subtitle: 'With the Claude account this provider uses. Until the code is accepted, nothing changes.' } : { title: 'Add provider', subtitle: 'Choose what you want to add' }, (close) => {
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
          // Only while Codex is offered (src/codetools/offered.mjs): the server sends its defaults then.
          data.defaults && data.defaults.codex ? choice('user', 'Codex sign-in', 'The ChatGPT account Codex signs in to on this computer. For Codex only.', () => codexSignin()) : null,
          otherProviders()),
        terminalLink());
    const gateways = () => data.gateways || [];
    function otherProviders() {
      const o = otherProvidersChoice(gateways());
      return o ? choice('sparkle', o.title, o.sub, () => (o.pick ? pickGateway() : viaGateway(o.id))) : null;
    }
    function pickGateway() {
      fill(panel, back(),
        h('p.sheet-text', 'Which gateway on this computer?'),
        h('div.choice-list', gateways().map((g) => choice('sparkle', g.title, g.words.choice, () => viaGateway(g.id)))));
    }
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
        fill(out, busy('Getting a sign-in link from Claude (up to a minute)…'));
        try {
          const r = await api(A('/subscription/start'), { name: name.value, label: label.value });
          cleanup = () => api(A('/subscription/cancel'), {}).catch(() => {});
          linkStep(r);
        } catch (e) {
          fill(out, errorBox(e), terminalLink());
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
          // Read that one account at once, so its row moves to Can work now with its figures and not to "not known".
          if (signIn) {
            fill(out, busy('Reading its limits…'));
            await api(A('/limits/read'), { name: signIn.name }).catch(() => {});
          }
          finish(signIn ? `${res.label || signIn.label} is signed in again` : `${res.label} added`);
        } catch (e) {
          cleanup = null;
          fill(out, errorBox(e), h('div.savebar', btn('secondary', { icon: 'refresh', label: 'Start again', onclick: subscription })), terminalLink());
        }
      });
      // Where the browser can read the clipboard, a phone needs no long press to paste the code.
      const paste = navigator.clipboard && navigator.clipboard.readText
        ? btn('secondary small', { icon: 'copy', label: 'Paste', onclick: async () => { try { code.value = (await navigator.clipboard.readText()).trim(); } catch { code.focus(); } } }) : null;
      const first = another ? 'Open this link. If claude.ai shows the account of now, sign out there first (or open the link in a private window), then sign in with the other account.'
        : signIn ? 'Open this link and sign in with the Claude account this provider uses.' : 'Open this link and sign in with the account you want to add.';
      fill(panel, back(),
        steps(
          [h('p', first),
            h('div.btnrow',
              h('a.btn.primary', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, icon('external', { size: 18 }), h('span', 'Open the sign-in page')),
              btn('secondary', { icon: 'copy', label: 'Copy link', onclick: async () => toast((await copyText(r.url)) ? 'Link copied' : 'Copy did not work') }))],
          [h('p', 'After you allow access, the page shows a code. Paste it here.'), h('div.pasterow', code, paste)],
        ),
        out,
        h('p.hint', 'The sign-in stays open for 10 minutes.'),
        h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: async () => { await cleanup?.(); cleanup = null; close(); } }, 'Cancel'), add));
      code.focus();
    }

    // ---------- an API key (Claude's API directly, or through a gateway) ----------
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
          fill(out, errorBox(e));
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

    // `gw`: the gateway this key is for (via is then its id).
    function apiForm({ via, gw = null, baseUrl: fixedBase = null, intro = null }) {
      const d = gw ? gw.defaults : via === 'openai' ? data.defaults.openai || { name: 'openai', label: 'OpenAI API', baseUrl: 'https://api.openai.com' } : data.defaults.api;
      const baseUrl = h('input.field.mono', { type: 'url', value: fixedBase || d.baseUrl, autocapitalize: 'off', spellcheck: 'false' });
      const key = h('input.field.mono', { type: 'password', placeholder: gw ? `The key you created in ${gw.title}` : via === 'openai' ? 'sk-…' : 'sk-ant-…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
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
          fill(panel, back(), h('div.picked-value', icon('key', { size: 18 }), h('span', probe.baseUrl), btn('small ghost', { label: 'Change', onclick: () => apiForm({ via, gw, baseUrl: fixedBase, intro }) })), out);
          modelStep(probe, { via, name, label, out, find });
        } catch (e) {
          fill(out, errorBox(e));
          find.disabled = false;
        }
      });
      fill(panel, back(),
        intro,
        field('Address of the API', baseUrl, gw ? `${gw.title} on this computer. Change it only if you moved ${gw.title}.` : via === 'openai' ? 'Leave it for a key from platform.openai.com; change it for a service that speaks OpenAI\'s API.' : 'Leave it for a key from console.anthropic.com; change it for a gateway.'),
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
          fill(result, errorBox(t.error), h('div.savebar', btn('secondary', { label: 'Save anyway', onclick: () => doSave(model).catch((e) => fill(result, errorBox(e))) })));
        } catch (e) {
          fill(result, errorBox(e));
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

    // ---------- other providers through a gateway on this computer ----------
    async function viaGateway(id) {
      const known = gateways().find((x) => x.id === id);
      fill(panel, back(), busy(`Checking ${known ? known.title : 'the gateway'} on the computer…`));
      let g;
      let signedIn = [];
      try {
        const d = await api(A(''));
        g = (d.gateways || []).find((x) => x.id === id);
        signedIn = Array.isArray(d.signedIn) ? d.signedIn : [];
      } catch (e) {
        return fill(panel, back(), errorBox(e));
      }
      if (!g) return fill(panel, back(), errorBox('This gateway is not available on this computer.'));
      const again = () => viaGateway(id);
      // Its program is not there: what Hoprig starts it with, on the page (GET /api/gateways, as hoprig gateways says it).
      const missing = (gw) => {
        const box = h('div', busy(`Looking up what ${gw.title} runs…`));
        api(at(machine.current, '/api/gateways')).catch(() => null).then((r) => {
          const view = r && Array.isArray(r.gateways) ? r.gateways.find((x) => x.id === gw.id) || null : null;
          const [text, runs] = programFacts(gw.title, view);
          fill(box, errorBox(text, again), runs ? h('pre.output', runs) : null);
        });
        return box;
      };
      const job = h('pre.output.hidden', { 'aria-live': 'polite' });
      const run = async (action, then) => {
        job.classList.remove('hidden');
        fill(job);
        try {
          let body = {};
          if (action === 'install' || action === 'update') {
            // It changes what is installed on this computer: asked first, naming it; the server checks the name.
            const computer = (await api('~/api/addons')).computer || 'this computer';
            if (!(await confirmSheet({ title: `Install ${g.title} on ${computer}?`, text: `${g.title} is installed with npm on ${computer}. Its lines show here as they come.`, ok: `Install on ${computer}` }))) {
              job.classList.add('hidden');
              return then && then();
            }
            body = { confirm: computer };
          }
          await api(`~/api/addons/${encodeURIComponent(g.id)}/${action}`, body);
          let from = 0;
          for (;;) {
            await new Promise((r) => setTimeout(r, 1000));
            const j = await api(`~/api/addons/${encodeURIComponent(g.id)}/job?from=${from}`);
            if (j.lines.length) fill(job, job.textContent + j.lines.join('\n') + '\n');
            from = j.next;
            job.scrollTop = job.scrollHeight;
            if (!j.running) {
              if (j.result && !j.result.ok) throw new Error(j.result.error || `${g.title} could not ${action}`);
              return then();
            }
          }
        } catch (e) {
          add(panel, errorBox(e));
        }
      };
      // The gateway Hoprig sets up itself: one press does the install, the start, the key and the provider.
      if (g.setup) {
        const pageLink = () => gatewayPageLink(g.page, { title: g.title, pageHost: location.hostname, signedIn, other: Boolean(machine.current) }); // looked up when it is running
        return fill(panel, back(),
          h('p.sheet-text', g.words.what),
          setupBlock(g, {
            done: () => done(),
            after: () => { const gpSetup = pageLink(); return h('div', h('p', g.words.add), gpSetup && gpSetup.href ? h('div.btnrow', h('a.btn.secondary', { href: gpSetup.href, target: '_blank', rel: 'noopener noreferrer' }, icon('external', { size: 18 }), h('span', `Open ${g.title}`))) : null); },
            secondary: h('div.savebar.start', btn('small ghost', { label: 'Paste a key you made yourself instead', onclick: () => pasteKey(g, signedIn, again, missing, job, run) })),
          }));
      }
      return pasteKey(g, signedIn, again, missing, job, run);
    }
    function pasteKey(g, signedIn, again, missing, job, run) {
      if (!g.installed) {
        // A program that is not a package (the owner's own gateway) is not installed from here: it is there or not.
        // Its sentence says it is on this computer, so a missing program gets its own words, and Try again looks again.
        return fill(panel, back(),
          g.installable ? h('p.sheet-text', g.words.what) : null,
          g.installable
            ? btn('primary block', { icon: 'download', label: `Install ${g.title}`, onclick: (e) => { e.currentTarget.disabled = true; run('install', again); } })
            : missing(g),
          job);
      }
      if (!g.running) {
        return fill(panel, back(),
          h('p.sheet-text', notRunningText(g)),
          btn('primary block', { icon: 'play', label: `Start ${g.title}`, onclick: (e) => { e.currentTarget.disabled = true; run('start', again); } }),
          job);
      }
      // Its own page as this browser can open it: a link on a loopback name, else one sentence of where it opens.
      const gp = gatewayPageLink(g.page, { title: g.title, pageHost: location.hostname, signedIn, other: Boolean(machine.current) });
      const pcUrl = gp && gp.href;
      apiForm({
        via: g.id,
        gw: g,
        intro: h('div',
          steps(
            [h('p', g.words.add),
              pcUrl ? h('div.btnrow', h('a.btn.secondary', { href: pcUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('external', { size: 18 }), h('span', `Open ${g.title}`)), h('span.hint.mono', pcUrl)) : null,
              gp && gp.text ? h('p.hint', gp.text) : null],
            [h('p', g.words.key)],
            [h('p', 'Come back and paste the key below.')]),
          h('p.hint', `${g.title} starts by itself whenever a session on this provider needs it.`)),
      });
    }

    // Signing an existing provider in again: the same sign-in link and code, under its own name.
    async function again() {
      fill(panel, busy('Getting a sign-in link from Claude (up to a minute)…'));
      try {
        const r = await api(A('/subscription/start'), { mode: 'signin', name: signIn.name });
        cleanup = () => api(A('/subscription/cancel'), {}).catch(() => {});
        linkStep(r);
      } catch (e) {
        // One left open (a page closed mid-way, another device): it can be ended here, then this one starts.
        const busy = /in progress/i.test(e.message);
        fill(panel, errorBox(e, busy ? null : again),
          busy ? h('div.savebar.start', btn('secondary', { icon: 'x', label: 'Cancel that sign-in and start again', onclick: async () => { await api(A('/subscription/cancel'), {}).catch(() => {}); again(); } })) : null,
          terminalLink());
      }
    }

    if (signIn) again();
    else if (start) viaGateway(start); // one of this computer's gateways: straight to its steps
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
