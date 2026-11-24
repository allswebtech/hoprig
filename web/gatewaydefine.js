// Settings → Add-ons → "Add a gateway" and a gateway's Remove (src/addons/gatewayroutes.mjs). A gateway of the
// owner's own is a program Hoprig will run: the server checks the definition and answers with the exact program and
// arguments; this page shows them and asks, and only then is it sent again with `confirmed: true`. The question is
// asked in the form's own sheet (Back brings the form back as it was typed), so nothing typed is lost and an error
// after the yes is shown where the form is. The same question for Remove (it names the providers that start it), and
// for Confirm the program (its program changed since the owner confirmed it: the file as it is now, its fingerprint).
import { COMMAND } from './brand.js';
import { api, fill, h, link, openSheet, toast } from './lib.js';
import { errorBox, field } from './shell.js';

const busy = (text) => h('div.empty.compact', h('div.spinner', { 'aria-hidden': 'true' }), h('p', text));

/**
 * The server's lines about what Hoprig will run, as blocks: the indented lines (the program and its arguments) as
 * code, the sentences around them as text. → [{ code, text }]
 */
export function runsBlocks(runs) {
  const blocks = [];
  for (const line of runs || []) {
    const code = line.startsWith('  ');
    const last = blocks[blocks.length - 1];
    if (last && last.code && code) last.text += `\n${line.slice(2)}`;
    else blocks.push({ code, text: code ? line.slice(2) : line });
  }
  return blocks;
}

/** What the question shows: what it is, and exactly what Hoprig will run. */
const questionText = (text, runs) => [
  h('p.sheet-text', text),
  ...runsBlocks(runs).map((b) => (b.code ? h('pre.output.gw-runs', b.text) : h('p.sheet-text', b.text))),
];

/** The question before Hoprig removes a gateway, in a sheet of its own. → true when the owner says so. */
function runQuestion({ title, text, runs, ok, danger = false }) {
  return openSheet({ title }, (close) => [
    ...questionText(text, runs),
    h('div.sheet-actions',
      h('button.btn.secondary', { type: 'button', onclick: () => close(false) }, 'Cancel'),
      h(`button.btn.${danger ? 'danger' : 'primary'}`, { type: 'button', onclick: () => close(true) }, ok)),
  ]).then((v) => v === true);
}

/**
 * The short name made from a name: "Relé" → "rele", "2nd Relay" → "g-2nd-relay" (a short name starts with a letter,
 * so a leading digit gets one in front instead of being dropped).
 */
export function shortNameOf(title) {
  const s = String(title).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (/^[0-9]/.test(s) ? `g-${s}` : s).slice(0, 31).replace(/-+$/, '');
}

/** The form's label of each part of a definition, as the server names it in an error's `field`. */
export const FIELD_LABELS = { title: 'Name', id: 'Short name', bin: 'Program', port: 'Port', args: 'Arguments', dashboard: 'Its own page', npm: 'npm package', firstPassword: 'Its first password\'s line' };

/** The definition the form describes (the server checks every part of it). */
function definitionOf(f) {
  const d = { id: f.id.value.trim(), title: f.title.value.trim(), port: /^\d{1,5}$/.test(f.port.value.trim()) ? Number(f.port.value.trim()) : f.port.value.trim() };
  const npm = f.npm.value.trim();
  if (npm) d.npm = npm;
  if (f.bin.value.trim()) d.bin = f.bin.value.trim();
  const args = f.args.value.trim();
  if (args && args !== '--port PORT') d.args = args.split(/\s+/);
  if (f.dashboard.value.trim()) d.dashboard = f.dashboard.value.trim();
  if (f.firstPassword.value.trim()) d.firstPassword = f.firstPassword.value.trim();
  return d;
}

