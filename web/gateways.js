// The gateway's pieces that the gateway's page (under Providers) and Add provider use (src/gateway): the gateways of
// the other computers with "Use here", sharing this computer's gateway (off until turned on), the keys made for other
// computers, "Add a shared gateway" for one a computer shares, and the one-press set-up. Shown on this dashboard's own page only: a key never travels
// through another computer's page.
import { APP_NAME } from './brand.js';
import { icon } from './icons.js';
import { ago, api, at, btn, confirmSheet, copyText, fill, h, insecure, link, machine, machinePill, openSheet, promptSheet, toast } from './lib.js';
import { errorBox, field, fold, okBox, steps, toggle } from './shell.js';
import { plainHost } from './health.js';

const G = (p) => `~/api/gateways${p}`;
const busy = (text) => h('div.empty.compact', h('div.spinner', { 'aria-hidden': 'true' }), h('p', text));
const NAME_OK = (v) => (v.trim() && v.trim().length <= 60 && /^[A-Za-z0-9 ._@()-]+$/.test(v.trim()) ? '' : 'Letters, digits, spaces and . _ @ ( ) -, up to 60');

// A computer whose gateways cannot be seen right now, in plain words.
const AWAY = {
  offline: 'Offline right now: its gateways show once it is on.',
  // unauthorised: drawn with its link where the row is made (it names the Computers page).
  'too-old': `It needs a ${APP_NAME} update to show its gateways.`,
};

// Why a program of the owner's own waits for his yes (GET /api/gateways needsConfirm), as `hoprig gateways` says it.
const WAITS = {
  changed: 'Its program changed since you confirmed it, so Hoprig does not start it until you confirm it again.',
  'no-fingerprint': 'Hoprig keeps no fingerprint of its program yet, so it does not start it until you confirm it.',
  gone: 'Its program is not where you confirmed it any more (an update may have moved it), so Hoprig does not start it.',
  'gone-old': 'Its program is not where you confirmed it any more, so Hoprig does not start it.',
};

/**
 * A gateway whose program was not found, in the page's words: what Hoprig starts it with and why it waits, from this
 * computer's GET /api/gateways (`view`: its entry, or null when the route did not answer). → [sentence, command | null].
 */
