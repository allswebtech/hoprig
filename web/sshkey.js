// Computers → Add a computer → by SSH → "With a key file" (src/machines/keyadd.mjs): the address, the user, the port and
// the private key (pasted, or picked from a file). Step one answers with the host key's print, which the owner compares
// and confirms by the computer's name; only then does anything log in there. The key field is emptied as soon as it is
// sent, and the key is never shown again: the page keeps no copy of it, the server answers none.
import { APP_NAME } from './brand.js';
import { icon } from './icons.js';
import { add, api, btn, confirmSheet, fill, h } from './lib.js';
import { errorBox, field } from './shell.js';
import { busy } from './joinlink.js';
import { rootLoginBox } from './rootlogin.js';

/** Follow the install job's output into `out` until it ends; resolves its result. */
async function follow(out, isAlive) {
  let from = 0;
  for (;;) {
    const r = await api(`~/api/machines/install?from=${from}`);
    if (r.lines.length) add(out, `${r.lines.join('\n')}\n`);
    out.scrollTop = out.scrollHeight;
    from = r.next;
    if (!r.running || !isAlive()) return r.result;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/** The form; `done(machine, hint)` draws the result of an add that worked. */
export function byKey(isAlive, done) {
  const opt = { autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' };
  const host = h('input.field', { ...opt, placeholder: '203.0.113.7 or box2.example.com', 'aria-label': 'Address' });
  const user = h('input.field', { ...opt, placeholder: 'alex', 'aria-label': 'User' });
  const port = h('input.field', { ...opt, inputmode: 'numeric', value: '22', 'aria-label': 'SSH port' });
  const key = h('textarea.field.mono', { ...opt, rows: 5, placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----', 'aria-label': 'Private key' });
  const file = h('input', { type: 'file', class: 'cp-keyfile', 'aria-label': 'Pick the key file' });
  file.onchange = async () => {
    const f = file.files && file.files[0];
    file.value = '';
    if (!f) return;
    if (f.size > 16 * 1024) return fill(msg, errorBox('That file is too large to be a private SSH key.'));
    key.value = await f.text();
  };
  const msg = h('div', { role: 'status' });
  const go = h('button.btn.primary', { type: 'submit' }, icon('plus', { size: 18 }), h('span', 'Next'));

  // `stayRoot` ({ sentence }): typed in the root-login box, to keep Hoprig on root there on purpose.
  async function install(pending, s, stayRoot, rootWords = null, workUser = false) {
    const out = h('pre.output', { 'aria-live': 'polite' });
    fill(msg, busy(`Installing ${APP_NAME} on ${s.shown}… this can take a few minutes. Its lines show here as they come.`), out);
    try {
      await api('~/api/machines/ssh/key/install', { pending, confirm: s.name, ...(stayRoot ? { stayRoot } : {}), ...(workUser ? { workUser } : {}) });
      const r = await follow(out, isAlive);
      if (!r || !r.ok) return add(msg, errorBox(r && r.error ? r.error : 'The installer did not finish: see its lines above. Fix what they say, then start again with Next.'));
      return confirmIt({ ...s, pending, print: printOf.get(pending) }, true);
    } catch (e) {
      // A root login there: nothing was installed; the box says why and offers the sentence.
      const words = rootWords || e.message;
      if (e.code === 'root-login' || (e.code === 'stay-root' && rootWords)) return fill(msg, rootLoginBox(words, (t) => install(pending, s, t, words), e.code === 'stay-root' ? e.message : null, { server: s.shown, makeUser: (w) => install(pending, s, null, words, w || true) }));
      add(msg, errorBox(e));
    }
  }

  const printOf = new Map();
  async function confirmIt(s, again = false) {
    fill(msg, busy(again ? `Adding ${s.shown}…` : `Logging in to ${s.shown} with the key…`));
    try {
      const r = await api('~/api/machines/ssh/key/confirm', { pending: s.pending, print: s.print, confirm: s.name });
      fill(msg, done(r.machine, r.hint));
    } catch (e) {
      if (e.code === 'not-installed' && e.data.canInstall && e.data.pending) {
        return fill(msg,
          errorBox(`${APP_NAME} is not installed on ${s.shown} yet.`),
          h('p.hint', `This page can install it there with the same key. It needs Node.js 24.13.1 or newer there.`),
          h('div.savebar.start', btn('primary', { icon: 'download', label: `Install ${APP_NAME} on ${s.shown}`, onclick: async () => {
            if (await confirmSheet({ title: `Install ${APP_NAME} on ${s.shown}?`, text: `The installer runs on ${s.shown} as the user you gave. Its lines show here as they come.`, ok: `Install on ${s.shown}` })) install(e.data.pending, s);
          } })));
      }
      fill(msg, errorBox(e), h('p.hint', e.code === 'ssh-auth' ? 'If you made the key yourself: its public half (the .pub file) belongs in ~/.ssh/authorized_keys of that user there.' : 'Start again with Next when you have fixed it.'));
    }
  }

  async function next() {
    if (!host.value.trim() || !user.value.trim()) return fill(msg, errorBox('Type the computer\'s address and the user you log in with there.'));
    if (!key.value.trim()) return fill(msg, errorBox('Paste the private key, or pick its file.'));
    go.disabled = true;
    fill(msg, busy(`Reading the host key of ${host.value.trim()}…`));
    const body = { host: host.value.trim(), user: user.value.trim(), port: port.value.trim() || 22, key: key.value };
    key.value = ''; // sent once; never shown again
    try {
      // Called by what he typed until it is added: its inner name ("server" for an address) is only the route's.
      const s = { ...(await api('~/api/machines/ssh/key', body)), shown: body.host };
      printOf.set(s.pending, s.print);
      fill(msg,
        h('div.cp-print',
          h('p', h('strong', `This is the host key of ${s.target}:`)),
          h('code.cp-printcode', s.print),
          h('p.hint', 'Compare it with the print the server shows (its provider\'s panel, or ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub there). If it is the same, the computer is the one you mean. Nothing has logged in yet.')),
        h('div.savebar.start',
          btn('primary', { icon: 'check', label: `It matches: add ${s.shown}`, onclick: (e) => {
            e.currentTarget.disabled = true; // one press: a second one while it logs in is refused anyway
            confirmIt(s);
          } }),
          btn('ghost', { label: 'It does not match', onclick: () => fill(msg, errorBox('Then do not add it: someone may stand between this computer and that one. Nothing was kept.')) })));
    } catch (e) {
      fill(msg, errorBox(e));
    }
    go.disabled = false;
  }

  return h('form.stack', { onsubmit: (e) => { e.preventDefault(); next(); } },
    h('div.cp-keygrid', field('Address', host), field('User', user)),
    field('Private key', key, 'The key file the company you rent the server from gave you, or one you made. It is kept only in this dashboard\'s own folder for keys and shown never again. A key with a passphrase (a password of its own that is asked each time the key is used) cannot be used.'),
    // Nearly every server takes SSH on port 22: the field stays out of the way unless he needs another one.
    h('details.adv.cp-fold.cp-keyadv', h('summary', 'Advanced'), field('SSH port', port, 'Leave 22 unless the company gave you another port.')),
    h('div.savebar.start', h('label.btn.secondary.small.cp-keybtn', icon('upload', { size: 16 }), h('span', 'Pick the key file'), file), go),
    msg);
}
