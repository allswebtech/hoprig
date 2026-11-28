// Computers → Add a computer: what the page shows when "Install it there for me" finds that the SSH login there is
// root (the hub answers 409 `root-login`, src/machines/hub.mjs). Nothing was installed. It says so in the hub's words
// (why), and offers first to make an ordinary user there and set Hoprig up as it (one confirmation that names the
// server; install.sh --yes as root), then the other ways: an ordinary login with sudo, or keep Hoprig on root there on
// purpose by typing the sentence, which installs it with --stay-root.
import { confirmSheet, h } from './lib.js';
import { field } from './shell.js';
import { icon } from './icons.js';

export const STAY_ROOT_SENTENCE = 'keep Hoprig on root';

/** The rule of a user name (USER_NAME_RE in src/setup/rootfacts.mjs). */
const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * The box for a root login: `message` is the hub's answer; `retry({ sentence })` installs with the sentence typed;
 * `error` is the answer to a sentence that was not the one (shown under the field). `makeUser({ name, noAdmin })` installs with the
 * work user made there, after a confirmation that names `server`.
 */
export function rootLoginBox(message, retry, error = null, { server = 'this server', makeUser = null } = {}) {
  const typed = h('input.field', { type: 'text', autocomplete: 'off', spellcheck: false });
  const go = h('button.btn.secondary', { type: 'button' }, 'Install on root on purpose');
  go.addEventListener('click', () => {
    go.disabled = true;
    retry({ sentence: typed.value });
  });
  const make = makeUser ? h('button.btn.primary', { type: 'button' }, `Make the user and set Hoprig up on ${server}`) : null;
  // His two choices, on the same screen: the user's name (hoprig unless he types another; a taken name is said by the
  // installer with a free one) and whether it gets administrator rights.
  const name = h('input.field', { type: 'text', value: 'hoprig', autocomplete: 'off', spellcheck: false, 'aria-label': 'The name of the user' });
  const admin = h('select.field', { 'aria-label': 'Administrator rights for the user' },
    h('option', { value: 'sudo' }, 'sudo without a password, as cloud servers give their first user'),
    h('option', { value: 'none' }, 'no administrator rights'));
  const nameError = h('p.form-error', { role: 'alert' });
  if (make) make.addEventListener('click', async () => {
    const n = String(name.value || '').trim();
    if (!USER_NAME.test(n)) {
      nameError.textContent = 'A user name is small letters, digits, - and _, starting with a letter or _ (at most 32).';
      return;
    }
    nameError.textContent = '';
    const noAdmin = admin.value === 'none';
    const yes = await confirmSheet({
      title: `Make an ordinary user on ${server}?`,
      text: `On ${server}, as root: make the user ${n} (no password), give it the SSH key you use for root, ${noAdmin ? 'give it no administrator rights' : 'give it sudo without a password through one file in /etc/sudoers.d'}, keep its services running, then install Hoprig as ${n}. Root's own login is not changed. The installer's lines show here.`,
      ok: `Make it on ${server}`,
    });
    if (yes) {
      make.disabled = true;
      makeUser({ name: n, noAdmin });
    }
  });
  return h('div.result.root-login',
    h('div.banner.warn', { role: 'alert' }, icon('alert', { size: 18 }), h('span', message)),
    make ? h('label.field-row', h('span.field-label', 'The name of the user'), name) : null,
    make ? h('label.field-row', h('span.field-label', 'Administrator rights'), admin) : null,
    make ? nameError : null,
    make ? h('div.savebar.start', make) : null,
    field(`Only if this server must work as root: type "${STAY_ROOT_SENTENCE}"`, typed, 'Bypass permissions mode stays unavailable there, and its doctor and Health then show root as information only.'),
    error ? h('p.form-error', { role: 'alert' }, error) : null,
    h('div.savebar.start', go));
}
