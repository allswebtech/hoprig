// TRouteAI's own page (#/providers/trouteai): is it running, open it, what is in it, and everything to manage it.
// The first phone screen holds five things and nothing dangerous: the status line, Open TRouteAI, the Accounts (its head,
// Read limits now, up to three compact rows), Add account and the top of the first fold. The rest is one press away in
// folds that start closed: Combos, Public address, Share with your other computers, Manage (where Stop and Remove are).
// One load when the page opens or after a press; nothing polls. Every press goes to this computer's own routes
// (/api/gatewayhost/trouteai/…) and asks first. The router (web/accounts.js) hands #/providers/trouteai to trouteaiPage.
import { icon } from './icons.js';
import { api, btn, confirmSheet, copyText, fill, h, link, machine, toast } from './lib.js';
import { errorBox, fold, okBox, skeletonRows, toggle } from './shell.js';
import { otherComputers, setupBlock, sharing } from './gateways.js';
import { accountSheet, addSheet, combosPart, compactRow, keysSheet, openGatewayPage, publicOffWords } from './trouteai.js';
import { bootSheet, lingerLine, passwordSheet, removeIt, restartIt, showFirst, showLog, startIt, stopIt, updateIt } from './gatewayacts.js';

const ID = 'trouteai';
const T = (p) => `~/api/gatewayhost/${ID}${p}`;
/** Accounts shown before "All N accounts". */
export const ROWS_SHOWN = 5;
export const PUBLIC_SENTENCE = 'Anyone on the internet can then reach two things at this address: TRouteAI\'s page, behind its password, and its model address, behind its keys.';

/** The one line of what a refused public address needs, and the press that fixes it: [sentence, kind]. */
export function publicNeed(p) {
  const words = {
    'link-custom': ['Set up Hoprig\'s public link as Custom first (Settings, Public link).', 'settings'],
    'link-off': ['Turn Hoprig\'s public link on first (Settings, Public link).', 'settings'],
    'first-password': ['TRouteAI still uses its first password. Set your own first.', 'password'],
    'no-password': ['TRouteAI has no password. Set one first.', 'password'],
    'open-api': ['TRouteAI answers its model address without a key, so it stays private.', null],
    'not-running': ['Start TRouteAI first.', 'start'],
    'dns-taken': [`There is already a DNS record for ${p.hostname} in Cloudflare. Delete it there first.`, null],
  }[p.need];
  return words || [p.why || 'TRouteAI\'s public address cannot be turned on now.', null];
}