export function programFacts(title, view) {
  const runs = view && Array.isArray(view.runs) && view.runs.length ? view.runs.join(' ') : null;
  const why = view && WAITS[view.needsConfirm];
  const first = why || `${title} is defined on this computer, but its program was not found.`;
  return [runs ? `${first} Hoprig starts it with:` : `${first} Install its program on this computer, then try again.`, runs];
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1'];

/**
 * A gateway's own page as this browser can open it. `page` is its address as its computer says it
 * (http://localhost:<port>/…; it listens on that computer only), `pageHost` the host name this dashboard page is open
 * under, `signedIn` the loopback names the owner is signed in under (when known), `other` true for another computer's
 * gateway. → { href } on a loopback name: a link under the loopback name the page is not on (a browser sends a host's
 * sign-in cookie to every port of it); else { text }: the one sentence of where it opens, never a dead localhost link.
 * The dashboard never passes a gateway's page through (its scripts would run on the dashboard's address as the owner).
 */
export function gatewayPageLink(page, { title = 'The gateway', pageHost = '', signedIn = [], other = false } = {}) {
  if (!page) return null;
  if (other) return { text: `${title}'s own page opens only in a browser on that computer itself. For a computer added by SSH, Open its page under that computer's Health opens it in a browser on the computer this dashboard runs on.` };
  const u = new URL(page);
  const own = String(pageHost).toLowerCase();
  if (!LOOPBACK.includes(own)) {
    u.hostname = '127.0.0.1';
    return { text: `${title}'s own page opens only in a browser on the computer this dashboard runs on, at ${u.href}` };
  }
  const host = plainHost(own, signedIn);
  if (!host) return { text: `You are signed in to this dashboard under both localhost and 127.0.0.1, so a link to ${title} would hand it your sign-in. Sign out under one of them (Settings → Security and sign-in → This device) to get its link.` };
  u.hostname = host;
  return { href: u.href };
}

/**
 * The warning under a gateway's address for another computer, or null. An address on a loopback name reaches only the
 * computer it is used on; the computer's name works only where the dashboard was opened to the network (by default
 * it listens on this computer only), the public link from anywhere.
 */
export function addressWarning(address) {
  if (!/^http:\/\/(localhost|127\.|\[::1\])/.test(address)) return null;
  return 'This address works only on this computer. To get one that works on another computer, open this page by its public link (Settings → Public link), or by this computer\'s name on your network if the dashboard is open to your network (Settings → Security and sign-in → Network), and make the key there.';
}

/** The one line under a gateway: whether it runs, its version, and whether it is shared or used here. */
export function gatewayLine(c, g) {
  if (!g.installed) return 'Not installed';
  return [
    g.running ? 'Running' : 'Installed, not running',
    g.version ? `version ${g.version}` : null,
    g.restart || null,
    g.shared ? (c.machine ? 'shared' : 'shared with your other computers') : null,
    c.machine && !g.ready ? `not set up as a provider on ${c.label} yet` : null,
    g.usedAs ? `used here as ${g.usedAs.label}` : null,
  ].filter(Boolean).join(' · ');
}

/** What the row offers: open the provider it is used as, or "Use here" when that can work. */
export function gatewayAction(c, g) {
  if (g.usedAs) return 'open';
  if (!c.machine) return 'use-local'; // that gateway's steps in Add provider install and start it when needed
  return c.state === 'online' && g.installed && g.ready ? 'use-remote' : null;
}

async function useRemote(c, g, done) {
  const ok = await confirmSheet({
    title: `Use ${g.title} on ${c.label} here?`,
    text: g.shared
      ? `This computer gets a key of its own from ${c.label}. Its requests go to ${g.title} on ${c.label} through the two dashboards.`
      : `This turns on sharing of ${g.title} on ${c.label}: a computer with a key made there can use it through its dashboard. This computer gets the first key. You can turn sharing off on ${c.label}.`,
    ok: 'Use here',
  });
  if (!ok) return;
  toast(`Asking ${c.label}…`);
  try {
    const r = await api(G('/use'), { machine: c.machine, gateway: g.id, share: true });
    toast(`${r.label} added`);
    done();
  } catch (e) {
    toast(e, { kind: 'error', ms: 9000 });
  }
}

function row(c, g, { useLocal = () => {}, done }) {
  const what = gatewayAction(c, g);
  const end = what === 'open'
    ? h('a.btn.small.secondary.gw-act', { href: link(`#/providers/${encodeURIComponent(g.usedAs.name)}`) }, 'Open')
    : what === 'use-local' ? btn('small primary gw-act', { label: 'Use here', onclick: () => useLocal(g) })
      : what === 'use-remote' ? btn('small primary gw-act', { label: 'Use here', onclick: () => useRemote(c, g, done) }) : null;
  return h('div.row.static.gw-row',
    h('span.row-icon', icon('sparkle')),
    h('span.row-main',
      h('span.row-title', g.title, ' ', machinePill(c.machine ? c.label : 'This computer', { state: c.state === 'online' ? 'online' : 'offline' })),
      h('span.row-sub', gatewayLine(c, g)),
      !c.machine && g.running ? h('span.row-sub.mono', g.address) : null),
    end);
}

/**
 * The gateways of the OTHER linked computers, as one closed fold of the gateway's page: what runs there and "Use here",
 * which makes a provider on this computer for one. `all` is GET /api/gateways/all (null when it did not answer); null
 * (nothing drawn) while no other computer is linked. `done()` draws the page again.
 */
export function otherComputers(all, done) {
  const rows = [];
  for (const c of (all && all.computers) || []) {
    if (!c.machine) continue;
    if (c.state !== 'online' && !c.gateways.length) {
      rows.push(h('div.row.static.gw-row', h('span.row-icon', icon('cpu')),
        h('span.row-main', h('span.row-title', machinePill(c.label, { state: 'offline' })), h('span.row-sub', c.state === 'unauthorised' ? ['It does not let this dashboard in any more. ', h('a', { href: link('#/computers') }, 'Link it again on the Computers page'), '.'] : AWAY[c.state] || AWAY.offline))));
    }
    for (const g of c.gateways) rows.push(row(c, g, { done }));
  }
  return rows.length ? fold('gw-others', 'Gateways on your computers', h('div.rows', { id: 'gateways' }, rows)) : null;
}

/** A key shown once, with the address, for a computer that is not linked. */
async function keySheet(g, done) {
  const name = await promptSheet({ title: 'A key for another computer', text: 'The name of the computer that will use it, so you know which key to remove later.', ok: 'Make key', check: NAME_OK });
  if (!name) return;
  let r;
  try {
    r = await api(G(`/${g.id}/keys`), { name: name.trim() });
  } catch (e) {
    return toast(e, { kind: 'error', ms: 8000 });
  }
  done();
  const address = `${r.publicUrl || location.origin}${r.path}`;
  const local = addressWarning(address);
  const copyRow = (value, what) => h('div.btnrow', h('input.field.mono', { value, readonly: true, onfocus: (e) => e.target.select() }),
    btn('secondary', { icon: 'copy', label: 'Copy', onclick: async () => toast((await copyText(value)) ? `${what} copied` : 'Copy did not work') }));
  await openSheet({ title: `${g.title} for ${name.trim()}`, subtitle: 'The key is shown only now' }, (close) => h('div.wizard',
    steps(
      [h('p', 'On the other computer, open Providers, then the gateway, then Share with your other computers, and press "Add a shared gateway".')],
      [h('p', 'Paste this address:'), copyRow(address, 'Address')],
      [h('p', 'Paste this key:'), copyRow(r.key, 'Key')]),
    local ? h('div.banner.warn', icon('alert', { size: 18 }), h('span', local)) : null,
    !local && address.startsWith('http:') ? h('div.banner.warn', icon('lock', { size: 18 }), h('span', 'This address is not encrypted: requests and the key travel in plain text. Use it only on a network you trust, or use the public link.')) : null,
    h('div.sheet-actions', h('button.btn.primary', { type: 'button', onclick: () => close() }, 'Done'))));
}

/** The sharing fold of this computer's gateway `g` (a row of GET /api/gateways/all): the switch, the keys of other computers, a key for a computer that is not linked. `label`: the fold's own words. */
export function sharing(g, reload, label = `Share ${g.title} with your other computers`) {
  const keys = g.keys || [];
  return fold(`gw-share-${g.id}`, label,
    toggle(`Share ${g.title}`, g.shared, async (on) => {
      try {
        await api(G(`/${g.id}/share`), { on });
        toast(on ? `${g.title} is shared` : `${g.title} is no longer shared`);
      } catch (e) {
        toast(e, { kind: 'error', ms: 8000 });
        throw e;
      } finally {
        reload();
      }
    }, 'Other computers can then use it with a key made here; its own key stays on this computer. Anyone who reaches this dashboard with such a key can use it, and its use costs what its providers cost.'),
    g.shared ? [
      keys.length
        ? h('div.rows', keys.map((k) => h('div.row.static.gw-row',
          h('span.row-icon', icon('key')),
          h('span.row-main', h('span.row-title', k.name), h('span.row-sub', [
            k.linked ? 'Linked computer · stops working when that computer is no longer allowed here' : 'Made here for a computer that is not linked',
            k.created ? `made ${ago(k.created)}` : null].filter(Boolean).join(' · '))),
          btn('small secondary gw-act', { label: 'Remove', onclick: async () => {
            if (!(await confirmSheet({ title: `Remove the key of ${k.name}?`, text: `${k.name} can no longer use ${g.title} on this computer.`, ok: 'Remove', danger: true }))) return;
            try {
              await api(G(`/keys/${k.id}/remove`), {});
              toast('Key removed');
            } catch (e) {
              toast(e, { kind: 'error' });
            }
            reload();
          } }))))
        : h('p.hint', 'No computer has a key yet.'),
      h('div.savebar.start', btn('secondary', { icon: 'key', label: 'Key for a computer that is not linked', onclick: () => keySheet(g, reload) })),
    ] : null,
    // The other side of sharing: a gateway that another computer shares with this one.
    h('div.savebar.start', btn('secondary', { icon: 'plus', label: 'Add a shared gateway', onclick: () => addSheet(reload) })));
}

function addSheet(done) {
  return openSheet({ title: 'Add a shared gateway', subtitle: 'A gateway that another computer shares through its dashboard' }, (close) => {
    const url = h('input.field.mono', { type: 'url', placeholder: 'https://…/gateway/…', autocapitalize: 'off', spellcheck: 'false' });
    const key = h('input.field.mono', { type: 'password', placeholder: 'hop_gw_…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const out = h('div');
    const go = h('button.btn.primary', { type: 'button' }, 'Check and add');
    go.addEventListener('click', async () => {
      go.disabled = true;
      fill(out, busy('Asking that computer…'));
      try {
        const r = await api(G('/add'), { url: url.value, key: key.value });
        key.value = '';
        toast(`${r.label} added`);
        close(true);
        done();
      } catch (e) {
        fill(out, errorBox(e));
        go.disabled = false;
      }
    });
    return h('div.wizard',
      h('p.sheet-text', 'On the computer that runs the gateway, open Providers → the gateway → Share with your other computers, turn sharing on and make a key for this computer. It shows the address and the key.'),
      field('Address', url, 'It ends in /gateway/ and the gateway\'s name.'),
      insecure() ? h('div.banner.warn', icon('lock', { size: 18 }), h('span', 'This page is not encrypted: the key would travel over the network in plain text. Use it only on a network you trust.')) : null,
      field('Gateway key', key, 'Checked once, then kept only in this computer\'s provider file.'),
      // The OpenCode condition lives here, on the gateway's own sheet, not in the panel's first sentence.
      h('p.hint', 'OpenCode can use it too, when Test on its provider finds what OpenCode needs.'),
      out,
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Cancel'), go));
  });
}

/**
 * Providers → Other providers → a gateway Hoprig sets up itself: one press ("Set up"). The confirmation names the
 * computer; Hoprig installs the gateway when it is missing, starts it, makes the key for the sessions and saves the
 * provider, and the lines of that job show here as they come (src/addons/gatewayhost.mjs POST …/setup). Every failure
 * ends in one sentence with the next step. `done()` draws the provider list again after it worked; `after`: what to
 * show under a success (the link to the gateway's own page, where its providers are added).
 */
export function setupBlock(g, { done, after = null, secondary = null, label = null } = {}) {
  const out = h('pre.output.hidden', { 'aria-live': 'polite' });
  const msg = h('div');
  // The question is asked here, in the block: a second sheet would take this sheet (and the lines below) away.
  const run = async (computer) => {
    fill(msg);
    out.classList.remove('hidden');
    fill(out);
    try {
      await api(at(machine.current, `/api/gatewayhost/${g.id}/setup`), { confirm: computer });
      let from = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const j = await api(at(machine.current, `/api/gatewayhost/${g.id}/setup/job?from=${from}`));
        if (j.lines.length) fill(out, `${out.textContent}${j.lines.join('\n')}\n`);
        from = j.next;
        out.scrollTop = out.scrollHeight;
        if (!j.running) {
          if (j.result && !j.result.ok) throw new Error(j.result.error || `${g.title} could not be set up`);
          fill(msg, okBox(`${g.title} is set up on ${computer}.`), after ? after() : null);
          done && done();
          return;
        }
      }
    } catch (e) {
      go.disabled = false;
      go.classList.remove('hidden');
      fill(msg, errorBox(e));
    }
  };
  const go = btn('primary block', { icon: 'play', label: label || `Set up ${g.title}`, onclick: async () => {
    go.disabled = true;
    fill(msg);
    try {
      const computer = (await api(at(machine.current, '/api/gatewayhost'))).computer;
      go.classList.add('hidden');
      fill(msg, h('div',
        h('p.sheet-text', `Hoprig installs ${g.title} on ${computer} when it is missing, starts it, makes a key for your sessions and saves it as a provider. Its lines show here as they come.`),
        h('div.sheet-actions',
          btn('secondary', { label: 'Cancel', onclick: () => { fill(msg); go.classList.remove('hidden'); go.disabled = false; } }),
          btn('primary', { label: `Set up on ${computer}`, onclick: (e) => { e.currentTarget.disabled = true; run(computer); } }))));
    } catch (e) {
      go.disabled = false;
      fill(msg, errorBox(e));
    }
  } });
  return h('div', go, out, msg, secondary);
}
