// Providers → "Gateways on your computers" (src/gateway): every AI gateway (TRouteAI first) on this computer and on
// the computers linked to it, whether it runs, its version, and "Use here", which makes a provider on this computer
// for it. Sharing this computer's gateway (off until turned on), the keys made for other computers, and "Add a
// shared gateway" for a computer that is not linked. Shown on this dashboard's own page only: a key never travels
// through another computer's page.
import { APP_NAME } from './brand.js';
import { icon } from './icons.js';
import { ago, api, btn, confirmSheet, copyText, fill, h, insecure, link, machinePill, openSheet, promptSheet, toast } from './lib.js';
import { errorBox, field, fold, panel, skeletonRows, steps, toggle } from './shell.js';

const G = (p) => `~/api/gateways${p}`;
const busy = (text) => h('div.empty.compact', h('div.spinner', { 'aria-hidden': 'true' }), h('p', text));
const NAME_OK = (v) => (v.trim() && v.trim().length <= 60 && /^[A-Za-z0-9 ._@()-]+$/.test(v.trim()) ? '' : 'Letters, digits, spaces and . _ @ ( ) -, up to 60');

// A computer whose gateways cannot be seen right now, in plain words.
const AWAY = {
  offline: 'Offline right now: its gateways show once it is on.',
  unauthorised: 'It does not let this dashboard in any more. Link it again on the Computers page.',
  'too-old': `It needs a ${APP_NAME} update to show its gateways.`,
};

/** The one line under a gateway: whether it runs, its version, and whether it is shared or used here. */
export function gatewayLine(c, g) {
  if (!g.installed) return 'Not installed';
  return [
    g.running ? 'Running' : 'Installed, not running',
    g.version ? `version ${g.version}` : null,
    g.shared ? (c.machine ? 'shared' : 'shared with your other computers') : null,
    c.machine && !g.ready ? `not set up as a provider on ${c.label} yet` : null,
    g.usedAs ? `used here as ${g.usedAs.label}` : null,
  ].filter(Boolean).join(' · ');
}

/** What the row offers: open the provider it is used as, or "Use here" when that can work. */
export function gatewayAction(c, g) {
  if (g.usedAs) return 'open';
  if (!c.machine) return 'use-local'; // the TRouteAI steps install and start it when needed
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
    toast(e.message, { kind: 'error', ms: 9000 });
  }
}

function row(c, g, { useLocal, done }) {
  const what = gatewayAction(c, g);
  const end = what === 'open'
    ? h('a.btn.small.secondary.gw-act', { href: link(`#/providers/${encodeURIComponent(g.usedAs.name)}`) }, 'Open')
    : what === 'use-local' ? btn('small primary gw-act', { label: 'Use here', onclick: useLocal })
      : what === 'use-remote' ? btn('small primary gw-act', { label: 'Use here', onclick: () => useRemote(c, g, done) }) : null;
  return h('div.row.static.gw-row',
    h('span.row-icon', icon('sparkle')),
    h('span.row-main',
      h('span.row-title', g.title, ' ', machinePill(c.machine ? c.label : 'This computer', { state: c.state === 'online' ? 'online' : 'offline' })),
      h('span.row-sub', gatewayLine(c, g)),
      !c.machine && g.running ? h('span.row-sub.mono', g.address) : null),
    end);
}

/** A key shown once, with the address, for a computer that is not linked. */
async function keySheet(g, done) {
  const name = await promptSheet({ title: 'A key for another computer', text: 'The name of the computer that will use it, so you know which key to remove later.', ok: 'Make key', check: NAME_OK });
  if (!name) return;
  let r;
  try {
    r = await api(G(`/${g.id}/keys`), { name: name.trim() });
  } catch (e) {
    return toast(e.message, { kind: 'error', ms: 8000 });
  }
  done();
  const address = `${r.publicUrl || location.origin}${r.path}`;
  const local = /^http:\/\/(localhost|127\.|\[::1\])/.test(address);
  const copyRow = (value, what) => h('div.btnrow', h('input.field.mono', { value, readonly: true, onfocus: (e) => e.target.select() }),
    btn('secondary', { icon: 'copy', label: 'Copy', onclick: async () => toast((await copyText(value)) ? `${what} copied` : 'Copy did not work') }));
  await openSheet({ title: `${g.title} for ${name.trim()}`, subtitle: 'The key is shown only now' }, (close) => h('div.wizard',
    steps(
      [h('p', 'On the other computer, open Providers and press "Add a shared gateway".')],
      [h('p', 'Paste this address:'), copyRow(address, 'Address')],
      [h('p', 'Paste this key:'), copyRow(r.key, 'Key')]),
    local ? h('div.banner.warn', icon('alert', { size: 18 }), h('span', 'This address works only on this computer. Open this page by the computer\'s name on your network, by Tailscale or by the public link, and make the key there, to get an address that works elsewhere.')) : null,
    !local && address.startsWith('http:') ? h('div.banner.warn', icon('lock', { size: 18 }), h('span', 'This address is not encrypted: requests and the key travel in plain text. Use it only on a network you trust, or use Tailscale or the public link.')) : null,
    h('div.sheet-actions', h('button.btn.primary', { type: 'button', onclick: () => close() }, 'Done'))));
}

