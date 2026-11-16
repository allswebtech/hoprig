// Linking computers that cannot reach each other (a computer at home behind a router): the other computer connects
// out to the main one and stays connected (src/machines/link.mjs). On the main one: the one line to paste (its
// address from anywhere and a one-time code, src/machines/joinline.mjs). On the other one: "Link to my main", one
// paste field, and once it is linked, to which computer, whether it is connected, and Leave. Part of Computers.
import { APP_NAME, COMMAND } from './brand.js';
import { icon } from './icons.js';
import { api, btn, confirmSheet, copyText, fill, h, link, openSheet, toast } from './lib.js';
import { errorBox, field, okBox, panel, steps } from './shell.js';
import { store } from './store.js';

export const busy = (text) => h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', text));
export const cmdLine = (cmd) => h('div.cmdline', h('code', cmd), btn('icon ghost', { icon: 'copy', title: 'Copy', onclick: async () => toast((await copyText(cmd)) ? 'Copied' : 'Select and copy it by hand') }));
const since = (t) => (t ? `connected since ${new Date(t).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : 'connected');

/** The computers this one is linked to (GET ~/api/joins), each with its state and Leave; `changed()` after a Leave. */
function joinRows(joined, changed) {
  return h('div.rows.cp-tap', joined.map((j) => h('div.row.static',
    h('span.row-icon', icon('cpu')),
    h('span.row-main',
      h('span.row-title', j.hub),
      h('span.row-sub', `${j.via === 'link' ? 'Direct link' : 'SSH'} · ${j.state === 'up' ? `${since(j.upSince)} · shown there as "${j.name}"` : j.state === 'starting' ? 'Connecting…' : `Reconnecting…${j.error ? ` (${j.error})` : ''}`}`)),
    h(`span.pill.ms-${j.state === 'up' ? 'ok' : 'off'}`, h('span.dot'), j.state === 'up' ? 'Connected' : 'Reconnecting'),
    btn('small ghost', { icon: 'trash', label: 'Leave', onclick: async () => {
      if (!(await confirmSheet({ title: `Leave ${j.hub}?`, text: `${j.hub} stops showing this computer and can no longer reach it.`, ok: 'Leave', danger: true }))) return;
      try {
        await api(`~/api/joins/${j.id}/leave`, {});
        toast(`Left ${j.hub}`);
        changed();
      } catch (e) {
        toast(e.message, { kind: 'error' });
      }
    } }))));
}

/**
 * Computers, while the list holds only this computer: linked to a main one already (to which, connected or not, Leave),
 * or the button that links it. `joined`: GET ~/api/joins's list; `changed()` after a Leave or a new link.
 */
export function mainLinkCard(joined, changed) {
  if (joined.length) {
    return panel({ icon: 'swap', title: `Linked to your main ${APP_NAME}`, desc: 'That computer shows this one and its sessions. Leave ends it.' }, joinRows(joined, changed));
  }
  return panel({ icon: 'swap', title: `Is your main ${APP_NAME} on another computer?`, desc: 'Link this one to it: the main one then shows this computer and its sessions. Nothing to open on any router.' },
    h('div.savebar.start.cp-tap', btn('secondary', { icon: 'swap', label: `Link to my main ${APP_NAME}`, onclick: async () => {
      if (await linkToMainSheet()) changed();
    } })));
}

// ---- (b) it connects by itself: a one-time code to type there (link.mjs) ----
export function byCode(isAlive) {
  const box = h('div', { role: 'status' });
  let timer = null;
  const loopback = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const plainHttp = () => location.protocol === 'http:' && !loopback();
  async function show() {
    clearTimeout(timer);
    fill(box, busy('Making a code…'));
    let c;
    try {
      c = await api('~/api/links/code', {});
    } catch (e) {
      return fill(box, errorBox(e.message), h('p.hint', 'Try again in a moment.'));
    }
    // The server makes the line from how this computer is reached from anywhere (reach.mjs): the address with the
    // code (and a fingerprint for a hub with its own certificate). With none, the public link is the way to get one.
    const cmd = c.command || `${COMMAND} join ${location.origin} ${c.code}${plainHttp() ? ' --insecure' : ''}`;
    const until = new Date(c.expires).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const waiting = h('p.cp-wait', h('span.spinner.small', { 'aria-hidden': 'true' }), h('span', 'Waiting for the other computer…'));
    fill(box,
      c.line
        ? steps(
          [h('strong', `On the other computer, open its ${APP_NAME}: Computers → Link to my main ${APP_NAME}, and paste this line:`), cmdLine(c.line), c.note ? h('span.hint', c.note) : null,
            h('span.hint', 'Or there in a terminal:'), cmdLine(cmd)],
          [h('strong', 'Wait here.'), h('span.hint', `This page shows when it is connected. The line works once, until ${until}.`)])
        // No address from anywhere. This page's own address helps only when another computer can reach it: never a
        // loopback one (127.0.0.1 is the other computer itself there).
        : loopback()
          ? [h('p.banner.info', icon('info', { size: 18 }), h('span', 'The other computer needs an address of this one that it can reach. ', h('a', { href: link('#/settings/public-link') }, 'Turn on the public link'), ', then show the line again here.'))]
          : [h('div.bigcode', { 'aria-label': `Code ${c.code.split('').join(' ')}` }, c.code),
            h('p.banner.info', icon('info', { size: 18 }), h('span', 'The other computer needs an address of this one that it can reach. ', h('a', { href: link('#/settings/public-link') }, 'Turn on the public link'), ' and show a new line; or, on the same network, type this there:')),
            cmdLine(cmd)],
      c.via === 'temporary' ? h('p.banner.warn', icon('alert', { size: 18 }), h('span', 'This computer\'s public link is Temporary: its address changes whenever Hoprig or this computer restarts (an update too), and then the other computer must be linked again. Use Custom, or a server as the main one, to keep computers linked.')) : null,
      plainHttp() && !c.line ? h('p.banner.warn', icon('lock', { size: 18 }), h('span', 'This page is not encrypted (http://). What the other computer sends, and everything typed into its sessions, would cross the network readable on the way. Use the public link, or this only on a network you trust.')) : null,
      c.line || !loopback() ? waiting : null);
    if (!c.line && loopback()) return; // nothing to wait for: no line was shown
    const poll = async () => {
      if (!isAlive()) return;
      try {
        const st = await api(`~/api/links/code?id=${c.id}`);
        if (st.status === 'claimed') {
          store.refresh();
          return fill(box, okBox(`${st.by} is connected. Its sessions show on Home and in the list of computers.`), h('div.savebar.start', h('a.btn.primary', { href: '#/computers' }, 'All computers')));
        }
        if (st.status === 'expired') return fill(box, errorBox('The code expired before the other computer used it.'), h('div.savebar.start', btn('primary', { icon: 'refresh', label: 'Show a new code', onclick: show })));
      } catch {
        /* try again */
      }
      timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
  }
  fill(box, h('div.savebar.start.cp-tap', btn('primary', { icon: 'key', label: 'Show the line to paste', onclick: show })));
  return h('section.card.panel', h('p.hint', 'The other computer connects out to this one: only this dashboard\'s address has to be reachable, nothing is opened on the other one.'), box);
}

/**
 * The one paste field of "Link to my main Hoprig": the line the main one shows (address#join=CODE, or its whole
 * `hoprig join …` command), split by the server (joinline.mjs). Plain http to another computer is said and asked for.
 * `done(joined)` runs once it is linked.
 */
function pasteForm(done, { autofocus = false } = {}) {
  const lineIn = h('textarea.field.mono', { rows: 2, placeholder: 'https://pc.example.com#join=K7QM-4XP2', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: 2048, 'aria-label': 'The line from your main computer', autofocus });
  // One line: Enter links (a textarea only so that a long line wraps where it can be read).
  lineIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      lineIn.form.requestSubmit();
    }
  });
  const insecure = h('input', { type: 'checkbox' });
  const insecureRow = h('label.toggle-line.hidden', insecure, h('span', 'Connect without encryption. The token and everything typed into this computer\'s sessions would cross the network readable on the way; only on a network you trust.'));
  lineIn.addEventListener('input', () => {
    let plain = false;
    try {
      const u = new URL(lineIn.value.trim().split(/[\s#]/)[0]);
      plain = u.protocol === 'http:' && !/^(127\.|localhost$|\[::1\]$)/.test(u.hostname);
    } catch {
      /* not a full address yet */
    }
    insecureRow.classList.toggle('hidden', !plain);
  });
  const msg = h('div', { role: 'status' });
  const go = h('button.btn.primary', { type: 'submit' }, icon('swap', { size: 18 }), h('span', 'Link'));
  async function submit() {
    if (!lineIn.value.trim()) return fill(msg, h('p.form-error', `Paste the line your main ${APP_NAME} shows.`));
    go.disabled = true;
    fill(msg, busy('Linking…'));
    try {
      const r = await api('~/api/joins', { line: lineIn.value.trim(), insecure: insecure.checked });
      lineIn.value = '';
      insecure.checked = false;
      insecureRow.classList.add('hidden');
      fill(msg);
      toast(`${r.joined.hub} now shows this computer`);
      done(r.joined);
    } catch (e) {
      fill(msg, h('p.form-error', e.message));
    }
    go.disabled = false;
  }
  return h('form.stack', { onsubmit: (e) => { e.preventDefault(); submit(); } },
    field('The line from your main computer', lineIn, `On the main one: Settings → Public link → Link another computer, or Computers → Add a computer → "It is at home or behind a router". It works once, for 10 minutes.`),
    insecureRow,
    h('div.savebar.cp-tap', go),
    msg);
}

/** Computers → "Link to my main Hoprig": the paste field in a sheet. */
export function linkToMainSheet() {
  return openSheet({ title: `Link to my main ${APP_NAME}` }, (close) => [
    h('p.sheet-text', `This computer connects out to your main ${APP_NAME} and stays connected, also after a restart. The main one can then see and drive this computer; this one gets no access to it.`),
    pasteForm(() => {
      store.refresh();
      close(true);
    }, { autofocus: true }),
    h('p.hint', 'When the main one\'s public link is Temporary, the link ends when its address changes (whenever Hoprig or that computer restarts), and this computer must be linked again. To stay linked, the main one needs Custom, or is a server.'),
  ]);
}

/**
 * Add a computer → Advanced → "Show this computer on another dashboard" (hoprig join): for a computer the other one
 * cannot reach, such as a computer at home behind a router. It connects out and stays connected; Leave undoes it. The
 * pasted line first; SSH as the alternative.
 */
export function joinOther({ isAlive }) {
  const list = h('div');
  const input = h('input.field', { placeholder: 'user@server, or a name from ~/.ssh/config', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'SSH address of the other dashboard\'s computer' });
  const msg = h('div', { role: 'status' });
  let timer = null;
  async function paint() {
    clearTimeout(timer);
    let d;
    try {
      d = await api('~/api/joins');
    } catch (e) {
      return fill(list, h('p.form-error', e.message));
    }
    if (!isAlive()) return;
    fill(list, d.joined.length ? joinRows(d.joined, paint) : null);
    // Keep the state fresh while the section is open (a dropped connection comes back by itself).
    if (d.joined.length) timer = setTimeout(paint, 5000);
  }
  async function connect() {
    const target = input.value.trim();
    if (!target) return fill(msg, h('p.form-error', 'Type the SSH address of the computer whose dashboard should show this one.'));
    fill(msg, h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', `Connecting to ${target} by SSH…`)));
    try {
      const r = await api('~/api/joins', { target });
      input.value = '';
      fill(msg);
      toast(`${r.joined.hub} now shows this computer`);
      paint();
    } catch (e) {
      fill(msg, h('p.form-error', e.message));
    }
  }
  paint();
  return [
    list,
    h('p.hint', 'Use this on a computer the other one cannot reach (a computer at home behind a router): it connects out and stays connected, also after a restart. The other dashboard can then see and drive this computer; this one gets no access to it.'),
    pasteForm(() => paint()),
    h('details.more.inner',
      h('summary.more-summary', h('span.more-text', h('strong', 'Connect by SSH instead'), h('span.hint', 'When this computer can log in to the other one by SSH')), icon('chevronDown', { size: 18 })),
      h('form.inlineform', { onsubmit: (e) => { e.preventDefault(); connect(); } }, input, h('button.btn.primary', { type: 'submit' }, icon('plus', { size: 18 }), h('span', 'Connect'))),
      msg),
  ];
}