/** The public address fold: its words by state. `ctx`: { computer, reload, out, g, port }. */
function publicFold(p, ctx) {
  const on = p.state === 'on';
  const f = fold('trouteai-public', `Public address · ${on ? 'On' : 'Off'}`);
  const body = f.querySelector('.fold-body');
  const sw = toggle(on ? 'Reach TRouteAI from anywhere' : `Reach TRouteAI from anywhere${p.hostname ? ` at https://${p.hostname}` : ''}`, on, async (want) => {
    const input = sw.querySelector('input');
    const ok = await confirmSheet(want
      ? { title: 'Open TRouteAI to the internet?', text: `${PUBLIC_SENTENCE} TRouteAI restarts once so its own links use this address. Sessions that use it wait a moment.`, ok: 'Turn on' }
      : { title: 'Close TRouteAI to the internet?', text: 'The address stops leading to TRouteAI, and TRouteAI restarts once. Its DNS record stays in Cloudflare: delete it there if you no longer need it.', ok: 'Turn off', danger: true });
    if (!ok) {
      input.checked = !want;
      return false;
    }
    try {
      const r = await api(T('/public'), { confirm: ctx.computer, on: want });
      fill(ctx.out, okBox((r.lines || []).join('. ') || (want ? 'TRouteAI has a public address.' : 'TRouteAI is closed to the internet.')));
    } catch (e) {
      input.checked = !want;
      fill(ctx.out, errorBox(e));
      return false;
    }
    ctx.reload();
    return true;
  });
  if (on) {
    fill(body,
      h('div.btnrow', h('input.field.mono', { value: p.url, readonly: true, 'aria-label': 'TRouteAI public address', onfocus: (e) => e.target.select() }),
        btn('secondary', { icon: 'copy', label: 'Copy', onclick: async () => toast((await copyText(p.url)) ? 'Address copied' : 'Copy did not work') }),
        h('a.btn.secondary', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open')),
      p.answers === false ? h('p.hint', 'It does not answer from here yet.') : null,
      p.linkOn === false ? h('p.hint', 'It does not answer until Hoprig\'s public link is on again.') : null,
      p.told === false ? h('p.hint', 'TRouteAI uses this address for its own links after its next restart (Restart is under Manage).') : null,
      h('p.hint', PUBLIC_SENTENCE), sw);
    return f;
  }
  if (p.state === 'unavailable') {
    const [sentence, kind] = publicNeed(p);
    fill(body, h('p.hint', sentence),
      kind === 'settings' ? h('a.btn.secondary', { href: link('#/settings/public-link') }, 'Open Settings, Public link') : null,
      kind === 'password' ? btn('secondary', { icon: 'key', label: 'Set a new password', onclick: () => passwordSheet(ctx) }) : null,
      kind === 'start' ? btn('secondary', { icon: 'play', label: 'Start', onclick: () => startIt(ctx) }) : null);
    return f;
  }
  fill(body, h('p.hint', PUBLIC_SENTENCE), sw);
  return f;
}

/** A row of the Manage fold: a title, what it is now, and the press. */
const manageRow = (ic, title, sub, onclick, cls = '') => h(`button.row${cls}`, { type: 'button', onclick },
  h('span.row-icon', icon(ic)), h('span.row-main', h('span.row-title', title), sub ? h('span.row-sub', sub) : null), icon('chevronRight', { size: 18 }));

function manageFold(ctx, gw) {
  const { g } = ctx;
  const boot = g.service && (g.service.kind === 'systemd' || g.service.kind === 'launchd');
  return fold('trouteai-manage', 'Manage',
    h('div', { role: 'status' }, ctx.out),
    lingerLine(ctx.host, ctx.out, ctx.reload),
    h('div.rows',
      boot ? manageRow('restore', 'Start at boot', g.service.made ? 'On' : 'Off', () => bootSheet(ctx)) : null,
      g.running ? manageRow('refresh', 'Restart', null, () => restartIt(ctx)) : null,
      manageRow('download', 'Update', gw && gw.version ? `Version ${gw.version}` : null, () => updateIt(ctx)),
      manageRow('key', 'Password', null, () => passwordSheet(ctx)),
      manageRow('text', 'Log', null, () => showLog(ctx)),
      g.running ? manageRow('key', 'Keys Hoprig made', null, () => keysSheet(ctx)) : null,
      g.firstWaiting ? manageRow('key', 'Show what it printed first', null, () => showFirst(ctx)) : null,
      g.running ? manageRow('stop', 'Stop', null, () => stopIt(ctx)) : null,
      manageRow('trash', 'Remove TRouteAI', null, () => removeIt(ctx), '.tr-danger')));
}

/** The status line: a dot, the state, the version, the computer, and whether sessions use it. */
function statusLine(ctx, gw) {
  const { g } = ctx;
  const used = gw && gw.usedAs;
  const first = g.running ? ['Running', gw && gw.version ? `version ${gw.version}` : null, `on ${ctx.computer}`].filter(Boolean).join(' · ') : 'Not running';
  return h('div.tr-status', { role: 'status' },
    h('div.tr-state', h(`span.tr-dot.${g.running ? 'on' : 'off'}`, { 'aria-hidden': 'true' }), h('span.tr-state-text', first),
      g.running ? null : btn('primary', { icon: 'play', label: 'Start', onclick: () => startIt(ctx) })),
    used
      ? h('p.hint', 'Your sessions use it as ', h('a', { href: link(`#/providers/${encodeURIComponent(used.name)}`) }, used.label || used.name))
      : h('p.hint', 'Your sessions do not use it yet.'));
}

/** The accounts: its head with Read limits now, then up to five compact rows, then "All N accounts". */
function accountsPart(ctx, accounts, first) {
  const list = h('div.rows');
  let all = false;
  let limits = first;
  const paint = () => {
    const shown = all ? accounts : accounts.slice(0, ROWS_SHOWN);
    fill(list, ...(accounts.length
      ? [...shown.map((a) => compactRow(a, limits && limits[a.id], () => accountSheet(a, limits && limits[a.id], ctx, ctx.reload))),
        !all && accounts.length > ROWS_SHOWN ? h('button.row.tr-more', { type: 'button', onclick: () => { all = true; paint(); } }, h('span.row-main', h('span.row-title', `All ${accounts.length} accounts`)), icon('chevronDown', { size: 18 })) : null]
      : [h('p.hint', 'No account yet. Add the provider your coding tools should use.')]));
  };
  paint();
  // Read limits now: every turned-on account is asked live, then the rows show what came back.
  const reread = async (e) => {
    const me = e.currentTarget;
    me.disabled = true;
    try {
      const got = {};
      for (const a of accounts.filter((x) => x.on)) Object.assign(got, (await api(T(`/limits?account=${encodeURIComponent(a.id)}`))).limits);
      limits = got;
      paint();
      toast('Limits read');
    } catch (er) {
      toast(er, { kind: 'error', ms: 9000 });
    }
    me.disabled = false;
  };
  return h('div.tr-accounts',
    h('div.tr-acchead', h('h2.group-head', h('span', 'Accounts'), accounts.length ? h('span.group-count', String(accounts.length)) : null),
      accounts.length ? btn('small secondary', { icon: 'refresh', label: 'Read limits now', onclick: reread }) : null),
    list);
}

/** #/providers/trouteai. `frame` is the page frame the router passes. */
export function trouteaiPage({ frame }) {
  const body = h('div.tr-page', skeletonRows(3));
  frame({ title: 'TRouteAI', intro: 'Lets your coding tools use AI accounts of other companies.', introOnPhone: false, page: 'providers', back: link('#/providers'), backLabel: 'Providers', body: [body] });
  let alive = true;

  async function load() {
    if (machine.current) return fill(body, h('p.hint', 'TRouteAI\'s page is for the computer you are on. Open this dashboard on that computer to manage its TRouteAI.'));
    let host;
    let gws;
    try {
      host = await api('~/api/gatewayhost');
      gws = await api('~/api/gateways/all').catch(() => null);
    } catch (e) {
      return alive && fill(body, errorBox(e, load));
    }
    if (!alive) return;
    const g = (host.gateways || []).find((x) => x.id === ID && !x.defined);
    if (!g) return fill(body, errorBox('This version of Hoprig has no TRouteAI to manage.'));
    const gw = gws && gws.computers && gws.computers[0] ? gws.computers[0].gateways.find((x) => x.id === ID) : null;
    const out = h('div', { role: 'status' });
    const ctx = { g, host, computer: host.computer, port: g.port, out, reload: load, signedIn: host.signedIn || [] };
    const mine = { id: ID, title: g.title };
    if (!g.installed) {
      return fill(body, h('div.tr-status', h('p.tr-state-text', 'TRouteAI is not set up on this computer.')), setupBlock(mine, { done: load }));
    }
    const parts = [statusLine(ctx, gw)];
    if (!(gw && gw.usedAs) && g.running) parts.push(setupBlock(mine, { done: load, label: 'Use it for my sessions' }));
    const problem = g.problem || g.restart;
    if (problem) {
      parts.push(h('div.banner.warn', icon('alert', { size: 18 }), h('span', problem),
        g.problem ? btn('small secondary', { label: 'Update', onclick: () => updateIt(ctx) }) : btn('small secondary', { label: 'Restart', onclick: () => restartIt(ctx) })));
    }
    if (!g.running) {
      parts.push(manageFold(ctx, gw));
      return fill(body, ...parts);
    }
    // Its program runs but nothing answers (the other list knocks on its port): its accounts would be refused, so they
    // are not asked for. One line says so, and Manage has Restart.
    if (gw && gw.running === false) {
      parts.push(h('div.banner.warn', icon('alert', { size: 18 }), h('span', 'It runs, but it does not answer yet. Restart it under Manage.')), manageFold(ctx, gw));
      return fill(body, ...parts);
    }
    const hint = h('p.hint.tr-open-hint', { role: 'status' });
    let pub = { state: 'unavailable', need: 'not-running' };
    let accounts = { accounts: [] };
    let limits = null;
    try {
      [pub, accounts] = await Promise.all([api(T('/public')).catch(() => pub), api(T('/accounts'))]);
      limits = (await api(T('/limits')).catch(() => ({ limits: null }))).limits;
    } catch (e) {
      parts.push(errorBox(e, load), manageFold(ctx, gw));
      return fill(body, ...parts);
    }
    ctx.computer = accounts.computer || ctx.computer;
    const openState = { computer: ctx.computer, port: g.port, signedIn: ctx.signedIn, publicUrl: pub.state === 'on' ? pub.url : null };
    const onLoop = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
    hint.textContent = !onLoop && !openState.publicUrl ? publicOffWords(openState) : '';
    parts.push(
      h('div.tr-open', btn('primary block', { icon: 'external', label: 'Open TRouteAI', onclick: () => openGatewayPage(openState, (t) => { hint.textContent = t; }) }), hint),
      accountsPart(ctx, accounts.accounts, limits),
      h('div.savebar.start', btn('secondary', { icon: 'plus', label: 'Add account', onclick: () => addSheet({ computer: ctx.computer, port: g.port, signedIn: ctx.signedIn }, load) })),
      combosPart({ computer: ctx.computer }),
      publicFold(pub, ctx));
    if (gw && gw.ready) parts.push(sharing(gw, load, `Share with your other computers · ${gw.shared ? 'On' : 'Off'}`));
    const others = otherComputers(gws, load);
    if (others) parts.push(others);
    parts.push(manageFold(ctx, gw));
    fill(body, ...parts);
  }
  load();
  return () => { alive = false; };
}
