// Settings → Add-ons → Public link (src/addons/publiclink.mjs and fixedlink.mjs). The fixed address comes first: set
// up in three steps (sign in to Cloudflare in this browser and approve, type the name, done). The temporary address
// follows. The rarer things are under a closed Advanced in each: another service on this computer, a tunnel token
// instead of the sign-in, and "Stop using it".
import { icon } from './icons.js';
import { api, btn, confirmSheet, fill, h, openSheet, qrSvg, toast } from './lib.js';
import { fold, steps } from './shell.js';

// What was typed, kept while the page is drawn again (it looks again every few seconds while it waits for Cloudflare).
const draft = { hostname: '', token: '', tokenHost: '', svcPort: '', svcHost: '', quickPort: '' };

/** The fixed address in one pill: [state class, text]. */
export function fixedPill(f) {
  if (!f || f.state === 'none') return ['ended', 'Not set up'];
  if (f.state === 'signing-in') return ['starting', 'Waiting for Cloudflare'];
  if (f.state === 'signed-in') return ['starting', 'Signed in to Cloudflare'];
  if (!f.enabled) return ['ended', 'Off'];
  if (f.connected) return ['waiting', 'Connected'];
  if (f.error) return ['attention', f.nextTryAt ? 'Trying again' : 'Not working'];
  return ['starting', 'Connecting…'];
}

/** Whether the page looks again soon: while Cloudflare's approval or the first connection is awaited. */
export const needsPoll = (a) => !!(a && a.fixed && a.installed && (a.fixed.state === 'signing-in' || (a.fixed.enabled && !a.fixed.connected)));

const plural = (list, one, many) => (list.length > 1 ? many : one);

/** What "Stop using it" does, said before it is done. */
export function forgetText(f) {
  if (f.mode === 'token') {
    return `${f.url} stops leading here and its token is removed from this computer. The tunnel and its address stay in your Cloudflare dashboard: delete them there under Networks → Tunnels if you no longer need them.`;
  }
  if (f.mode !== 'named') return 'The sign-in to Cloudflare is removed from this computer. Nothing was made in your Cloudflare account yet.';
  const hosts = [f.hostname, ...(f.extra || []).map((x) => x.hostname)];
  return `${f.url} stops leading here. Hoprig deletes its tunnel in your Cloudflare account and removes the sign-in to Cloudflare from this computer. `
    + `The DNS ${plural(hosts, 'record', 'records')} for ${hosts.join(', ')} ${plural(hosts, 'stays', 'stay')} in Cloudflare, because cloudflared cannot remove DNS records: `
    + `delete ${plural(hosts, 'it', 'them')} under your domain → DNS → Records. Until then the address shows a Cloudflare error page.`;
}

