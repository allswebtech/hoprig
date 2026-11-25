// Settings → Public link (src/addons/linkswitch.mjs; routes in linkroutes.mjs): one switch that makes this dashboard
// reachable from anywhere through Cloudflare, as one of two kinds, never both: Temporary (the default, nothing to set
// up, a new address at each start) or Custom (the owner's own address, set up once inside its card). While it is on:
// the address with Copy, Open and a sign-in QR, what a visitor has to do, and the line another computer pastes to
// link itself here. When the server cannot turn it on (or holds a link that is on back) it says what it needs, and
// the page asks for that in place (linkforms.js). The rarer things are under Advanced.
import { APP_NAME } from './brand.js';
import { icon } from './icons.js';
import { add, api, btn, confirmSheet, copyText, fill, h, openSheet, qrSvg, toast, wayLink } from './lib.js';
import { customBody, forgetText, makePassword, needBox, strongForm, tokenForm } from './linkforms.js';
import { registerSettingsPage } from './registry.js';
import { panel } from './shell.js';

export { forgetText, makePassword };

/** The state in one pill: [state class, text]. */
export function statePill(s) {
  if (!s || !s.on) return s && s.state === 'error' ? ['attention', 'Off: it did not start'] : ['ended', 'Off'];
  if (s.state === 'blocked') return ['attention', s.need === 'custom-setup' ? 'Waiting for the set-up' : 'Waiting for a strong password'];
  return {
    installing: ['starting', 'Installing cloudflared…'],
    starting: ['starting', 'Starting…'],
    on: ['waiting', 'On'],
    retrying: ['attention', 'Trying again'],
    error: ['attention', 'Not working'],
  }[s.state] || ['starting', 'Starting…'];
}

// The Temporary card in words a person who never heard of a tunnel reads: who carries the link, and what changes.
// The server's words (KIND_WORDS of src/addons/linkswitch.mjs) are taken where the page has none of its own.
export const KIND_PLAIN = Object.freeze({
  temporary: {
    needs: 'Nothing. The first time, Hoprig downloads a small free program from Cloudflare (the company that carries the link).',
    gives: 'An https address that opens this page from anywhere, a new address each time the computer starts.',
  },
});
export const kindWords = (k) => (k && Object.hasOwn(KIND_PLAIN, k.id) ? { ...k, ...KIND_PLAIN[k.id] } : k);

/** The one line in the Settings list: Off, or the kind and its address. */
export function linkSummary(s) {
  if (!s || !s.on) return 'Off';
  const kind = s.kind === 'custom' ? 'Custom' : 'Temporary';
  if (s.state === 'on' && s.url) return `${kind}: ${s.url.replace(/^https:\/\//, '')}`;
  return `${kind}: ${statePill(s)[1].toLowerCase()}`;
}

/** Whether the page looks again soon: while it starts, tries again, or waits for Cloudflare's approval. */
export const needsPoll = (s) => !!(s && ((s.on && !['on', 'blocked'].includes(s.state)) || (s.custom && s.custom.state === 'signing-in')));

/**
 * A failure in plain words, or null when it has none (the server's own messages are plain already). cloudflared's
 * raw line stays behind "Details".
 */
export function plainError(raw) {
  const t = String(raw || '');
  if (/could not be installed/.test(t)) return 'cloudflared could not be downloaded. Check this computer\'s internet connection.';
  if (/no such host|ENOTFOUND|EAI_AGAIN|dial tcp|i\/o timeout|network is unreachable|connection refused|context deadline exceeded|TLS handshake timeout/i.test(t)) return 'This computer cannot reach Cloudflare. Check its internet connection.';
  if (/\b429\b|Too Many Requests/i.test(t)) return 'Cloudflare asked to wait before the next try.';
  return null;
}