function sharing(g, reload) {
  const keys = g.keys || [];
  return fold(`gw-share-${g.id}`, `Share ${g.title} with your other computers`,
    toggle(`Share ${g.title}`, g.shared, async (on) => {
      try {
        await api(G(`/${g.id}/share`), { on });
        toast(on ? `${g.title} is shared` : `${g.title} is no longer shared`);
      } catch (e) {
        toast(e.message, { kind: 'error', ms: 8000 });
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
              toast(e.message, { kind: 'error' });
            }
            reload();
          } }))))
        : h('p.hint', 'No computer has a key yet.'),
      h('div.savebar.start', btn('secondary', { icon: 'key', label: 'Key for a computer that is not linked', onclick: () => keySheet(g, reload) })),
    ] : null);
}

function addSheet(done) {
  return openSheet({ title: 'Add a shared gateway', subtitle: 'A gateway that another computer shares through its dashboard' }, (close) => {
    const url = h('input.field.mono', { type: 'url', placeholder: 'https://…/gateway/trouteai', autocapitalize: 'off', spellcheck: 'false' });
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
        fill(out, errorBox(e.message));
        go.disabled = false;
      }
    });
    return h('div.wizard',
      h('p.sheet-text', 'On the computer that runs the gateway, open Providers → Gateways on your computers, turn sharing on and make a key for this computer. It shows the address and the key.'),
      field('Address', url, 'It ends in /gateway/ and the gateway\'s name.'),
      insecure() ? h('div.banner.warn', icon('lock', { size: 18 }), h('span', 'This page is not encrypted: the key would travel over the network in plain text. Use it only on a network you trust.')) : null,
      field('Gateway key', key, 'Checked once, then kept only in this computer\'s provider file.'),
      out,
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Cancel'), go));
  });
}

/**
 * The panel. `useLocal()` adds this computer's own gateway as a provider (the TRouteAI steps of Add provider);
 * `changed()` draws the provider list again after a provider was added here.
 */
export function gatewaysPanel({ useLocal, changed }) {
  const box = h('div', skeletonRows(2));
  const done = () => {
    load();
    changed();
  };
  async function load() {
    let d;
    try {
      d = await api(G('/all'));
    } catch (e) {
      return fill(box, errorBox(e.message, load));
    }
    const rows = [];
    for (const c of d.computers) {
      if (c.state !== 'online' && !c.gateways.length) {
        rows.push(h('div.row.static.gw-row', h('span.row-icon', icon('cpu')),
          h('span.row-main', h('span.row-title', machinePill(c.label, { state: 'offline' })), h('span.row-sub', AWAY[c.state] || AWAY.offline))));
      }
      for (const g of c.gateways) rows.push(row(c, g, { useLocal, done }));
    }
    const mine = d.computers[0].gateways.filter((g) => g.ready);
    fill(box,
      rows.length ? h('div.rows', rows) : h('p.hint', 'No gateway is known on your computers.'),
      mine.map((g) => sharing(g, load)),
      h('div.savebar.start', btn('secondary', { icon: 'plus', label: 'Add a shared gateway', onclick: () => addSheet(done) })));
  }
  load();
  return panel({ icon: 'swap', title: 'Gateways on your computers', desc: 'A gateway such as TRouteAI lets Claude Code use other AI providers (and Codex and OpenCode, when Test on its provider finds the APIs they need). Use one from this computer or from another one.' }, box);
}
