// Computers (#/computers): one list of every computer whose sessions this dashboard shows, each leading to its own
// page (pc.js), where it is renamed, tested and removed. "Add a computer" (#/computers/add) asks where the other
// computer is and shows the steps for that case: by SSH, a computer that connects by itself (at home, behind a
// router), or by its address and a pairing code. Its Advanced part holds the rarer things about this computer:
// whether it is linked to your main Hoprig (and the button that links it), connecting it to another dashboard, a pairing code for another one, and who may control it. "Sign in another
// device" is part of Settings → Security and sign-in (signIn below). Everything here talks to this dashboard
// ("~/api/...") except what asks one computer (at(m, ...)). Linking a computer that cannot be reached (the line to
// paste, "Link to my main", what it is linked to) is in joinlink.js.
import { APP_NAME, COMMAND } from './brand.js';
import { icon } from './icons.js';
import {
  MACHINE_STATE, add, api, at, btn, confirmSheet, copyText, fill, h, link, qrSvg, toast, ago,
} from './lib.js';
import { registerPage } from './registry.js';
import { emptyState, errorBox, field, fold, groupHead, okBox, panel, radioCards, steps } from './shell.js';
import { busy, byCode, cmdLine, joinOther, mainLinkCard } from './joinlink.js';
import { rootLoginBox } from './rootlogin.js';
import { byKey } from './sshkey.js';
import { osName } from './pc.js';
import { store } from './store.js';

// The Public link's switch on its settings page, opened at the switch itself (showpart.js).
export const PUBLIC_LINK_SWITCH = '#/settings/public-link?show=public-link-switch';

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
  // Offline says what to do next: its own page lists what to check (pc.js offlineCard).
  const first = !online && state === 'Offline' ? 'Cannot be reached · open it to see what to check'
    : [state, m && osName(m.platform), online ? plural((s.sessions || []).length, 'session') : null].filter(Boolean).join(' · ');
  const claude = !m ? '…' : m.claude ? `Claude Code ${m.claude}${update ? ` · version ${update} is out` : ''}` : online ? 'Claude Code not installed' : s.error || 'Not answering';
  return { online, first, claude };
}

