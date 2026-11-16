// Computers (#/computers): one list of every computer whose sessions this dashboard shows, each leading to its own
// page (pc.js), where it is renamed, tested and removed. "Add a computer" (#/computers/add) asks where the other
// computer is and shows the steps for that case: by SSH, a computer that connects by itself (at home, behind a
// router), or by its address and a pairing code. Its Advanced part holds the rarer things about this computer:
// connecting it to another dashboard, a pairing code for another one, and who may control it. "Sign in another
// device" is part of Settings → Security and sign-in (signIn below). Everything here talks to this dashboard
// ("~/api/...") except what asks one computer (at(m, ...)).
import { APP_NAME, COMMAND } from './brand.js';
import { icon } from './icons.js';
import {
  MACHINE_STATE, add, api, at, btn, confirmSheet, copyText, fill, h, link, openSheet, qrSvg, toast, ago,
} from './lib.js';
import { registerPage } from './registry.js';
import { emptyState, errorBox, field, fold, groupHead, okBox, panel, radioCards, steps } from './shell.js';
import { osName } from './pc.js';
import { store } from './store.js';

const busy = (text) => h('div.inline-busy', h('div.spinner.small', { 'aria-hidden': 'true' }), h('span', text));
const cmdLine = (cmd) => h('div.cmdline', h('code', cmd), btn('icon ghost', { icon: 'copy', title: 'Copy', onclick: async () => toast((await copyText(cmd)) ? 'Copied' : 'Select and copy it by hand') }));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Follow a job's output ("…?from=N" answers { running, lines, next, result }) into `out` until it ends. */
async function follow(path, out, isAlive) {
  let from = 0;
  for (;;) {
    const r = await api(`${path}?from=${from}`);
    if (r.lines.length) add(out, `${r.lines.join('\n')}\n`);
    out.scrollTop = out.scrollHeight;
    from = r.next;
    if (!r.running || !isAlive()) return r.result;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/**
 * One row of the list, from what the session poll knows (`s`: label, state, sessions) and what the list of computers
 * knows (`m`: system, versions; null until it answers). The second line is always there, so nothing moves when it
 * fills in.
 */
export function computerLine(s, m, update) {
  const online = s.status === 'online';
  const state = online ? 'Online' : MACHINE_STATE[s.status] || s.status || 'Offline';
  const first = [state, m && osName(m.platform), online ? plural((s.sessions || []).length, 'session') : null].filter(Boolean).join(' · ');
  const claude = !m ? '…' : m.claude ? `Claude Code ${m.claude}${update ? ` · version ${update} is out` : ''}` : online ? 'Claude Code not installed' : s.error || 'Not answering';
  return { online, first, claude };
}

function computerRow(s, m, update) {
  const l = computerLine(s, m, update);
  return h(`a.row.cp-row${l.online ? '' : '.cp-off'}`, { href: link('#/computer', s.machine) },
    h('span.row-icon', icon('cpu')),
    h('span.row-main',
      h('span.row-title', s.machineLabel, s.machine === null ? h('span.badge.soft', 'This computer') : null),
      h('span.row-sub', h(`span.cp-dot${l.online ? '.on' : ''}`, { 'aria-hidden': 'true' }), l.first),
      h('span.row-sub.cp-claude', l.claude)),
    h('span.row-end', icon('chevronRight', { size: 18 })));
}

// ======================= the list =======================

function viewList(frame) {
  let alive = true;
  const list = h('div.rows', [1, 2].map(() => h('div.row.static.cp-row.cp-ghost', h('span.row-icon', icon('cpu')),
    h('span.row-main', h('span.row-title', ' '), h('span.row-sub', 'Looking at your computers…'), h('span.row-sub', ' ')))));
  const after = h('div');
  const known = new Map(); // computer ('~' for this one) → its entry in /api/machines
  const updates = new Map(); // computer → the newer Claude Code version, when there is one
  const k = (name) => name || '~';
  let failed = null;
  frame({
    title: 'Computers',
    page: 'computers',
    intro: 'Every computer whose sessions you see here. Open one to see how it is doing, set it up or change it.',
    primary: { label: 'Add a computer', icon: 'plus', href: '#/computers/add' },
    body: [list, after],
  });
  const paint = () => {
    if (!alive) return;
    if (failed && !store.all.length) {
      fill(list, h('div.row.static', h('span.row-main', errorBox(`The list could not be read: ${failed.message}`))));
      return fill(after, h('div.savebar.start', btn('secondary', { icon: 'refresh', label: 'Try again', onclick: () => { failed = null; load(); store.refresh(); } })));
    }
    if (!store.all.length) return;
    fill(list, store.all.map((s) => computerRow(s, known.get(k(s.machine)) || null, updates.get(k(s.machine)))));
    // Only this one: it may be the main one (add others) or not (link it to the main one, which then shows it).
    fill(after, store.all.length === 1
      ? [emptyState('cpu', 'Only this computer so far. Add another one to see its sessions here too, and to look after it from here.'),
        panel({ icon: 'swap', title: `Is your main ${APP_NAME} on another computer?`, desc: 'Link this one to it: the main one then shows this computer and its sessions. Nothing to open on any router.' },
          h('div.savebar.start', btn('secondary', { icon: 'swap', label: `Link to my main ${APP_NAME}`, onclick: linkToMainSheet })))]
      : null);
  };
  async function load() {
    try {
      const d = await api('~/api/machines');
      known.set('~', { platform: d.self.platform, claude: d.self.claude, version: d.self.version });
      for (const m of d.machines) known.set(k(m.name), m);
      failed = null;
      // Which ones have a newer Claude Code: asked of each online computer, in parallel.
      for (const m of [{ name: null, state: 'online' }, ...d.machines]) {
        if (m.state !== 'online') continue;
        api(at(m.name, '/api/claude')).then((c) => {
          if (c.updateAvailable) {
            updates.set(k(m.name), c.latest);
            paint();
          }
        }).catch(() => {});
      }
    } catch (e) {
      failed = e;
    }
    paint();
  }
  const unsubscribe = store.subscribe(paint);
  load();
  return () => {
    alive = false;
    unsubscribe();
  };
}

// ======================= Add a computer =======================

const WAYS = [
  { value: 'ssh', title: 'I can reach it by SSH from this computer', sub: 'The easiest way: nothing to open in a firewall. This computer logs in to it with an SSH key.' },
  { value: 'join', title: 'It is at home or behind a router and cannot be reached from here', sub: 'It connects out to this dashboard by itself. You paste one line there.' },
  { value: 'url', title: 'It has an address (the same network, or its public link)', sub: `Its own ${APP_NAME} dashboard can be opened from here. You enter its address and a pairing code.` },
];

function viewAdd(frame) {
  let alive = true;
  const isAlive = () => alive;
  let way = null;
  const choice = h('div');
  const how = h('div.cp-how');
  const paintChoice = () => fill(choice, radioCards('add-way', WAYS, way, (v) => {
    way = v;
    paintChoice();
    paintHow();
  }));
  const paintHow = () => fill(how, way === 'ssh' ? bySsh(isAlive) : way === 'join' ? byCode(isAlive) : way === 'url' ? byAddress() : null);
  paintChoice();
  frame({
    title: 'Add a computer',
    page: 'computers',
    back: '#/computers',
    backLabel: 'Computers',
    intro: 'Show another computer\'s sessions here and look after it from this page. It needs ' + APP_NAME + ' installed there.',
    body: [
      groupHead('Where is the other computer?'),
      choice, how,
      fold('computers-add', 'Advanced',
        panel({ icon: 'swap', title: 'Show this computer on another dashboard', desc: 'The other way round: this computer connects out to a dashboard on another computer, such as a server.' }, ...joinOther({ isAlive })),
        panel({ icon: 'key', title: 'Let another computer add this one', desc: 'Shows a pairing code to type on the other computer\'s page. Adding by SSH there needs no code.' }, ...pairCode({ isAlive })),
        panel({ icon: 'lock', title: 'Who may control this computer', desc: 'Other computers\' dashboards that can see and drive the sessions here. They cannot change the password or this list.' }, ...tokens({ isAlive }))),
    ],
  });
  return () => {
    alive = false;
  };
}

/** The result of an add that worked: what was added, where to go next. */
function added(m, hint) {
  store.refresh();
  toast(`${m.label} added`);
  return [
    okBox(`${m.label} is added. Its sessions show on Home and in the list of computers.`),
    hint ? h('p.banner.info', icon('info', { size: 18 }), h('span', hint)) : null,
    h('div.savebar.start', h('a.btn.primary', { href: link('#/computer', m.name) }, `Open ${m.label}`), h('a.btn.ghost', { href: '#/computers' }, 'All computers')),
  ];
}

// ---- (a) by SSH ----
function bySsh(isAlive) {
  const input = h('input.field', { placeholder: 'user@host, or a name from ~/.ssh/config', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'SSH address' });
  const msg = h('div', { role: 'status' });
  const go = h('button.btn.primary', { type: 'submit' }, icon('plus', { size: 18 }), h('span', 'Add'));

  async function install(target) {
    const out = h('pre.output', { 'aria-live': 'polite' });
    fill(msg, busy(`Installing ${APP_NAME} on ${target}… this can take a few minutes.`), out);
    try {
      await api('~/api/machines/install', { target });
      const r = await follow('~/api/machines/install', out, isAlive);
      if (r && r.ok) return addIt(target);
      add(msg, errorBox('The installer did not finish: see its output above. Fix what it says, then press Add again.'));
    } catch (e) {
      add(msg, errorBox(e.message));
    }
  }

  async function addIt(value) {
    const target = (value ?? input.value).trim();
    if (!target) return fill(msg, errorBox('Type the SSH address of the other computer, such as me@laptop.'));
    go.disabled = true;
    fill(msg, busy(`Connecting to ${target} by SSH…`));
    try {
      const r = await api('~/api/machines/ssh', { target });
      input.value = '';
      fill(msg, added(r.machine, r.hint));
    } catch (e) {
      if (e.code === 'not-installed' || (e.data && e.data.installCommand)) {
        const cmd = e.data.installCommand;
        fill(msg,
          errorBox(e.message),
          h('p.hint', e.data.canInstall ? 'Let this page install it there, or type this line there yourself (it needs Node.js 20 or newer), then press Add again:' : 'Type this line there (it needs Node.js 20 or newer), then press Add again:'),
          cmdLine(cmd),
          e.data.canInstall ? h('div.savebar.start', btn('primary', { icon: 'download', label: 'Install it there for me', onclick: () => install(target) })) : null);
      } else {
        fill(msg, errorBox(e.message), h('p.hint', `Next: check that "ssh ${target}" works from this computer without a password (ssh-copy-id ${target} sets that up), then press Add again.`));
      }
    }
    go.disabled = false;
  }

  return h('section.card.panel',
    steps(
      [h('strong', 'Make sure this computer can log in there with an SSH key.'), h('span.hint', `If "ssh user@host" asks for a password, run once on this computer: ssh-copy-id user@host. ${APP_NAME} must be installed there too; this page offers to do it.`)],
      [h('strong', 'Type its SSH address and press Add.'),
        h('form.inlineform', { onsubmit: (e) => { e.preventDefault(); addIt(); } }, input, go)]),
    msg);
}

// ---- (b) it connects by itself: a one-time code to type there (link.mjs) ----
function byCode(isAlive) {
  const box = h('div', { role: 'status' });
  let timer = null;
  const plainHttp = () => location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
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
        : [h('div.bigcode', { 'aria-label': `Code ${c.code.split('').join(' ')}` }, c.code),
          h('p.banner.info', icon('info', { size: 18 }), h('span', 'The other computer needs an address of this one that it can reach. ', h('a', { href: link('#/settings/public-link') }, 'Turn on the public link'), ' and show a new code; or, on the same network, type this there:')),
          cmdLine(cmd)],
      c.via === 'temporary' ? h('p.banner.warn', icon('alert', { size: 18 }), h('span', 'This computer\'s public link is Temporary: when its address changes (after a restart), the other computer must be linked again. Use Custom, or a server as the main one, to keep computers linked.')) : null,
      plainHttp() && !c.line ? h('p.banner.warn', icon('lock', { size: 18 }), h('span', 'This page is not encrypted (http://). What the other computer sends, and everything typed into its sessions, would cross the network readable on the way. Use the public link, or this only on a network you trust.')) : null,
      waiting);
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
  fill(box, h('div.savebar.start', btn('primary', { icon: 'key', label: 'Show the line to paste', onclick: show })));
  return h('section.card.panel', h('p.hint', 'The other computer connects out to this one: only this dashboard\'s address has to be reachable, nothing is opened on the other one.'), box);
}

// ---- (c) by its address and a pairing code ----
function byAddress() {
  const urlInput = h('input.field', { type: 'url', placeholder: 'https://laptop.example.com or http://192.168.1.20:7433', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const codeInput = h('input.field.mono', { placeholder: 'K7QM-4XP2', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: 12 });
  const msg = h('div', { role: 'status' });
  const go = h('button.btn.primary', { type: 'submit' }, 'Pair');
  async function pair() {
    if (!urlInput.value.trim() || !codeInput.value.trim()) return fill(msg, errorBox('Type both: its address and the pairing code shown there.'));
    go.disabled = true;
    fill(msg, busy('Pairing…'));
    try {
      const r = await api('~/api/machines/url', { url: urlInput.value.trim(), code: codeInput.value.trim() });
      urlInput.value = codeInput.value = '';
      fill(msg, added(r.machine, r.hint));
    } catch (e) {
      fill(msg, errorBox(e.message), h('p.hint', 'Next: check that the address opens in a browser on this computer, and that the code is fresh (it works once, for 10 minutes). Then press Pair again.'));
    }
    go.disabled = false;
  }
  return h('section.card.panel',
    h('form.stack', { onsubmit: (e) => { e.preventDefault(); pair(); } },
      steps(
        [h('strong', 'On the other computer, show a pairing code.'), h('span.hint', `Run "${COMMAND} pair" there, or open its dashboard: Computers → Add a computer → Advanced → Let another computer add this one.`)],
        [field('Its dashboard address', urlInput), field('Pairing code', codeInput, 'A code works once, for 10 minutes.')],
        [h('strong', 'Press Pair.'), h('div.savebar.start', go)]),
      msg));
}

/**
 * The one paste field of "Link to my main Hoprig": the line the main one shows (address#join=CODE, or its whole
 * `hoprig join …` command), split by the server (joinline.mjs). Plain http to another computer is said and asked for.
 * `done(joined)` runs once it is linked.
 */
function pasteForm(done) {
  const lineIn = h('textarea.field.mono', { rows: 2, placeholder: 'https://pc.example.com#join=K7QM-4XP2', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: 2048, 'aria-label': 'The line from your main computer' });
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
    h('div.savebar', go),
    msg);
}

/** Computers → "Link to my main Hoprig": the paste field in a sheet. */
function linkToMainSheet() {
  return openSheet({ title: `Link to my main ${APP_NAME}` }, (close) => [
    h('p.sheet-text', `This computer connects out to your main ${APP_NAME} and stays connected, also after a restart. The main one can then see and drive this computer; this one gets no access to it.`),
    pasteForm(() => {
      store.refresh();
      close(true);
    }),
  ]);
}

/**
 * Add a computer → Advanced → "Show this computer on another dashboard" (hoprig join): for a computer the other one
 * cannot reach, such as a computer at home behind a router. It connects out and stays connected; Leave undoes it. The
 * pasted line first; SSH as the alternative.
 */
function joinOther({ isAlive }) {
  const list = h('div');
  const input = h('input.field', { placeholder: 'user@server, or a name from ~/.ssh/config', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'SSH address of the other dashboard\'s computer' });
  const msg = h('div', { role: 'status' });
  let timer = null;
  const since = (t) => (t ? `connected since ${new Date(t).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : 'connected');
  async function paint() {
    clearTimeout(timer);
    let d;
    try {
      d = await api('~/api/joins');
    } catch (e) {
      return fill(list, h('p.form-error', e.message));
    }
    if (!isAlive()) return;
    fill(list, d.joined.length
      ? h('div.rows', d.joined.map((j) => h('div.row.static',
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
            paint();
          } catch (e) {
            toast(e.message, { kind: 'error' });
          }
        } }))))
      : null);
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

/** Add a computer → Advanced → "Let another computer add this one": a one-time pairing code. */
function pairCode({ isAlive }) {
  const box = h('div');
  let timer = null;
  async function show() {
    clearTimeout(timer);
    let c;
    try {
      c = await api('~/api/pair/code', {});
    } catch (e) {
      return fill(box, h('p.form-error', e.message));
    }
    fill(box,
      h('div.bigcode', { 'aria-label': `Pairing code ${c.code.split('').join(' ')}` }, c.code),
      h('p.hint', `On the other computer: Computers → Add a computer → "It has an address". Enter this computer's address and the code. It works once, until ${new Date(c.expires).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`));
    const poll = async () => {
      if (!isAlive()) return;
      try {
        const s = await api(`~/api/pair/code?id=${c.id}`);
        if (s.status === 'claimed') {
          fill(box, h('p.banner.info', icon('check', { size: 18 }), h('span', `Paired: "${s.by}" may now control this computer.`)));
          return;
        }
        if (s.status === 'expired') return fill(box, h('p.hint', 'The code expired.'));
      } catch {
        /* try again */
      }
      timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
  }
  return [box, h('div.savebar', btn('secondary', { icon: 'key', label: 'Show a pairing code', onclick: show }))];
}

/** Add a computer → Advanced → "Who may control this computer": the tokens other dashboards hold. */
function tokens({ isAlive }) {
  const list = h('div.rows');
  async function paint() {
    let d;
    try {
      d = await api('~/api/tokens');
    } catch (e) {
      return fill(list, h('div.row.static', h('span.form-error', e.message)));
    }
    if (!isAlive()) return;
    fill(list, d.tokens.length
      ? d.tokens.map((t) => h('div.row.static',
        h('span.row-icon', icon('cpu')),
        h('span.row-main', h('span.row-title', t.name), h('span.row-sub', `Added ${ago(t.created)}${t.lastUsed ? ` · last used ${ago(t.lastUsed)}` : ' · not used yet'}`)),
        btn('small ghost', { icon: 'trash', label: 'Revoke', onclick: async () => {
          if (!(await confirmSheet({ title: `Revoke ${t.name}?`, text: `The dashboard on ${t.name} can no longer see or control this computer. It can be allowed again by adding this computer there again.`, ok: 'Revoke', danger: true }))) return;
          try {
            await api(`~/api/tokens/${t.id}/revoke`, {});
            toast(`${t.name} can no longer control this computer`);
            paint();
          } catch (e) {
            toast(e.message, { kind: 'error' });
          }
        } })))
      : h('div.row.static', h('span.row-main', h('span.row-sub', 'Nobody else. Another computer gets in only when you add this one there.'))));
  }
  paint();
  return [list];
}

/** Settings → Security and sign-in → "Sign in another device": the QR code of a one-time sign-in link. */
export function signIn({ isAlive }) {
  const box = h('div.signin');
  let timer = null;
  async function show() {
    clearTimeout(timer);
    let l;
    try {
      l = await api('~/api/login/links', {});
    } catch (e) {
      return fill(box, h('p.form-error', e.message));
    }
    fill(box,
      l.qr ? h('div.qrbox', qrSvg(l.qr)) : null,
      h('p.hint', `Scan it with the phone's camera. It signs that device in once, until ${new Date(l.expires).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}; no password to type.`),
      l.local ? h('p.banner.warn', icon('alert', { size: 18 }), h('span', 'This page is open on this computer\'s own address, which a phone cannot reach. Turn on Settings → Public link and show the code again there, or open the page by its network address.')) : null,
      h('div.cmdline', h('code', l.url), btn('icon ghost', { icon: 'copy', title: 'Copy the link', onclick: async () => toast((await copyText(l.url)) ? 'Copied — it works once' : 'Select and copy it by hand') })));
    const poll = async () => {
      if (!isAlive()) return;
      try {
        const s = await api(`~/api/login/links/${l.id}`);
        if (s.status === 'used') return fill(box, h('p.banner.info', icon('check', { size: 18 }), h('span', 'Signed in. The code no longer works.')));
        if (s.status === 'expired') return fill(box, h('p.hint', 'The code expired. Show a new one when you need it.'));
      } catch {
        /* try again */
      }
      timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
  }
  return [box, h('div.savebar', btn('primary', { icon: 'plus', label: 'Show a sign-in code', onclick: show }))];
}

// ---- the page ----
function viewComputers({ frame, sub }) {
  store.viewing = null;
  if (sub === 'add') return viewAdd(frame);
  if (sub) location.replace('#/computers');
  return viewList(frame);
}

registerPage({ id: 'computers', title: 'Computers', icon: 'cpu', group: 'main', order: 30, render: viewComputers });
