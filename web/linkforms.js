// The forms of Settings → Public link (publiclink.js) that ask the owner for something in place: the password typed
// once, "Make a strong password", and the Custom set-up in its card. Each gets the page's state as `p`:
// { s (the last GET /api/public-link), ui, draft, secret, input, secretInput, turn, load, job, out }.
import { icon } from './icons.js';
import { btn, confirmSheet, copyText, h, link, toast } from './lib.js';
import { field, steps } from './shell.js';

/** A long random password that is easy to read aloud (no 0/O, 1/l): four groups of five. */
export function makePassword(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = random(20);
  const chars = [...bytes].map((b) => abc[b % abc.length]).join('');
  return chars.match(/.{5}/g).join('-');
}

const plural = (list, one, many) => (list.length > 1 ? many : one);
const ext = (href, text, cls = 'a.mono') => h(cls, { href, target: '_blank', rel: 'noopener noreferrer' }, text);
const sentence = (t) => (/[.!?]$/.test(String(t).trim()) ? String(t).trim() : `${String(t).trim()}.`);

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

/**
 * What the server asked for before it turns on (a refused turn-on, or a link that is on but held back), in place.
 * `need`, `why`: from the refusal or from the state.
 */
export function needBox(p, need, why) {
  if (!need || need === 'custom-setup') return null;
  if (need === 'password') {
    return h('div.banner.warn', icon('lock', { size: 18 }), h('span', why, ' ', h('a', { href: link('#/settings/security') }, 'Settings → Security')));
  }
  if (need === 'check-password') {
    const pw = p.secretInput('password', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Dashboard password' });
    return h('form.stack.pl-need', { onsubmit: async (e) => {
      e.preventDefault();
      const typed = pw.value;
      p.secret.password = ''; // kept no longer than the request
      await p.turn(true, undefined, { password: typed });
    } },
      h('p.hint', why),
      field('Your dashboard password', pw),
      h('div.savebar.start', h('button.btn.primary', { type: 'submit' }, 'Check it and turn on')));
  }
  return strongForm(p, why, true);
}

/** "Make a strong password": the current one, a new one (or one made here, shown once), then on again. */
export function strongForm(p, why, thenOn) {
  const { ui, secret } = p;
  const cur = p.secretInput('current', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password' });
  const next = p.secretInput('next', { type: secret.made ? 'text' : 'password', autocomplete: 'new-password', 'aria-label': 'New password' });
  // Its refusal is kept with the page's state, so a look-again that draws the page anew does not lose it; it goes as
  // soon as the new password changes.
  const msg = h('p.form-error', { role: 'alert' }, ui.pwError || '');
  next.addEventListener('input', () => {
    secret.made = false;
    msg.textContent = ui.pwError = '';
  });
  return h('form.stack.pl-need', { onsubmit: async (e) => {
    e.preventDefault();
    msg.textContent = ui.pwError = '';
    try {
      await p.api('/api/settings/password', { current: cur.value, next: next.value, strong: true });
      // Typed passwords are kept only while this form needs them (and only in this page, never trimmed).
      Object.assign(secret, { current: '', next: '', made: false });
      ui.pwError = '';
      toast('The new password is saved. Other browsers sign in again with it.');
      ui.need = null;
      ui.strong = false;
      if (thenOn) await p.turn(true);
      else p.load(true);
    } catch (er) {
      msg.textContent = ui.pwError = sentence(er.message);
      (/current password/i.test(er.message) ? cur : next).focus();
    }
  } },
    why ? h('p.hint', why) : null,
    field('Current password', cur),
    field('New password', next, 'At least 12 characters, not a word people try first. Keep it in your password manager.'),
    h('div.savebar.start',
      btn('secondary', { icon: 'key', label: 'Make one for me', onclick: () => {
        // Shown once, so it can be copied into a password manager.
        next.type = 'text';
        next.value = secret.next = makePassword();
        secret.made = true;
        msg.textContent = ui.pwError = '';
        next.select();
      } }),
      btn('ghost', { icon: 'copy', label: 'Copy it', onclick: async () => next.value && toast((await copyText(next.value)) ? 'Copied' : 'Select and copy it by hand') }),
      h('button.btn.primary', { type: 'submit' }, thenOn ? 'Save it and turn on' : 'Save it')),
    msg);
}

/**
 * The Custom set-up, in its card: one numbered list whose steps keep their meaning (1 sign in to Cloudflare, 2 the
 * name, 3 done); the step at hand holds its buttons, and its progress shows under it.
 */
export function customBody(p) {
  const { s, ui, draft } = p;
  const f = s.custom;
  if (f.state === 'ready') {
    return [h('p.hint', 'Set up: ', ext(f.url, f.hostname)),
      !s.on ? h('p.hint', 'Turn the switch on to use it.') : s.kind !== 'custom' ? h('p.hint', 'Choose it above to move the link there.') : null];
  }
  const busy = ui.busy;
  const need = ui.need === 'custom-setup' || s.need === 'custom-setup'
    ? h('p.banner.info', icon('info', { size: 18 }), h('span', s.on && s.kind !== 'custom' ? 'Set it up first: the link moves to it by itself when it is made. Until then the Temporary address keeps working.' : 'Set it up first: it turns on by itself when it is made.'))
    : null;
  let first;
  let second = [h('strong', 'Type the name'), h('span.hint', 'Such as office.example.com.')];
  if (f.state === 'signing-in') {
    first = [h('strong', 'Sign in to Cloudflare'), h('span.hint', 'Open Cloudflare, sign in (a free account is enough), pick the domain for this address and press Authorize. Then come back here: this page goes on by itself.'),
      h('div.mrow-actions',
        f.loginUrl ? h('a.btn.small.primary', { href: f.loginUrl, target: '_blank', rel: 'noopener noreferrer', 'data-fk': 'open-cloudflare' }, icon('external', { size: 16 }), h('span', 'Open Cloudflare')) : null,
        btn('small ghost', { label: 'Cancel', disabled: busy, onclick: () => p.job('custom', 'cancel', {}) }))];
  } else if (f.state === 'signed-in') {
    first = [h('strong', 'Sign in to Cloudflare'), h('span.hint', 'Done.'),
      h('div.mrow-actions',
        btn('small ghost', { label: 'Sign in again', title: 'For another Cloudflare account or domain', disabled: busy, onclick: () => p.job('custom', 'sign-in', { again: true }) }),
        btn('small ghost', { label: 'Start over', disabled: busy, onclick: async () => {
          if (await confirmSheet({ title: 'Start over?', text: forgetText(f), ok: 'Start over' })) p.job('custom', 'forget', {});
        } }))];
    const host = p.input('hostname', { placeholder: `${f.suggested}.example.com`, 'aria-label': 'The address' });
    if (!draft.hostname) host.value = `${f.suggested}.`;
    // A form: Enter in the field makes it, as the button does.
    second = [h('strong', 'Type the name'),
      h('form.addon-form', { onsubmit: async (e) => {
        e.preventDefault();
        draft.hostname = host.value.trim();
        const r = await p.job('custom', 'create', { hostname: draft.hostname });
        if (r && r.ok) draft.hostname = '';
      } }, host, h('button.btn.small.primary', { type: 'submit', disabled: busy, 'data-fk': 'make-it' }, 'Make it')),
      h('span.hint', 'A name under the domain you picked in Cloudflare. Hoprig makes the tunnel and its DNS record there, then turns the link on.')];
  } else {
    first = [h('strong', 'Sign in to Cloudflare'), h('span.hint', 'In this browser, then approve one of your domains.'),
      f.loginError ? h('p.mrow-error', f.loginError) : null,
      h('div.mrow-actions', btn('small primary', { icon: 'play', label: 'Set it up', disabled: busy, 'data-fk': 'set-it-up', onclick: () => p.job('custom', 'sign-in', {}) }))];
  }
  return [need,
    steps(first, second, [h('strong', 'Done.'), h('span.hint', 'The link turns on at that address.')]),
    ui.outAt === 'custom' ? p.out : null];
}

/** Advanced → "Use a tunnel token instead" (Custom, before it is set up): a form, so Enter uses it. */
export function tokenForm(p) {
  const f = p.s.custom;
  const token = p.input('token', { type: 'password', placeholder: 'cloudflared service install eyJ…', 'aria-label': 'Tunnel token' });
  const host = p.input('tokenHost', { placeholder: 'office.example.com', 'aria-label': 'Its address' });
  return h('div.fieldrow',
    h('span.field-label', 'Use a tunnel token instead'),
    h('span.hint', `For a tunnel made in the Cloudflare dashboard (Networks → Tunnels). There, give it a public hostname that leads to http://127.0.0.1:${f.port}; then paste its install command or its token here.`),
    h('form.addon-form', { onsubmit: async (e) => {
      e.preventDefault();
      const r = await p.job('custom', 'token', { token: p.draft.token, hostname: p.draft.tokenHost }, 'advanced');
      if (r && r.ok) p.draft.token = p.draft.tokenHost = '';
    } }, token, host, h('button.btn.small.secondary', { type: 'submit', disabled: p.ui.busy }, 'Use it')));
}