const sentence = (t) => (/[.!?]$/.test(String(t).trim()) ? String(t).trim() : `${String(t).trim()}.`);
const pill = ([key, text]) => h(`span.pill.st-${key}`, h('span.dot'), text);
const ext = (href, text, cls = 'a.mono') => h(cls, { href, target: '_blank', rel: 'noopener noreferrer' }, text);
const copyBtn = (text, label = 'Copy', done = 'Copied') => btn('small secondary', { icon: 'copy', label, onclick: async () => toast((await copyText(text)) ? done : 'Select and copy it by hand') });

/** A sheet with a sign-in QR made for that address: a phone scanning it lands signed in there, once. */
async function qrSheet(url) {
  try {
    const l = await api('~/api/login/links', { base: url });
    openSheet({ title: 'Sign in a phone' }, (close) => [
      h('p.sheet-text', `Scan it with the phone's camera: it opens ${url} signed in. It works once, for 15 minutes.`),
      l.qr ? h('div.pl-qr', h('div.qrbox', qrSvg(l.qr))) : null,
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Close')),
    ]);
  } catch (e) {
    toast(e, { kind: 'error' });
  }
}

function render({ here, isAlive }) {
  // What was typed, kept while the page is drawn again; it goes with the page. Passwords are kept as typed (never
  // trimmed) and only until they are sent.
  const draft = { hostname: '', token: '', tokenHost: '', svcPort: '', svcHost: '', quickPort: '' };
  const secret = { password: '', current: '', next: '', made: false };
  const root = h('div.pl', h('p.muted', 'Looking at the public link…'));
  const out = h('pre.output', { hidden: true, 'aria-live': 'polite' });
  // need/error: a refused turn-on; chosen: a kind picked but not switched to yet; outAt: where a job's output shows
  // ('custom': in its card, 'advanced'); focus: the control (data-fk) to focus after the next draw.
  const ui = { need: null, error: null, busy: false, chosen: null, outAt: null, focus: null, strong: false, pwError: '' };
  let s = null;
  let timer = null;
  let shown = null; // the one line the Settings list showed for it
  let lastKey = null; // on/kind/state as last drawn: a job's leftover output goes when it changes
  let advancedOpen = false;
  let lastCustom = null; // the Custom set-up's state as last drawn

  const input = (key, attrs) => h('input.field', { value: draft[key], autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'data-fk': key, oninput: (e) => (draft[key] = e.target.value.trim()), ...attrs });
  const secretInput = (key, attrs) => h('input.field', { value: secret[key], autocapitalize: 'off', spellcheck: 'false', 'data-fk': key, oninput: (e) => (secret[key] = e.target.value), ...attrs });
  const kind = () => ui.chosen || s.kind;
  const clearOutput = () => {
    fill(out);
    out.hidden = true;
    ui.outAt = null;
  };

  /** Look at the state and draw the page; `now`: after the owner's own action, even while a field has the focus. */
  async function load(now = false) {
    clearTimeout(timer);
    if (!isAlive()) return;
    // Someone typing here keeps what they type: look again a little later instead of drawing the page again.
    const a = document.activeElement;
    const typing = a && root.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'radio'].includes(a.type)));
    if (!now && s && typing) {
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
    // A kind picked while the link is on stays picked while it is set up (Custom's steps stay in its card until it
    // is made and the link moves); otherwise what the server says is the choice.
    const settingUp = ui.chosen === 'custom' && s.kind !== 'custom' && s.custom.state !== 'ready';
    if ((s.on && !settingUp) || ui.chosen === s.kind) ui.chosen = null;
    if (ui.need === 'custom-setup' && s.custom.state === 'ready') ui.need = null;
    // The set-up goes on by itself (Cloudflare approved): the focus goes to what is next, the name.
    if (lastCustom === 'signing-in' && s.custom.state === 'signed-in' && kind() === 'custom') ui.focus = 'hostname';
    lastCustom = s.custom.state;
    // The Settings list beside this page says the state in one line: told to look again when that line changed.
    const line = linkSummary(s);
    if (shown !== null && line !== shown) window.dispatchEvent(new Event('saved'));
    shown = line;
    const key = `${s.on}/${s.kind}/${s.state}`;
    if (lastKey !== null && key !== lastKey && !ui.busy) clearOutput();
    lastKey = key;
    paint();
    if (!ui.busy) timer = setTimeout(load, needsPoll(s) ? 1500 : s.on ? 10000 : 30000);
  }

  /** Ask the server; a refusal says what it needs, which the page asks for in place (and focuses). */
  async function turn(on, k = kind(), extra = {}) {
    ui.error = null;
    try {
      const r = await api('/api/public-link', on ? { on: true, kind: k, ...extra } : { on: false, kind: k });
      if (r.ok === false) Object.assign(ui, { need: r.need || null, error: r.error, chosen: k });
      else Object.assign(ui, { need: null, chosen: null });
      if (r.need === 'custom-setup') ui.chosen = 'custom';
      ui.focus = { 'check-password': 'password', 'stronger-password': 'current', 'custom-setup': 'set-it-up' }[r.need] || ui.focus;
    } catch (e) {
      ui.error = e.message;
      if (extra.password !== undefined) ui.focus = 'password';
    }
    await load(true);
  }

  // ---------- the switch ----------
  function switchCard() {
    const sw = h('input.switch', { type: 'checkbox', role: 'switch', checked: s.on, 'aria-label': 'Public link', 'data-fk': 'switch', onchange: (e) => turn(e.target.checked) });
    const busy = s.on && ['installing', 'starting'].includes(s.state);
    const wait = s.nextTryAt ? Math.max(1, Math.round((s.nextTryAt - Date.now()) / 1000)) : 0;
    // A link that is on but held back (or carried over with a password never checked) asks for what it needs as a
    // refused turn-on does.
    const need = ui.need || s.need || null;
    const why = ui.need ? ui.error : s.state === 'blocked' ? s.error : null;
    return panel({ id: 'public-link-switch' },
      h('label.switchrow.pl-switch',
        h('span.switchrow-text', h('span.switchrow-label', 'Public link'), h('span', pill(statePill(s)))),
        sw),
      busy && s.progress.length ? h('ul.pl-progress', s.progress.slice(-4).map((l) => h('li', l))) : null,
      s.error && s.state !== 'blocked' && (s.on || s.state === 'error') ? failure(s.error, wait, s) : null,
      ui.error && !ui.need ? h('p.mrow-error', ui.error) : null,
      needBox(p, need, why),
      !s.on ? h('p.hint', 'Off until you turn it on: nothing is reachable from outside while it is off.') : null);
  }

  // A failure: plain words and what happens next; cloudflared's own line behind "Details".
  // `from`: the status, whose code (no-password) gets its place's button (errorways.js).
  function failure(raw, wait, from = null) {
    const plain = plainError(raw);
    const next = wait ? ` It tries again by itself in ${wait} s.` : s.on && s.state === 'retrying' ? ' It tries again by itself.' : '';
    const way = from ? wayLink(from) : null;
    return h('div.pl-fail',
      h('p.mrow-error', `${sentence(plain || raw)}${next}`),
      way ? h('p.pl-way', way) : null,
      plain ? h('details.pl-details', h('summary', 'Details'), h('code', raw)) : null);
  }

  // ---------- the two kinds ----------
  function kindCard(server) {
    const k = kindWords(server);
    const on = kind() === k.id;
    const choose = async () => {
      if (on) return;
      // Back to the kind that is on: only the pick is undone.
      if (s.on && k.id === s.kind) {
        Object.assign(ui, { chosen: null, need: null, focus: `kind-${k.id}` });
        return paint();
      }
      if (s.on) {
        const other = s.kind === 'custom' ? 'Custom' : 'Temporary';
        const notReady = k.id === 'custom' && !k.ready;
        const text = notReady
          ? `Custom is set up first, here in its card. The link moves over when it is made; the ${other} address stops working then.`
          : `The ${other} address stops working. ${k.id === 'temporary' ? 'The new address is shown here once it is ready.' : ''}`.trim();
        if (!(await confirmSheet({ title: `Move the public link to ${k.title}?`, text, ok: notReady ? 'Set up Custom' : `Move to ${k.title}` }))) return paint();
        if (notReady) {
          Object.assign(ui, { chosen: 'custom', need: 'custom-setup', focus: 'set-it-up' });
          return paint();
        }
        return turn(true, k.id);
      }
      Object.assign(ui, { chosen: k.id, need: null, focus: `kind-${k.id}` });
      if (k.id === 'temporary' || k.ready) return turn(false, k.id);
      paint();
    };
    return h(`div.radiocard.pl-kind${on ? '.on' : ''}`,
      h('label.pl-kind-head',
        h('input', { type: 'radio', name: 'pl-kind', value: k.id, checked: on, 'data-fk': `kind-${k.id}`, onchange: choose }),
        h('span.radiocard-text',
          h('span.radiocard-title', k.title, s.on && s.kind === k.id ? h('span.badge.soft', 'in use') : null),
          h('span.radiocard-sub', k.text),
          h('span.pl-kind-more', h('strong', 'Needs: '), k.needs),
          h('span.pl-kind-more', h('strong', 'Gives: '), k.gives))),
      k.id === 'custom' && on ? h('div.pl-kind-body', customBody(p)) : null);
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
      s.kind === 'temporary' ? h('p.hint', 'This address changes whenever Hoprig or this computer restarts (an update of Hoprig too). The new one shows here and goes to your notifications.') : null);
  }

  function visitorCard() {
    const pw = s.password || {};
    const live = s.on && s.state === 'on' && s.url;
    const need = ui.need || s.need;
    return panel({ icon: 'lock', title: live ? 'Someone opening this address' : 'Someone opening the address' },
      h('p', live ? s.visitor : 'While the link is on, someone who opens its address sees the sign-in page. They need your Hoprig password, or a sign-in QR made on a device that is already signed in.'),
      pw.state === 'weak' && need !== 'stronger-password'
        ? [h('p.banner.warn', icon('alert', { size: 18 }), h('span', pw.why ? `Your password is too weak for this: ${sentence(pw.why)}` : 'Your password is too weak for this.')),
          ui.strong ? strongForm(p, null, false) : h('div.savebar.start', btn('secondary', { icon: 'key', label: 'Make a strong password', onclick: () => { Object.assign(ui, { strong: true, focus: 'current' }); paint(); } }))]
        : null,
      pw.state === 'unknown' && !s.on ? h('p.hint', 'Your password is checked for strength once, when you turn the link on.') : null);
  }

  function linkCard() {
    if (!(here && s.on && s.state === 'on' && s.url)) return null;
    const box = h('div');
    const show = async () => {
      try {
        const c = await api('~/api/links/code', {});
        if (!c.line) throw new Error('The address is not ready yet. Try again in a moment.');
        fill(box, h('div.cmdline', h('code', c.line), btn('icon ghost', { icon: 'copy', title: 'Copy', onclick: async () => toast((await copyText(c.line)) ? 'Copied: it works once, for 10 minutes' : 'Select and copy it by hand') })),
          c.note ? h('p.hint', c.note) : null,
          h('p.hint', `It works once, until ${new Date(c.expires).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`));
      } catch (e) {
        fill(box, h('p.form-error', e.message));
      }
    };
    fill(box, h('div.savebar.start', btn('secondary', { icon: 'key', label: 'Show the line to paste', onclick: show })));
    return panel({ icon: 'cpu', title: 'Link another computer', desc: 'On the other computer: Computers → Link to my main Hoprig, and paste this line.' },
      box,
      s.kind === 'temporary' ? h('p.hint', 'With Temporary, a linked computer must be linked again when this address changes (whenever Hoprig or this computer restarts). Use Custom to keep computers linked.') : null);
  }

  // ---------- Advanced ----------
  function advanced() {
    const f = s.custom;
    const k = kind();
    const parts = [];
    const sv = s.service;
    // A second temporary address that runs is shown whatever kind is picked, with its Stop.
    if (sv || k === 'temporary') {
      parts.push(h('div.fieldrow',
        h('span.field-label', 'Another service on this computer'),
        h('span.hint', 'While the link is on as Temporary, one more local service, such as a gateway\'s own dashboard on its port, gets a temporary address of its own. It should have its own sign-in page: you are asked first when it has none. It stops with the link.'),
        sv
          ? h('div.addon-svc', ext(sv.url, sv.url), h('span.hint', `port ${sv.port}`),
            btn('small secondary', { icon: 'stop', label: 'Stop', disabled: ui.busy, onclick: () => job('temporary', 'remove-service', {}, 'advanced') }))
          : s.on && s.kind === 'temporary'
            ? h('form.addon-form', { onsubmit: async (e) => {
              e.preventDefault();
              const r = await job('temporary', 'add-service', { port: Number(draft.quickPort) }, 'advanced');
              if (r && r.ok) draft.quickPort = '';
            } },
              input('quickPort', { type: 'number', inputmode: 'numeric', min: 1, max: 65535, placeholder: '20017', class: 'addon-port', 'aria-label': 'Port' }),
              h('button.btn.small.secondary', { type: 'submit', disabled: ui.busy }, icon('play', { size: 18 }), h('span', 'Get an address')))
            : h('p.hint', 'Turn the link on as Temporary first.')));
    }
    if (k === 'custom' && f.state === 'ready' && f.mode === 'named') {
      parts.push(h('div.fieldrow',
        h('span.field-label', 'Another service on this computer'),
        h('span.hint', 'One more local service under a name of its own. It should have its own sign-in page: you are asked first when it has none.'),
        f.extra.map((x) => h('div.addon-svc', ext(x.url, x.url), h('span.hint', `port ${x.port}`),
          btn('small ghost', { icon: 'trash', label: 'Remove', disabled: ui.busy, onclick: async () => {
            const text = `${x.hostname} no longer leads to port ${x.port}. Its DNS record stays in Cloudflare (cloudflared cannot remove it): delete it under your domain → DNS → Records.`;
            if (await confirmSheet({ title: 'Remove this name?', text, ok: 'Remove', danger: true })) job('custom', 'remove-service', { hostname: x.hostname }, 'advanced');
          } }))),
        f.extra.length < 5 ? h('form.addon-form', { onsubmit: async (e) => {
          e.preventDefault();
          const r = await job('custom', 'add-service', { port: Number(draft.svcPort), hostname: draft.svcHost }, 'advanced');
          if (r && r.ok) draft.svcPort = draft.svcHost = '';
        } },
          input('svcPort', { type: 'number', inputmode: 'numeric', min: 1, max: 65535, placeholder: '20017', class: 'addon-port', 'aria-label': 'Port' }),
          input('svcHost', { placeholder: `gateway-${f.hostname}`, 'aria-label': 'Its address' }),
          h('button.btn.small.secondary', { type: 'submit', disabled: ui.busy }, 'Add')) : null));
    }
    if (k === 'custom' && f.state !== 'ready') parts.push(tokenForm(p));
    if (k === 'custom' && f.state === 'ready') {
      parts.push(h('div.fieldrow',
        h('span.field-label', 'Stop using my domain'),
        h('span.hint', 'Removes what Hoprig made for the Custom address and turns the link off. You are told first what happens in Cloudflare.'),
        h('div.mrow-actions', btn('small danger', { icon: 'trash', label: 'Stop using it', disabled: ui.busy, onclick: async () => {
          if (await confirmSheet({ title: 'Stop using your domain?', text: forgetText(f), ok: 'Stop using it', danger: true })) job('custom', 'forget', {}, 'advanced');
        } }))));
    }
    if (ui.outAt === 'advanced') parts.push(out);
    if (!parts.length) return null;
    // Open while one of its jobs shows its output; otherwise as the owner left it.
    const d = h('details.fold', { open: ui.outAt === 'advanced' || advancedOpen },
      h('summary.fold-summary', h('span', 'Advanced'), icon('chevronDown', { size: 18 })),
      h('div.fold-body', parts));
    d.addEventListener('toggle', () => (advancedOpen = d.open));
    return d;
  }

  /**
   * Run a set-up step as a job and show its output under what started it (`at`: 'custom', its card; 'advanced').
   * Resolves the job's result. Output of a step that worked goes; a failure's stays until the state changes.
   */
  async function job(k, step, body, at = 'custom') {
    try {
      await api(`/api/public-link/${k}/${step}`, body);
    } catch (e) {
      toast(e, { kind: 'error' });
      return null;
    }
    ui.busy = true;
    clearTimeout(timer);
    clearOutput();
    ui.outAt = at;
    paint();
    let from = 0;
    try {
      for (;;) {
        const j = await api(`/api/public-link/job?from=${from}`).catch(() => null);
        if (!j || !isAlive()) return null;
        if (j.lines.length) add(out, `${j.lines.join('\n')}\n`);
        out.hidden = !out.textContent;
        out.scrollTop = out.scrollHeight;
        from = j.next;
        if (!j.running) {
          const res = j.result || {};
          ui.busy = false;
          if (res.confirm) {
            if (await confirmSheet({ title: 'Make it reachable anyway?', text: `${res.confirm} Make it reachable from anywhere anyway?`, ok: 'Yes, make it reachable', danger: true })) return job(k, step, { ...body, confirmed: true }, at);
            clearOutput();
            load(true);
            return res;
          }
          if (res.need) Object.assign(ui, { need: res.need, error: res.error });
          if (res.ok) clearOutput();
          if (res.ok && step === 'sign-in') ui.focus = 'open-cloudflare';
          // The sign-in step only opens Cloudflare's page: nothing is done until the owner approves there.
          if (!res.ok) toast(res.error || 'That did not work', { kind: 'error', from: res });
          else if (step !== 'sign-in') toast('Done');
          load(true);
          return res;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    } finally {
      ui.busy = false;
    }
  }

  // What the forms in linkforms.js get.
  const p = {
    get s() { return s; },
    ui, draft, secret, out, input, secretInput, turn, job, api,
    load: (now) => load(now),
    paint: () => paint(),
  };

  function paint() {
    if (!s || !isAlive()) return;
    // A redraw replaces every control: the one that had the focus (or the one to go to next) gets it back.
    const a = document.activeElement;
    const had = a && root.contains(a) ? a.dataset.fk || null : null;
    fill(root,
      switchCard(),
      // While it is on, the address comes first: it is what the page is opened for.
      addressCard(),
      h('section.card.panel',
        h('div.panel-head', h('div', h('h2.panel-title', 'Kind'), h('p.panel-desc', s.on ? 'Choosing the other one moves the link over.' : 'Used when you turn the switch on.'))),
        h('div.radiocards.pl-kinds', { role: 'radiogroup', 'aria-label': 'Kind' }, s.kinds.map(kindCard))),
      visitorCard(),
      linkCard(),
      advanced());
    // Output whose own place is not drawn now (Custom's card is closed): under the switch rather than nowhere.
    if (ui.outAt && !root.contains(out)) root.firstChild.after(out);
    const want = ui.focus || had;
    const moved = !!ui.focus;
    ui.focus = null;
    const el = want ? [...root.querySelectorAll('[data-fk]')].find((e) => e.dataset.fk === want) : null;
    if (el && !el.disabled) el.focus({ preventScroll: !moved });
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
