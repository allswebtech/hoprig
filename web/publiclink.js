// Settings → Public link (src/addons/linkswitch.mjs; routes in linkroutes.mjs): one switch that makes this dashboard
// reachable from anywhere through Cloudflare, as one of two kinds, never both: Temporary (the default, nothing to set
// up, a new address at each start) or Custom (the owner's own address, set up once inside its card). While it is on:
// the address with Copy, Open and a sign-in QR, what a visitor has to do, and the line another computer pastes to
// link itself here. When the server cannot turn it on it says what it needs, and the page asks for that in place
// (the password typed once, a stronger password, the Custom set-up). The rarer things are under Advanced.
import { APP_NAME } from './brand.js';
import { icon } from './icons.js';
import { add, api, btn, confirmSheet, copyText, fill, h, link, openSheet, qrSvg, toast } from './lib.js';
import { registerSettingsPage } from './registry.js';
import { field, fold, panel, steps } from './shell.js';

// What was typed, kept while the page is drawn again (it looks again every few seconds while something changes).
const draft = { hostname: '', token: '', tokenHost: '', svcPort: '', svcHost: '', quickPort: '', password: '', current: '', next: '' };

/** The state in one pill: [state class, text]. */
export function statePill(s) {
  if (!s || !s.on) return s && s.state === 'error' ? ['attention', 'Off: it did not start'] : ['ended', 'Off'];
  return {
    installing: ['starting', 'Installing cloudflared…'],
    starting: ['starting', 'Starting…'],
    on: ['waiting', 'On'],
    retrying: ['attention', 'Trying again'],
    error: ['attention', 'Not working'],
  }[s.state] || ['starting', 'Starting…'];
}

/** The one line in the Settings list: Off, or the kind and its address. */
export function linkSummary(s) {
  if (!s || !s.on) return 'Off';
  const kind = s.kind === 'custom' ? 'Custom' : 'Temporary';
  if (s.state === 'on' && s.url) return `${kind}: ${s.url.replace(/^https:\/\//, '')}`;
  return `${kind}: ${statePill(s)[1].toLowerCase()}`;
}

/** Whether the page looks again soon: while it starts, tries again, or waits for Cloudflare's approval. */
export const needsPoll = (s) => !!(s && ((s.on && s.state !== 'on') || (s.custom && s.custom.state === 'signing-in')));

const plural = (list, one, many) => (list.length > 1 ? many : one);

/** What "Stop using my domain" does, said before it is done. */
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

/** A long random password that is easy to read aloud (no 0/O, 1/l): four groups of five. */
export function makePassword(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = random(20);
  const chars = [...bytes].map((b) => abc[b % abc.length]).join('');
  return chars.match(/.{5}/g).join('-');
}