const pill = ([key, text]) => h(`span.pill.st-${key}`, h('span.dot'), text);
const part = (title, state, ...body) => h('div.addon-part', h('div.addon-part-head', h('h3.addon-part-title', title), state ? pill(state) : null), ...body);
const ext = (href, text, cls = 'a.mono') => h(cls, { href, target: '_blank', rel: 'noopener noreferrer' }, text);
const input = (key, attrs) => h('input.field', { value: draft[key], autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', oninput: (e) => (draft[key] = e.target.value.trim()), ...attrs });

/** A sheet with a sign-in QR made for that address: a phone scanning it lands signed in there, once. */
async function phoneSheet(url) {
  try {
    const l = await api('~/api/login/links', { base: url });
    openSheet({ title: 'Sign in a phone' }, (close) => [
      h('p.sheet-text', `Scan it with the phone's camera: it opens ${url} signed in. It works once, for 15 minutes.`),
      l.qr ? h('div.addon-address', h('div.qrbox', qrSvg(l.qr))) : null,
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Close')),
    ]);
  } catch (e) {
    toast(e.message, { kind: 'error' });
  }
}

// ---------- the fixed address ----------

function fixedNone(f, t) {
  return [
    h('p.hint', 'An address on your own domain that stays the same, such as pc2.example.com. It needs a free Cloudflare account with a domain on it.'),
    f.loginError ? h('p.mrow-error', f.loginError) : null,
    h('div.mrow-actions', btn('small primary', { icon: 'play', label: 'Set it up', disabled: t.busy, onclick: () => t.run('fixed-sign-in', {}) })),
    fold('addon-fixed-token', 'Advanced',
      h('div.fieldrow',
        h('span.field-label', 'Use a tunnel token instead'),
        h('span.hint', `For a tunnel made in the Cloudflare dashboard (Networks → Tunnels). There, give it a public hostname that leads to http://127.0.0.1:${f.port}; then paste its install command or its token here.`),
        h('div.addon-form',
          input('token', { type: 'password', placeholder: 'cloudflared service install eyJ…', 'aria-label': 'Tunnel token' }),
          input('tokenHost', { placeholder: 'pc2.example.com', 'aria-label': 'Its address' }),
          btn('small secondary', { label: 'Use it', disabled: t.busy, onclick: async () => {
            const r = await t.run('fixed-token', { token: draft.token, hostname: draft.tokenHost });
            if (r && r.ok) draft.token = draft.tokenHost = '';
          } })))),
  ];
}

function fixedSigningIn(f, t) {
  return [
    steps(
      [h('strong', 'Open Cloudflare and sign in.'), h('span.hint', ' A free account is enough.')],
      [h('strong', 'Pick the domain for this address and press Authorize.')],
      [h('strong', 'Come back here.'), h('span.hint', ' This page goes on by itself.')]),
    h('div.mrow-actions',
      f.loginUrl ? ext(f.loginUrl, [icon('external', { size: 16 }), h('span', 'Open Cloudflare')], 'a.btn.small.primary') : null,
      btn('small ghost', { label: 'Cancel', disabled: t.busy, onclick: () => t.run('fixed-cancel', {}) })),
  ];
}

function fixedSignedIn(f, t) {
  const host = input('hostname', { placeholder: `${f.suggested}.example.com`, 'aria-label': 'The address' });
  if (!draft.hostname) host.value = `${f.suggested}.`;
  return [
    h('div.fieldrow',
      h('span.field-label', 'The address'),
      h('div.addon-form', host, btn('small primary', { label: 'Make it', disabled: t.busy, onclick: async () => {
        draft.hostname = host.value.trim();
        const r = await t.run('fixed-create', { hostname: draft.hostname });
        if (r && r.ok) draft.hostname = '';
      } })),
      h('span.hint', 'A name under the domain you picked in Cloudflare. Hoprig makes the tunnel and its DNS record there.')),
    h('div.mrow-actions',
      btn('small ghost', { label: 'Sign in again', title: 'For another Cloudflare account or domain', disabled: t.busy, onclick: () => t.run('fixed-sign-in', { again: true }) }),
      btn('small ghost', { label: 'Start over', disabled: t.busy, onclick: async () => {
        if (await confirmSheet({ title: 'Start over?', text: forgetText(f), ok: 'Start over' })) t.run('fixed-forget', {});
      } })),
  ];
}

function services(f, t) {
  if (f.mode !== 'named') return h('p.hint', 'With a tunnel token, other services get their names in the Cloudflare dashboard: your tunnel → Public hostnames.');
  return h('div.fieldrow',
    h('span.field-label', 'Another service on this computer'),
    h('span.hint', 'Reach one more local service from anywhere under a name of its own, such as TRouteAI\'s own dashboard on port 20017. It should have its own sign-in page: you are asked first when it has none.'),
    f.extra.map((x) => h('div.addon-svc',
      ext(x.url, x.url), h('span.hint', `port ${x.port}`),
      btn('small ghost', { icon: 'trash', label: 'Remove', disabled: t.busy, onclick: async () => {
        const text = `${x.hostname} no longer leads to port ${x.port}. Its DNS record stays in Cloudflare (cloudflared cannot remove it): delete it under your domain → DNS → Records.`;
        if (await confirmSheet({ title: 'Remove this name?', text, ok: 'Remove', danger: true })) t.run('fixed-remove-service', { hostname: x.hostname });
      } }))),
    f.extra.length < 5 ? h('div.addon-form',
      input('svcPort', { type: 'number', inputmode: 'numeric', min: 1, max: 65535, placeholder: '20017', class: 'addon-port', 'aria-label': 'Port' }),
      input('svcHost', { placeholder: `trouteai-${f.hostname}`, 'aria-label': 'Its address' }),
      btn('small secondary', { label: 'Add', disabled: t.busy, onclick: async () => {
        const r = await t.run('fixed-add-service', { port: Number(draft.svcPort), hostname: draft.svcHost });
        if (r && r.ok) draft.svcPort = draft.svcHost = '';
      } })) : null);
}

function fixedReady(f, t) {
  const wait = f.nextTryAt ? Math.max(1, Math.round((f.nextTryAt - Date.now()) / 1000)) : 0;
  return [
    h('div.addon-address',
      ext(f.url, f.url),
      f.mode === 'token' ? h('p.hint', `In the Cloudflare dashboard, this tunnel's public hostname must lead to http://127.0.0.1:${f.port}.`) : null,
      f.enabled && f.error ? h('p.mrow-error', `${f.error}${wait ? ` It starts again in ${wait} s.` : ''}`) : null),
    h('div.mrow-actions',
      f.enabled
        ? btn('small secondary', { icon: 'stop', label: 'Turn off', disabled: t.busy, onclick: () => t.run('fixed-off', {}) })
        : btn('small secondary', { icon: 'play', label: 'Turn on', disabled: t.busy, onclick: () => t.run('fixed-on', {}) }),
      f.enabled ? btn('small ghost', { icon: 'lock', label: 'Sign in a phone', onclick: () => phoneSheet(f.url) }) : null),
    h('p.hint', f.enabled
      ? 'It runs with the dashboard: it starts when the dashboard starts, and again by itself when it stops. The dashboard password is asked there.'
      : 'Off: the address shows a Cloudflare error page until you turn it on again.'),
    fold('addon-fixed', 'Advanced',
      services(f, t),
      h('div.fieldrow',
        h('span.field-label', 'Stop using the fixed address'),
        h('span.hint', 'Removes what Hoprig made for it. You are told first what happens in Cloudflare.'),
        h('div.mrow-actions', btn('small danger', { icon: 'trash', label: 'Stop using it', disabled: t.busy, onclick: async () => {
          if (await confirmSheet({ title: 'Stop using the fixed address?', text: forgetText(f), ok: 'Stop using it', danger: true })) t.run('fixed-forget', {});
        } })))),
  ];
}

// ---------- the temporary address ----------

/** The running temporary address, with a sign-in QR made for THAT address. */
function addressBlock(a) {
  const box = h('div.addon-address');
  api('~/api/login/links', { base: a.url })
    .then((l) => fill(box,
      h('p', 'Open this address, or scan the code with a phone to sign in there once:'),
      ext(a.url, a.url),
      l.qr ? h('div.qrbox', qrSvg(l.qr)) : null,
      h('p.hint', 'The address changes each time it starts and is not for permanent use.')))
    .catch((e) => fill(box, h('p.hint', `${a.url} — ${e.message}`)));
  return box;
}

function quickService(a, t) {
  const s = a.service;
  return h('div.fieldrow',
    h('span.field-label', 'Another service on this computer'),
    h('span.hint', 'One more local service, such as TRouteAI\'s own dashboard on port 20017, gets a temporary address of its own. It should have its own sign-in page: you are asked first when it has none.'),
    s
      ? h('div.addon-svc', ext(s.url, s.url), h('span.hint', `port ${s.port}`),
        btn('small secondary', { icon: 'stop', label: 'Stop', disabled: t.busy, onclick: () => t.run('quick-service-stop', {}) }))
      : h('div.addon-form',
        input('quickPort', { type: 'number', inputmode: 'numeric', min: 1, max: 65535, placeholder: '20017', class: 'addon-port', 'aria-label': 'Port' }),
        btn('small secondary', { icon: 'play', label: 'Get an address', disabled: t.busy, onclick: async () => {
          const r = await t.run('quick-service-start', { port: Number(draft.quickPort) });
          if (r && r.ok) draft.quickPort = '';
        } })));
}

function quickPart(a, t) {
  const notes = Array.isArray(a.notes) ? a.notes.filter((n) => typeof n === 'string' && n) : [];
  return part('A temporary address', a.running ? ['waiting', 'Running'] : ['ended', 'Stopped'],
    h('p.hint', 'A new https address at every start, through Cloudflare\'s free quick tunnel. No account needed.'),
    h('div.mrow-actions',
      a.running
        ? btn('small secondary', { icon: 'stop', label: 'Stop', disabled: t.busy, onclick: () => t.run('stop') })
        : btn('small secondary', { icon: 'play', label: 'Start', disabled: t.busy, onclick: async () => {
          if (await confirmSheet({ title: `Start ${a.title}?`, text: notes.join(' '), ok: 'Start' })) t.run('start');
        } })),
    !a.running && notes.length ? h('ul.addon-notes', notes.map((n) => h('li', n))) : null,
    a.running && a.url ? addressBlock(a) : null,
    h('p.hint', 'Each new address is sent to your phone when Settings → Notifications has a push address.'),
    fold('addon-quick', 'Advanced', quickService(a, t)));
}

/**
 * The public link's two parts. `t`: { run(action, body) → the job's result, busy }. run(action) without a body is
 * one of the add-on's plain actions (start, stop).
 */
export function publicLinkParts(a, t) {
  const f = a.fixed;
  const body = f.state === 'ready' ? fixedReady(f, t) : f.state === 'signing-in' ? fixedSigningIn(f, t) : f.state === 'signed-in' ? fixedSignedIn(f, t) : fixedNone(f, t);
  return [part('A fixed address', fixedPill(f), ...body), quickPart(a, t)];
}