function computerRow(s, m, update) {
  const l = computerLine(s, m, update);
  return h(`div.row.cp-row.cp-rowwrap${l.online ? '' : '.cp-off'}`,
    h('a.cp-rowlink', { href: link('#/computer', s.machine) },
      h('span.row-icon', icon('cpu')),
      h('span.row-main',
        h('span.row-title', s.machineLabel, s.machine === null ? h('span.badge.soft', 'This computer') : null),
        h('span.row-sub', h(`span.cp-dot${l.online ? '.on' : ''}`, { 'aria-hidden': 'true' }), l.first),
        h('span.row-sub.cp-claude', l.claude)),
      h('span.row-end', icon('chevronRight', { size: 18 }))));
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
    primary: { label: 'Add a computer', icon: 'plus', href: '#/computers/add' },
    primaryInHead: true, // on a phone in the page head: a floating button lay over a computer's row
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
    // Only this one: one line; linking it to a main Hoprig is under Add a computer → Advanced.
    fill(after, store.all.length === 1 ? emptyState('cpu', 'Only this computer so far. Add another one to see its sessions here too.') : null);
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

// A laptop of his comes first: it is the case of most people, and it needs no word they do not know. The titles are
// quoted by set-up's closing lines and the documents, so they stay; the lines under them say it in plain words.
const WAYS = [
  { value: 'join', title: 'It is at home or behind a router and cannot be reached from here', sub: 'A laptop or another computer of yours, at home or anywhere else: it connects to this one by itself. You paste one line there.' },
  { value: 'ssh', title: 'I can reach it by SSH from this computer', sub: 'A server you rent (the company you rent it from gave you an address and a key file), or a computer this one already logs in to.' },
  { value: 'url', title: 'It has an address (the same network, or its public link)', sub: `Its own ${APP_NAME} dashboard can be opened from here. You enter its address and a pairing code.` },
];

function viewAdd(frame) {
  let alive = true;
  // Is this computer linked to a main Hoprig (GET ~/api/joins), or can it be: part of Advanced, so drawn when it answers.
  const mainBox = h('div');
  let joinTimer = null;
  async function loadJoins() {
    clearTimeout(joinTimer);
    let joined = [];
    try {
      joined = (await api('~/api/joins')).joined;
    } catch {
      /* the card then offers the link */
    }
    if (!alive) return;
    fill(mainBox, mainLinkCard(joined, loadJoins));
    // While linked, keep its state fresh (a dropped connection comes back by itself).
    if (joined.length) joinTimer = setTimeout(loadJoins, 5000);
  }
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
    body: [
      groupHead('What is the other computer?'),
      choice, how,
      fold('computers-add', 'Advanced',
        mainBox,
        panel({ icon: 'swap', title: 'Show this computer on another dashboard', desc: 'The other way round: this computer connects out to a dashboard on another computer, such as a server.' }, ...joinOther({ isAlive })),
        panel({ icon: 'key', title: 'Let another computer add this one', desc: 'Shows a pairing code to type on the other computer\'s page. Adding by SSH there needs no code.' }, ...pairCode({ isAlive })),
        panel({ icon: 'lock', title: 'Who may control this computer', desc: 'Other computers\' dashboards that can see and drive the sessions here. They cannot change the password or this list.' }, ...tokens({ isAlive }))),
    ],
  });
  loadJoins();
  return () => {
    alive = false;
    clearTimeout(joinTimer);
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

  // `stayRoot` ({ sentence }): typed in the root-login box, to keep Hoprig on root there on purpose.
  // `workUser`: he confirmed that the root login makes the work user there; the add then uses that user's login.
  async function install(target, stayRoot, rootWords = null, workUser = false) {
    const out = h('pre.output', { 'aria-live': 'polite' });
    fill(msg, busy(`Installing ${APP_NAME} on ${target}… this can take a few minutes.`), out);
    try {
      await api('~/api/machines/install', { target, confirm: target, ...(stayRoot ? { stayRoot } : {}), ...(workUser ? { workUser } : {}) });
      const r = await follow('~/api/machines/install', out, isAlive);
      if (r && r.ok) return addIt(r.target || target);
      add(msg, errorBox(r && r.error ? r.error : 'The installer did not finish: see its output above. Fix what it says, then press Add again.'));
    } catch (e) {
      // A root login there: nothing was installed; the box says why and offers the work user or the sentence.
      const words = rootWords || e.message;
      if (e.code === 'root-login' || (e.code === 'stay-root' && rootWords)) return fill(msg, rootLoginBox(words, (s) => install(target, s, words), e.code === 'stay-root' ? e.message : null, { server: target.replace(/^.*@/, ''), makeUser: (w) => install(target, null, words, w || true) }));
      add(msg, errorBox(e));
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
          errorBox(e),
          h('p.hint', e.data.canInstall ? 'Let this page install it there, or type this line there yourself (it needs Node.js 24.13.1 or newer), then press Add again:' : 'Type this line there (it needs Node.js 24.13.1 or newer), then press Add again:'),
          cmdLine(cmd),
          e.data.canInstall ? h('div.savebar.start', btn('primary', { icon: 'download', label: 'Install it there for me', onclick: () => install(target) })) : null);
      } else {
        fill(msg, errorBox(e), h('p.hint', `Next: if it asks for a password, choose "I have a key file for it" above and give the key the company you rent it from gave you; or check that "ssh ${target}" works from this computer without a password, then press Add again.`));
      }
    }
    go.disabled = false;
  }

  // Two ways to log in: a name ssh on this computer already knows (its ~/.ssh), or a key file given here.
  const KEY_WAYS = [
    { value: 'known', title: 'This computer already logs in there', sub: 'With "ssh user@host" or a name from ~/.ssh/config, without a password.' },
    { value: 'key', title: 'I have a key file for it', sub: 'Such as the one the company you rent a server from gives you. Paste it or pick the file; it is kept only here.' },
  ];
  let keyWay = 'known';
  const wayBox = h('div');
  const body = h('div');
  const paintWay = () => {
    fill(wayBox, radioCards('ssh-way', KEY_WAYS, keyWay, (v) => {
      keyWay = v;
      paintWay();
    }));
    fill(body, keyWay === 'key' ? byKey(isAlive, added) : known);
  };
  const known = h('div', steps(
      [h('strong', 'Make sure this computer can log in there with an SSH key.'), h('span.hint', `If it asks for a password, choose "I have a key file for it" above instead, or ask the company you rent it from for a key. ${APP_NAME} must be installed there too; this page offers to do it.`)],
      [h('strong', 'Type its SSH address and press Add.'),
        h('form.inlineform', { onsubmit: (e) => { e.preventDefault(); addIt(); } }, input, go)]),
    msg);
  paintWay();
  return h('section.card.panel', wayBox, body);
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
      fill(msg, errorBox(e), h('p.hint', 'Next: check that the address opens in a browser on this computer, and that the code is fresh (it works once, for 10 minutes). Then press Pair again.'));
    }
    go.disabled = false;
  }
  return h('section.card.panel',
    h('form.stack', { onsubmit: (e) => { e.preventDefault(); pair(); } },
      steps(
        [h('strong', 'On the other computer, show a pairing code.'), h('span.hint', `Open its dashboard there: Computers → Add a computer → Advanced → Let another computer add this one. (In a terminal there: ${COMMAND} pair.)`)],
        [field('Its dashboard address', urlInput), field('Pairing code', codeInput, 'A code works once, for 10 minutes.')],
        [h('strong', 'Press Pair.'), h('div.savebar.start', go)]),
      msg));
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
      ? d.tokens.map((t) => h('div.row.static.col.mrow',
        h('div.mrow-top',
          h('span.row-icon', icon('cpu')),
          h('span.row-main', h('span.row-title', t.name), h('span.row-sub.pj-wrap', `Added ${ago(t.created)}${t.lastUsed ? ` · last used ${ago(t.lastUsed)}` : ' · not used yet'}${t.hub ? ' · your main computer: its page may drop, push and change groups here' : ''}`))),
        // Two buttons: under the name, so that at phone width the name is never cut. A hub that added this computer
        // before tokens had the mark holds a plain one: the owner marks it here.
        h('div.mrow-actions', btn('small ghost', { icon: 'cpu', label: t.hub ? 'Not my main computer' : 'Mark as my main computer', onclick: async () => {
          if (!t.hub && !(await confirmSheet({ title: `Is ${t.name} your main computer?`, text: `The Workspace page of ${t.name} may then drop a project here, push and change the groups of the map, each with the same questions as on this page. Mark it only for a dashboard of yours, never for a script.`, ok: 'Mark as my main computer' }))) return;
          try {
            await api(`~/api/tokens/${t.id}/hub`, { hub: !t.hub });
            toast(t.hub ? `${t.name} is no longer marked as your main computer` : `${t.name} is marked as your main computer`);
            paint();
          } catch (e) {
            toast(e, { kind: 'error' });
          }
        } }),
        btn('small ghost', { icon: 'trash', label: 'Revoke', onclick: async () => {
          if (!(await confirmSheet({ title: `Revoke ${t.name}?`, text: `The dashboard on ${t.name} can no longer see or control this computer. It can be allowed again by adding this computer there again.`, ok: 'Revoke', danger: true }))) return;
          try {
            await api(`~/api/tokens/${t.id}/revoke`, {});
            toast(`${t.name} can no longer control this computer`);
            paint();
          } catch (e) {
            toast(e, { kind: 'error' });
          }
        } }))))
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
      l.local ? h('p.banner.warn', icon('alert', { size: 18 }), h('span', 'This page is open on this computer\'s own address, which a phone cannot reach. Turn on Settings → Public link and show the code again there, or open the page by its network address. ', h('a', { href: link(PUBLIC_LINK_SWITCH) }, 'Open the switch'))) : null,
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