const pill = ([key, text]) => h(`span.pill.st-${key}`, h('span.dot'), text);
const ext = (href, text, cls = 'a.mono') => h(cls, { href, target: '_blank', rel: 'noopener noreferrer' }, text);
const input = (key, attrs) => h('input.field', { value: draft[key], autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', oninput: (e) => (draft[key] = e.target.value.trim()), ...attrs });
const copyBtn = (text, label = 'Copy', done = 'Copied') => btn('small secondary', { icon: 'copy', label, onclick: async () => toast((await copyText(text)) ? done : 'Select and copy it by hand') });

/** A sheet with a sign-in QR made for that address: a phone scanning it lands signed in there, once. */
async function qrSheet(url) {
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

function render({ here, isAlive }) {
  const root = h('div.pl', h('p.muted', 'Looking at the public link…'));
  const out = h('pre.output', { hidden: true, 'aria-live': 'polite' });
  const ui = { need: null, error: null, busy: false, chosen: null, line: null };
  let s = null;
  let timer = null;

  async function load() {
    clearTimeout(timer);
    if (!isAlive()) return;
    // Someone typing here keeps what they type: look again a little later instead of drawing the page again.
    const a = document.activeElement;
    if (s && a && root.contains(a) && a.tagName === 'INPUT') {
      timer = setTimeout(load, 3000);
      return;
    }
    try {
      s = await api('/api/public-link');
    } catch (e) {
      const old = e.status === 404;
      fill(root, h('p.banner.warn', icon('alert', { size: 18 }), h('span', old ? `This computer runs an older ${APP_NAME}: update it to switch its public link from here.` : e.message)));
      return;
    }
    if (!isAlive()) return;
    if (s.on) ui.chosen = null;
    paint();
    if (!ui.busy) timer = setTimeout(load, needsPoll(s) ? 1500 : s.on ? 10000 : 30000);
  }

  const kind = () => ui.chosen || s.kind;

  /** Ask the server; a refusal says what it needs, which the page asks for in place. */
  async function turn(on, k = kind(), extra = {}) {
    ui.error = null;
    try {
      const r = await api('/api/public-link', on ? { on: true, kind: k, ...extra } : { on: false, kind: k });
      if (r.ok === false) Object.assign(ui, { need: r.need || null, error: r.error, chosen: k });
      else Object.assign(ui, { need: null, chosen: null });
      if (r.need === 'custom-setup') ui.chosen = 'custom';
    } catch (e) {
      ui.error = e.message;
    }
    await load();
  }

  // ---------- the switch ----------
  function switchCard() {
    const sw = h('input.switch', { type: 'checkbox', role: 'switch', checked: s.on, 'aria-label': 'Public link', onchange: (e) => turn(e.target.checked) });
    const busy = s.on && ['installing', 'starting'].includes(s.state);
    const wait = s.nextTryAt ? Math.max(1, Math.round((s.nextTryAt - Date.now()) / 1000)) : 0;
    return panel({},
      h('label.switchrow.pl-switch',
        h('span.switchrow-text', h('span.switchrow-label', 'Public link'), h('span', pill(statePill(s)))),
        sw),
      busy && s.progress.length ? h('ul.pl-progress', s.progress.slice(-4).map((l) => h('li', l))) : null,
      s.error && (s.on || s.state === 'error') ? h('p.mrow-error', `${s.error}${wait ? ` It starts again in ${wait} s.` : ''}`) : null,
      ui.error && !ui.need ? h('p.mrow-error', ui.error) : null,
      needBox(),
      !s.on ? h('p.hint', 'Off until you turn it on. Nothing is reachable from outside while it is off.') : null);
  }

  // What the server asked for before it turns on, in place.
  function needBox() {
    if (!ui.need || ui.need === 'custom-setup') return null;
    if (ui.need === 'password') {
      return h('div.banner.warn', icon('lock', { size: 18 }), h('span', ui.error, ' ', h('a', { href: link('#/settings/security') }, 'Settings → Security')));
    }
    if (ui.need === 'check-password') {
      const pw = input('password', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Dashboard password' });
      return h('form.stack.pl-need', { onsubmit: async (e) => {
        e.preventDefault();
        draft.password = pw.value;
        await turn(true, kind(), { password: draft.password });
        draft.password = '';
      } },
        h('p.hint', ui.error),
        field('Your dashboard password', pw),
        h('div.savebar.start', h('button.btn.primary', { type: 'submit' }, 'Check it and turn on')));
    }
    return strongForm(ui.error, true);
  }

  /** "Make a strong password": the current one, a new one (or one made here, shown once), then on again. */
  function strongForm(why, thenOn) {
    const cur = input('current', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password' });
    const next = input('next', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New password' });
    const msg = h('p.form-error', { role: 'alert' });
    return h('form.stack.pl-need', { onsubmit: async (e) => {
      e.preventDefault();
      msg.textContent = '';
      try {
        await api('/api/settings/password', { current: cur.value, next: next.value });
        draft.current = draft.next = '';
        toast('The new password is saved. Other browsers sign in again with it.');
        ui.need = null;
        if (thenOn) await turn(true);
        else load();
      } catch (er) {
        msg.textContent = er.message;
      }
    } },
      why ? h('p.hint', why) : null,
      field('Current password', cur),
      field('New password', next, 'At least 12 characters, not a word people try first. Keep it in your password manager.'),
      h('div.savebar.start',
        btn('secondary', { icon: 'key', label: 'Make one for me', onclick: () => {
          // Shown once, so it can be copied into a password manager.
          next.type = 'text';
          next.value = draft.next = makePassword();
          next.select();
        } }),
        btn('ghost', { icon: 'copy', label: 'Copy it', onclick: async () => next.value && toast((await copyText(next.value)) ? 'Copied' : 'Select and copy it by hand') }),
        h('button.btn.primary', { type: 'submit' }, thenOn ? 'Save it and turn on' : 'Save it')),
      msg);
  }

  // ---------- the two kinds ----------
  function kindCard(k) {
    const on = kind() === k.id;
    const choose = async () => {
      if (on) return;
      if (s.on) {
        const other = s.kind === 'custom' ? 'Custom' : 'Temporary';
        if (!(await confirmSheet({ title: `Move the public link to ${k.title}?`, text: `The ${other} address stops working. ${k.id === 'temporary' ? 'The new address is shown here once it is ready.' : ''}`.trim(), ok: `Move to ${k.title}` }))) return paint();
        if (k.id === 'custom' && !k.ready) {
          Object.assign(ui, { chosen: 'custom', need: 'custom-setup' });
          return paint();
        }
        return turn(true, k.id);
      }
      ui.chosen = k.id;
      ui.need = null;
      if (k.id === 'temporary' || k.ready) return turn(false, k.id);
      paint();
    };
    return h(`div.radiocard.pl-kind${on ? '.on' : ''}`,
      h('label.pl-kind-head',
        h('input', { type: 'radio', name: 'pl-kind', value: k.id, checked: on, onchange: choose }),
        h('span.radiocard-text',
          h('span.radiocard-title', k.title, s.on && s.kind === k.id ? h('span.badge.soft', 'in use') : null),
          h('span.radiocard-sub', k.text),
          h('span.pl-kind-more', h('strong', 'Needs: '), k.needs),
          h('span.pl-kind-more', h('strong', 'Gives: '), k.gives))),
      k.id === 'custom' && on ? h('div.pl-kind-body', customBody()) : null);
  }

  // The Custom set-up, in the card: sign in to Cloudflare, name the address, done.
  function customBody() {
    const f = s.custom;
    const t = { busy: ui.busy, run: job };
    if (f.state === 'ready') {
      return [h('p.hint', 'Set up: ', ext(f.url, f.hostname)),
        !s.on ? h('p.hint', 'Turn the switch on to use it.') : null];
    }
    const need = ui.need === 'custom-setup' ? h('p.banner.info', icon('info', { size: 18 }), h('span', 'Set it up first; it turns on by itself when it is made.')) : null;
    if (f.state === 'signing-in') {
      return [need,
        steps(
          [h('strong', 'Open Cloudflare and sign in.'), h('span.hint', ' A free account is enough.')],
          [h('strong', 'Pick the domain for this address and press Authorize.')],
          [h('strong', 'Come back here.'), h('span.hint', ' This page goes on by itself.')]),
        h('div.mrow-actions',
          f.loginUrl ? ext(f.loginUrl, [icon('external', { size: 16 }), h('span', 'Open Cloudflare')], 'a.btn.small.primary') : null,
          btn('small ghost', { label: 'Cancel', disabled: t.busy, onclick: () => job('custom', 'cancel', {}) }))];
    }
    if (f.state === 'signed-in') {
      const host = input('hostname', { placeholder: `${f.suggested}.example.com`, 'aria-label': 'The address' });
      if (!draft.hostname) host.value = `${f.suggested}.`;
      return [need,
        h('div.fieldrow',
          h('span.field-label', 'The address'),
          h('div.addon-form', host, btn('small primary', { label: 'Make it', disabled: t.busy, onclick: async () => {
            draft.hostname = host.value.trim();
            const r = await job('custom', 'create', { hostname: draft.hostname });
            if (r && r.ok) draft.hostname = '';
          } })),
          h('span.hint', 'A name under the domain you picked in Cloudflare. Hoprig makes the tunnel and its DNS record there, then turns the link on.')),
        h('div.mrow-actions',
          btn('small ghost', { label: 'Sign in again', title: 'For another Cloudflare account or domain', disabled: t.busy, onclick: () => job('custom', 'sign-in', { again: true }) }),
          btn('small ghost', { label: 'Start over', disabled: t.busy, onclick: async () => {
            if (await confirmSheet({ title: 'Start over?', text: forgetText(f), ok: 'Start over' })) job('custom', 'forget', {});
          } }))];
    }
    return [need,
      steps(
        [h('strong', 'Sign in to Cloudflare'), h('span.hint', ' in this browser and approve one of your domains.')],
        [h('strong', 'Type the name'), h('span.hint', ', such as office.example.com.')],
        [h('strong', 'Done.'), h('span.hint', ' The link turns on at that address.')]),
      f.loginError ? h('p.mrow-error', f.loginError) : null,
      h('div.mrow-actions', btn('small primary', { icon: 'play', label: 'Set it up', disabled: t.busy, onclick: () => job('custom', 'sign-in', {}) }))];
  }

  // ---------- while it is on ----------
  function addressCard() {
    if (!(s.on && s.state === 'on' && s.url)) return null;
    return panel({ icon: 'external', title: 'The address' },
      ext(s.url, s.url, 'a.pl-url'),
      h('div.pl-actions',
        copyBtn(s.url),
        ext(s.url, [icon('external', { size: 16 }), h('span', 'Open')], 'a.btn.small.secondary'),
        here ? btn('small secondary', { icon: 'grid', label: 'QR', title: 'A one-time sign-in QR for a phone', onclick: () => qrSheet(s.url) }) : null),
      s.kind === 'temporary' ? h('p.hint', 'This address changes when the computer restarts. The new one shows here and goes to your notifications.') : null);
  }

  function visitorCard() {
    const pw = s.password || {};
    return panel({ icon: 'lock', title: 'Someone opening this address' },
      h('p', s.visitor),
      pw.state === 'weak' && ui.need !== 'stronger-password'
        ? [h('p.banner.warn', icon('alert', { size: 18 }), h('span', `Your password is too weak for this: ${pw.why}.`)),
          ui.strong ? strongForm(null, false) : h('div.savebar.start', btn('secondary', { icon: 'key', label: 'Make a strong password', onclick: () => { ui.strong = true; paint(); } }))]
        : null,
      pw.state === 'unknown' ? h('p.hint', 'Your password is checked for strength once, when you turn the link on.') : null);
  }

  function linkCard() {
    if (!(here && s.on && s.state === 'on' && s.url)) return null;
    const box = h('div');
    const show = async () => {
      try {
        const c = await api('~/api/links/code', {});
        if (!c.line) throw new Error('The address is not ready yet. Try again in a moment.');
        fill(box, h('div.cmdline', h('code', c.line), btn('icon ghost', { icon: 'copy', title: 'Copy', onclick: async () => toast((await copyText(c.line)) ? 'Copied: it works once, for 10 minutes' : 'Select and copy it by hand') })),
          h('p.hint', `It works once, until ${new Date(c.expires).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`));
      } catch (e) {
        fill(box, h('p.form-error', e.message));
      }
    };
    fill(box, h('div.savebar.start', btn('secondary', { icon: 'key', label: 'Show the line to paste', onclick: show })));
    return panel({ icon: 'cpu', title: 'Link another computer', desc: 'On the other computer: Computers → Link to my main Hoprig, and paste this line.' },
      box,
      s.kind === 'temporary' ? h('p.hint', 'With Temporary, a linked computer must be linked again when this address changes (after a restart). Use Custom to keep computers linked.') : null);
  }

  // ---------- Advanced ----------
  function advanced() {
    const f = s.custom;
    const k = kind();
    const parts = [];
    if (k === 'temporary') {
      const sv = s.service;
      parts.push(h('div.fieldrow',
        h('span.field-label', 'Another service on this computer'),
        h('span.hint', 'One more local service, such as TRouteAI\'s own dashboard on port 20017, gets a temporary address of its own. It should have its own sign-in page: you are asked first when it has none.'),
        sv
          ? h('div.addon-svc', ext(sv.url, sv.url), h('span.hint', `port ${sv.port}`),
            btn('small secondary', { icon: 'stop', label: 'Stop', disabled: ui.busy, onclick: () => job('temporary', 'remove-service', {}) }))
          : h('div.addon-form',
            input('quickPort', { type: 'number', inputmode: 'numeric', min: 1, max: 65535, placeholder: '20017', class: 'addon-port', 'aria-label': 'Port' }),
            btn('small secondary', { icon: 'play', label: 'Get an address', disabled: ui.busy, onclick: async () => {
              const r = await job('temporary', 'add-service', { port: Number(draft.quickPort) });
              if (r && r.ok) draft.quickPort = '';
            } }))));
    }
    if (k === 'custom' && f.state === 'ready' && f.mode === 'named') {
      parts.push(h('div.fieldrow',
        h('span.field-label', 'Another service on this computer'),
        h('span.hint', 'One more local service under a name of its own. It should have its own sign-in page: you are asked first when it has none.'),
        f.extra.map((x) => h('div.addon-svc', ext(x.url, x.url), h('span.hint', `port ${x.port}`),
          btn('small ghost', { icon: 'trash', label: 'Remove', disabled: ui.busy, onclick: async () => {
            const text = `${x.hostname} no longer leads to port ${x.port}. Its DNS record stays in Cloudflare (cloudflared cannot remove it): delete it under your domain → DNS → Records.`;
            if (await confirmSheet({ title: 'Remove this name?', text, ok: 'Remove', danger: true })) job('custom', 'remove-service', { hostname: x.hostname });
          } }))),
        f.extra.length < 5 ? h('div.addon-form',
          input('svcPort', { type: 'number', inputmode: 'numeric', min: 1, max: 65535, placeholder: '20017', class: 'addon-port', 'aria-label': 'Port' }),
          input('svcHost', { placeholder: `trouteai-${f.hostname}`, 'aria-label': 'Its address' }),
          btn('small secondary', { label: 'Add', disabled: ui.busy, onclick: async () => {
            const r = await job('custom', 'add-service', { port: Number(draft.svcPort), hostname: draft.svcHost });
            if (r && r.ok) draft.svcPort = draft.svcHost = '';
          } })) : null));
    }
    if (k === 'custom' && f.state !== 'ready') {
      parts.push(h('div.fieldrow',
        h('span.field-label', 'Use a tunnel token instead'),
        h('span.hint', `For a tunnel made in the Cloudflare dashboard (Networks → Tunnels). There, give it a public hostname that leads to http://127.0.0.1:${f.port}; then paste its install command or its token here.`),
        h('div.addon-form',
          input('token', { type: 'password', placeholder: 'cloudflared service install eyJ…', 'aria-label': 'Tunnel token' }),
          input('tokenHost', { placeholder: 'office.example.com', 'aria-label': 'Its address' }),
          btn('small secondary', { label: 'Use it', disabled: ui.busy, onclick: async () => {
            const r = await job('custom', 'token', { token: draft.token, hostname: draft.tokenHost });
            if (r && r.ok) draft.token = draft.tokenHost = '';
          } }))));
    }
    if (k === 'custom' && f.state === 'ready') {
      parts.push(h('div.fieldrow',
        h('span.field-label', 'Stop using my domain'),
        h('span.hint', 'Removes what Hoprig made for the Custom address and turns the link off. You are told first what happens in Cloudflare.'),
        h('div.mrow-actions', btn('small danger', { icon: 'trash', label: 'Stop using it', disabled: ui.busy, onclick: async () => {
          if (await confirmSheet({ title: 'Stop using your domain?', text: forgetText(f), ok: 'Stop using it', danger: true })) job('custom', 'forget', {});
        } }))));
    }
    return parts.length ? fold('public-link', 'Advanced', parts) : null;
  }

  /** Run a set-up step as a job and show its output until it ends; resolves the job's result. */
  async function job(k, step, body) {
    try {
      await api(`/api/public-link/${k}/${step}`, body);
    } catch (e) {
      toast(e.message, { kind: 'error' });
      return null;
    }
    ui.busy = true;
    clearTimeout(timer);
    out.hidden = false;
    fill(out);
    paint();
    let from = 0;
    try {
      for (;;) {
        const j = await api(`/api/public-link/job?from=${from}`).catch(() => null);
        if (!j || !isAlive()) return null;
        if (j.lines.length) add(out, `${j.lines.join('\n')}\n`);
        out.scrollTop = out.scrollHeight;
        from = j.next;
        if (!j.running) {
          const res = j.result || {};
          ui.busy = false;
          if (res.confirm) {
            if (await confirmSheet({ title: 'Make it reachable anyway?', text: `${res.confirm} Make it reachable from anywhere anyway?`, ok: 'Yes, make it reachable', danger: true })) return job(k, step, { ...body, confirmed: true });
            out.hidden = true;
            load();
            return res;
          }
          if (res.need) Object.assign(ui, { need: res.need, error: res.error });
          toast(res.ok ? 'Done' : res.error || 'That did not work', { kind: res.ok ? 'info' : 'error' });
          load();
          return res;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    } finally {
      ui.busy = false;
    }
  }

  function paint() {
    if (!s || !isAlive()) return;
    fill(root,
      switchCard(),
      h('section.card.panel',
        h('div.panel-head', h('div', h('h2.panel-title', 'Kind'), h('p.panel-desc', s.on ? 'Choosing the other one moves the link over.' : 'Used when you turn the switch on.'))),
        h('div.radiocards.pl-kinds', { role: 'radiogroup', 'aria-label': 'Kind' }, s.kinds.map(kindCard))),
      addressCard(),
      visitorCard(),
      linkCard(),
      advanced(),
      out);
  }

  load();
  return [root];
}

registerSettingsPage({
  id: 'public-link', title: 'Public link', icon: 'external', order: 45,
  desc: `Open ${APP_NAME} from anywhere: your phone, another network, another computer. No server, nothing to open on your router.`,
  summary: async () => linkSummary(await api('/api/public-link')),
  render,
});