/** Add a gateway of the owner's own. `done()` draws the list again (and puts the focus back on the page). */
export function defineGatewaySheet(done) {
  return openSheet({ title: 'Add a gateway', subtitle: 'A program on this computer that offers other AI providers through Claude\'s API' }, (close) => {
    const input = (tag, attrs) => h(tag, { autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', ...attrs });
    const f = {
      title: input('input.field', { placeholder: 'Relay', maxlength: 40, autofocus: true }),
      id: input('input.field.mono', { placeholder: 'relay', maxlength: 31 }),
      bin: input('input.field.mono', { placeholder: '/opt/relay/bin/relay' }),
      port: input('input.field.mono', { inputmode: 'numeric', placeholder: '20100', maxlength: 5 }),
      args: input('input.field.mono', { value: '--port PORT' }),
      dashboard: input('input.field.mono', { placeholder: '/' }),
      npm: input('input.field.mono', { placeholder: 'relay-gateway' }),
      firstPassword: input('input.field', { placeholder: 'password', maxlength: 60 }),
    };
    // The short name follows the name until it is typed itself, and again once it is emptied.
    let idTyped = false;
    f.id.addEventListener('input', () => (idTyped = f.id.value !== ''));
    f.title.addEventListener('input', () => {
      if (!idTyped) f.id.value = shortNameOf(f.title.value);
    });
    const out = h('div');
    // An error about one part is written under that part, with the form's own label, and the part is marked.
    const errs = Object.fromEntries(Object.keys(FIELD_LABELS).map((k) => [k, h('p.form-error', { id: `gw-err-${k}`, hidden: true })]));
    const clearErrors = () => {
      for (const [k, el] of Object.entries(errs)) {
        el.hidden = true;
        el.textContent = '';
        f[k].removeAttribute('aria-invalid');
        f[k].removeAttribute('aria-describedby');
      }
    };
    const showError = (e) => {
      const k = e.data && e.data.field;
      if (!k || !errs[k]) return false;
      errs[k].textContent = `${FIELD_LABELS[k]}: ${e.data.hint || e.message}`;
      errs[k].hidden = false;
      f[k].setAttribute('aria-invalid', 'true');
      f[k].setAttribute('aria-describedby', `gw-err-${k}`);
      if (k === 'dashboard' || k === 'npm') more.open = true;
      f[k].focus();
      return true;
    };
    const go = h('button.btn.primary', { type: 'button' }, 'Check');
    // The question takes the form's place in the same sheet; Back shows the form again, as it was typed.
    const ask = h('div.wizard.gw-ask', { hidden: true });
    const showForm = (focusOn = go) => {
      ask.hidden = true;
      fill(ask);
      form.hidden = false;
      go.disabled = false;
      focusOn.focus();
    };
    function question(definition, r) {
      const head = h('h3.gw-ask-title', { tabindex: -1 }, `Let Hoprig run ${definition.title}?`);
      const yes = h('button.btn.primary', { type: 'button' }, 'Add gateway');
      yes.addEventListener('click', async () => {
        yes.disabled = true;
        try {
          await api('/api/gateways/defined/add', { definition, confirmed: true, pin: r.pin });
        } catch (e) {
          // Said at once, the list drawn again (another tab may have added it), and the form back with the reason.
          toast(e, { kind: 'error' });
          done();
          showForm();
          fill(out, showError(e) ? null : errorBox(e));
          return;
        }
        toast(`${definition.title} added`);
        close(true);
        done();
      });
      fill(ask, head, ...questionText(r.confirm, r.runs),
        h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => showForm() }, 'Back'), yes));
      form.hidden = true;
      ask.hidden = false;
      head.focus();
    }
    go.addEventListener('click', async () => {
      go.disabled = true;
      clearErrors();
      fill(out, busy('Checking it on the computer…'));
      const definition = definitionOf(f);
      try {
        const r = await api('/api/gateways/defined/add', { definition });
        fill(out);
        question(definition, r);
      } catch (e) {
        fill(out, showError(e) ? null : errorBox(e));
        go.disabled = false;
      }
    });
    const row = (k, hint) => h('div', field(FIELD_LABELS[k], f[k], hint), errs[k]);
    const more = h('details.adv', h('summary', 'More'),
      row('dashboard', 'The path of its page on that port, such as /. Leave it empty when it has none.'),
      row('npm', 'Only for a gateway installed with npm: Hoprig installs and updates it, and Program is then the name it installs.'),
      row('firstPassword', 'A word on the line where it prints its first password, such as password. That line is shown to you once when it starts and kept out of its log. Empty: its log is as it prints it.'));
    const form = h('div.wizard',
      h('p.sheet-text', 'Hoprig starts it when a session on its provider needs it, and stops it when you say. Then add your providers in it, and make it a provider here: ', h('a', { href: link('#/providers'), onclick: () => close() }, 'Providers → Add provider'), '.'),
      row('title', 'How the pages call it.'),
      row('id', `Lower-case letters, digits and -. Used in commands: ${COMMAND} addons start <short name>.`),
      row('bin', 'Its full path, or a name found on the computer\'s PATH.'),
      row('port', 'Where it offers Claude\'s API on this computer, from 1024 to 65535.'),
      row('args', 'How it is told the port: PORT stands for it. Letters, digits and . _ = : , @ / + - only.'),
      more,
      out,
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Cancel'), go));
    return [form, ask];
  });
}

/** Remove a gateway of the owner's own, after the question (which providers start it). */
export async function removeGateway(a, done) {
  try {
    const r = await api('/api/gateways/defined/remove', { id: a.id });
    if (!(await runQuestion({ title: `Remove ${a.title}?`, text: r.confirm, runs: null, ok: 'Remove', danger: true }))) return;
    await api('/api/gateways/defined/remove', { id: a.id, confirmed: true });
    toast(`${a.title} removed`);
  } catch (e) {
    toast(e, { kind: 'error' });
  }
  done();
}

/**
 * Confirm the program of a gateway of the owner's own as it is now (he updated it), after the question that shows the
 * file and its fingerprint; its sharing and other computers' keys stay.
 */
export async function confirmGatewayProgram(a, done) {
  try {
    const r = await api('/api/gateways/defined/confirm', { id: a.id });
    if (r.already) toast(`The program of ${a.title} is the one you confirmed`);
    else {
      if (!(await runQuestion({ title: `Confirm the program of ${a.title}?`, text: r.confirm, runs: r.runs, ok: 'Confirm' }))) return;
      await api('/api/gateways/defined/confirm', { id: a.id, confirmed: true, pin: r.pin });
      toast(`${a.title}: program confirmed`);
    }
  } catch (e) {
    toast(e, { kind: 'error' });
  }
  done();
}

/** Why a gateway of the owner's own is not started until he confirms its program (status `needsConfirm`), or null. */
export const needsConfirmText = (a) => (a.needsConfirm === 'changed'
  ? 'Its program changed since you confirmed it, so it is not started. If you changed it yourself (an update), confirm the new program.'
  : a.needsConfirm === 'no-fingerprint'
  ? 'config.json keeps no fingerprint of its program, so it is not started. If the program is yours, confirm it.'
  : a.needsConfirm === 'gone'
  ? 'Its program is not where you confirmed it any more (an update may have moved it), so it is not started. Confirm the program it is now: you are shown the file first.'
  : a.needsConfirm === 'gone-old'
  ? 'Its program is not where you confirmed it any more, so it is not started. This gateway was added before Hoprig kept the program as you named it: name the program it is now.'
  : null);

/** The line of a gateway of the owner's own: what it runs. */
export const runsLine = (a) => (Array.isArray(a.command) ? h('p.hint.gw-command', h('span', 'Runs'), h('code', a.command.join(' '))) : null);
