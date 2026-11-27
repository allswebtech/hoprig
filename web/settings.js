// Settings (#/settings, #/settings/<page>): a list of seven rows — its title and one line with the current state — and
// the chosen page. Desktop: the list on the left, the page on the right; a phone shows one at a time. The rows:
// New sessions (Hands-off is a fold in it) · Notifications · Appearance · Security and sign-in (the Public link is a
// fold in it) · Tia · Automations (the Workspace is a fold in it) · Version and updates, and Runs as root where it
// applies. Add-ons is no row (Security and sign-in and Providers lead to it). Every page is still registered with
// registerSettingsPage; MERGED_INTO says which row draws it, so an old address (#/settings/public-link) opens the row
// with that part in view. The foot of the list says the version and brings "Get started" back. Old page names
// (SETTINGS_ALIASES, MOVED_PARTS) lead to where their content is now.
// Settings stored on the computer are saved with POST /api/settings (checked there); look and in-page alerts are per
// device (localStorage). With several computers the switcher picks whose settings these are (#/m/<computer>/settings).
import { APP_NAME, COMMAND } from './brand.js';
import { PUBLIC_LINK_SWITCH, signIn } from './computers.js';
import { cmdLine } from './joinlink.js';
import { icon } from './icons.js';
import { api, applyPageTheme, btn, confirmSheet, fill, h, link, machine, prefs, toast, url } from './lib.js';
import { registerPage, registerSettingsPage, registeredSettingsPages } from './registry.js';
import { field, fold, info, openLabel, panel, saveBar, savedMark, toggle } from './shell.js';
import { pageNotify, store } from './store.js';
import { deskStyle, desktopSettings, reachRow } from './desktop/index.js';
import { editorPanel } from './editor/index.js';
import { voicePanel } from './voice.js';
import { workTellParts } from './worktell.js';
import { partOf, showPart } from './showpart.js';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ======================= the pages of Settings =======================

// ---------- Notifications ----------
const EVENT_LABELS = { waiting: 'Finished', attention: 'Needs your OK', limit: 'Limit reached', ended: 'Ended', switched: 'Moved to another provider', automation: 'An automation needs you' };

function notifyPage({ settings: s }) {
  const n = s.server.notify || {};
  // `format` is kept as it was saved (an old "ntfy" or "json" stays); the page no longer offers it.
  const st = { url: n.url || '', format: n.format || 'auto', events: n.events || s.notifyEvents, publicUrl: s.server.publicUrl || '', work: n.work || {}, newVersion: null, newVersionSaved: null };
  const browserLine = h('p.hint');
  const browserBtn = btn('secondary small', { icon: 'bell', label: 'Allow notifications in this browser' });
  const paintBrowser = () => {
    const b = pageNotify.browser;
    browserBtn.classList.toggle('hidden', b !== 'default');
    browserLine.textContent = {
      granted: 'This browser shows a notification while the page is in the background.',
      denied: 'Notifications are blocked for this site in the browser settings.',
      default: 'This browser can show a notification while the page is in the background.',
      unsupported: 'This browser has no notifications; use phone push below.',
      insecure: 'Browser notifications need HTTPS. Use phone push below instead.',
    }[b];
  };
  browserBtn.addEventListener('click', async () => {
    await pageNotify.askBrowser();
    paintBrowser();
  });
  paintBrowser();
  const tell = workTellParts(st, { status: () => api('/api/work/tell') });
  // "A new version is out" is one more line of the list; it is kept by Settings → Version and updates' own key.
  const newVersion = h('input', { type: 'checkbox', disabled: true, 'data-key': 'updates-notify', onchange: (e) => (st.newVersion = e.target.checked) });
  const newVersionRow = h('label.check.hidden', newVersion, h('span', 'A new version is out'));
  api('/api/updates').then((u) => {
    if (typeof u.notify !== 'boolean') return;
    st.newVersion = st.newVersionSaved = u.notify;
    newVersion.checked = u.notify;
    newVersion.disabled = false;
    newVersionRow.classList.remove('hidden');
  }, () => {}); // an older computer: no such line
  return [
    panel({ icon: 'bell', title: 'On this device', desc: 'While this page is open. Kept on this device only.' },
      toggle('Sound', pageNotify.sound, (v) => prefs.set('notify.sound', v), 'A short tone when a session starts waiting for you.'),
      toggle('Vibrate', pageNotify.vibrate, (v) => prefs.set('notify.vibrate', v), 'Phones only.'),
      browserLine, browserBtn),
    panel({ icon: 'send', title: 'On your phone', desc: 'Even with the page closed.' },
      field('Push address', h('input.field', { type: 'url', value: st.url, placeholder: 'https://ntfy.sh/your-secret-topic', oninput: (e) => (st.url = e.target.value.trim()) }),
        'Install the free ntfy app, subscribe to a long random topic name and paste its address here. Empty: no push.'),
      fold('settings-notify', 'Advanced',
        field('This page\'s address', h('input.field', { id: 'page-address', type: 'url', value: st.publicUrl, placeholder: 'https://pc.example.net', oninput: (e) => (st.publicUrl = e.target.value.trim()) }),
          'When set, tapping a push opens the session directly.'))),
    panel({ icon: 'tasks', title: 'Tell me when', desc: 'These go to the push address above: set it first. Each of Work\'s is off until you turn it on.' },
      tell.notice,
      h('div.checks', [
        ...s.notifyEvents.map((ev) =>
          h('label.check', h('input', { type: 'checkbox', checked: st.events.includes(ev), 'data-key': `event-${ev}`, onchange: (e) => { st.events = e.target.checked ? [...st.events, ev] : st.events.filter((x) => x !== ev); } }), h('span', EVENT_LABELS[ev] || ev))),
        ...tell.items,
        newVersionRow]),
      tell.quiet,
      fold('settings-notify-more', 'More', ...tell.more),
      h('div.savebar',
        btn('secondary', {
          icon: 'bell',
          label: 'Send a test',
          onclick: async () => {
            try {
              await api('/api/notify/test', {});
              toast('Test sent — check your phone');
            } catch (e) {
              toast(e, { kind: 'error' });
            }
          },
        }),
        saveBar('Save', async () => {
          await api('/api/settings', {
            server: { notify: st.url ? { url: st.url, events: st.events, ...(st.format !== 'auto' ? { format: st.format } : {}), ...(Object.keys(st.work).length ? { work: st.work } : {}) } : null, publicUrl: st.publicUrl },
          });
          if (st.newVersion !== null && st.newVersion !== st.newVersionSaved) {
            await api('/api/updates/settings', { notify: st.newVersion });
            st.newVersionSaved = st.newVersion;
          }
        }))),
  ];
}

function notifySummary({ settings: s }) {
  const push = !!(s.server.notify && s.server.notify.url);
  return [push ? 'Phone push on' : 'No phone push', pageNotify.browser === 'granted' ? 'browser on' : null, pageNotify.sound ? 'sound on' : null].filter(Boolean).join(' · ');
}

// ---------- Appearance and terminal ----------
const termFont = () => prefs.get('term.font', innerWidth < 600 ? 13 : 14);

function lookPanel() {
  // Kept at once on this device: "Saved" next to the label of what changed.
  const marks = {};
  const seg = (key, dflt, options, after) => {
    const el = h('div.segmented', { role: 'radiogroup' });
    const paint = () => {
      const cur = prefs.get(key, dflt);
      fill(el, options.map(([v, label, ic]) =>
        h('button.seg', { type: 'button', role: 'radio', 'aria-checked': String(cur === v), onclick: (e) => { e.preventDefault(); prefs.set(key, v); paint(); after?.(); marks[key].show(); } }, icon(ic, { size: 16 }), h('span', label))));
    };
    paint();
    return el;
  };
  const size = h('span.fontsize');
  const paintSize = () => (size.textContent = `${termFont()} px`);
  paintSize();
  const step = (d) => {
    prefs.set('term.font', Math.min(22, Math.max(9, termFont() + d)));
    paintSize();
    marks['term.font'].show();
  };
  const keyOf = { 'Page colours': 'page.theme', 'Terminal colours': 'term.theme', 'Terminal text size': 'term.font' };
  const ids = { 'Page colours': 'page-theme' }; // a sentence elsewhere opens the page at it (?show=page-theme)
  const group = (label, control, hint) => h('div.fieldrow', ids[label] ? { id: ids[label] } : {}, h('span.field-label', label, (marks[keyOf[label]] = savedMark())), control, hint ? h('span.hint', hint) : null);
  return panel({ icon: 'sun', title: 'Colours and text size', desc: 'Saved on this device only.' },
    group('Page colours', seg('page.theme', 'system', [['system', 'System', 'refresh'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']], applyPageTheme), 'System follows your phone or computer setting.'),
    group('Terminal colours', seg('term.theme', 'dark', [['dark', 'Dark', 'moon'], ['light', 'Light', 'sun'], ['system', 'System', 'refresh']]), 'Coding tools are drawn for a dark terminal, so dark reads best.'),
    group('Terminal text size', h('div.stepper-inline', btn('icon secondary', { icon: 'minus', title: 'Smaller', onclick: () => step(-1) }), size, btn('icon secondary', { icon: 'plus', title: 'Larger', onclick: () => step(1) })), 'Smaller text fits more on a phone screen.'));
}

function quickPanel(actions) {
  const rows = actions.map((a) => ({ ...a }));
  const list = h('div.qlist');
  const paint = () =>
    fill(list, rows.length ? rows.map((r, i) =>
      h('div.qrow',
        h('input.field.qlabel', { value: r.label, placeholder: 'Button text', maxlength: 24, 'aria-label': 'Button text', oninput: (e) => (r.label = e.target.value) }),
        h('input.field.qtext', { value: r.text, placeholder: 'Message it sends', maxlength: 500, 'aria-label': 'Message it sends', oninput: (e) => (r.text = e.target.value) }),
        btn('icon ghost', { icon: 'up', title: 'Move up', disabled: i === 0, onclick: () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; paint(); } }),
        btn('icon ghost', { icon: 'trash', title: 'Remove', onclick: () => { rows.splice(i, 1); paint(); } })))
      : h('p.muted', 'No quick messages.'));
  paint();
  return panel({ id: 'quick', icon: 'send', title: 'Quick messages', desc: 'Buttons above the message box that send a message with one tap, like "continue" or "/compact".' },
    list,
    h('div.savebar',
      btn('secondary', { icon: 'plus', label: 'Add', onclick: () => { rows.push({ label: '', text: '' }); paint(); } }),
      saveBar('Save', () => api('/api/settings', { server: { quickActions: rows.filter((r) => r.label.trim() || r.text.trim()) } }).then(() => store.refresh()))));
}

function terminalsPanel(b) {
  const tmux = b && b.kind === 'tmux';
  return panel({ icon: 'terminal', title: 'Terminals', desc: 'How sessions are kept on the computer.' },
    info('Kept by', tmux ? 'tmux' : 'the dashboard itself', tmux
      ? 'Sessions keep running when the dashboard restarts, and you can also open them with "tmux attach" on the computer.'
      : 'Sessions end when the dashboard stops or restarts. Install tmux on the computer to keep them running.'),
    h('p.hint', 'Hoprig picks tmux when it is installed, else its own terminals.'));
}

const lookSummary = () => `${cap(prefs.get('page.theme', 'system'))} · terminal ${prefs.get('term.theme', 'dark')} · ${termFont()} px · desktop ${deskStyle() === 'dock' ? 'Dock' : 'Taskbar'}`;

// ---------- Security and sign-in ----------
function passwordPanel() {
  const cur = h('input.field', { type: 'password', autocomplete: 'current-password' });
  const next = h('input.field', { type: 'password', autocomplete: 'new-password', minlength: 8 });
  const again = h('input.field', { type: 'password', autocomplete: 'new-password' });
  // Done rarely: the three fields open only after "Change password".
  const form = h('div.hidden',
    field('Current password', cur),
    field('New password', next, 'At least 8 characters.'),
    field('New password again', again),
    saveBar('Save the new password', async () => {
      if (next.value !== again.value) throw new Error('The two new passwords are not the same.');
      await api('/api/settings/password', { current: cur.value, next: next.value });
      cur.value = next.value = again.value = '';
      setTimeout(() => { form.classList.add('hidden'); open.classList.remove('hidden'); }, 1500);
    }, 'Changed'));
  const open = h('div.savebar.start', btn('secondary', { icon: 'key', label: 'Change password', onclick: () => {
    form.classList.remove('hidden');
    open.classList.add('hidden');
    cur.focus();
  } }));
  return panel({ id: 'password', icon: 'key', title: 'Password', desc: 'Changing it logs out every other browser and phone; this one stays logged in.' }, open, form);
}

function networkPanel(s) {
  const n = s.network;
  const st = { trustProxy: n.trustProxy, origins: n.allowedOrigins.join('\n') };
  return panel({ icon: 'lock', title: 'Network', desc: 'Where this page can be reached from.' },
    info('Address', `${n.host}:${n.port}`, addressHint(s)),
    networkWords(s).warn ? h('p.banner.warn', networkWords(s).warn) : null,
    n.server
      // A server: the network is the internet on plain http, so the page names the safe ways instead.
      ? h('div.hint', h('p', networkWords(s).lead),
        h('ul', n.server.ways.map((w, i, all) => h('li', w, i === all.length - 1 && n.server.forward ? cmdLine(n.server.forward) : null))))
      : h('p.hint', `To change it, run on the computer: ${COMMAND} serve --host 0.0.0.0 --port ${n.port} (or set server.host and server.port in the config), then restart the dashboard.`),
    toggle('Behind an HTTPS proxy', st.trustProxy, (v) => { st.trustProxy = v; return false; }, // kept by Save below
      { line: 'Turn on only when a reverse proxy (Caddy, nginx) sits in front of this page.', more: 'The page then believes the address and protocol it reports.' }),
    field('Other allowed addresses', h('textarea.field.mono', { rows: 2, value: st.origins, placeholder: 'https://pc.example.net', oninput: (e) => (st.origins = e.target.value) }), 'Only needed when the page is opened under a different address than it runs on. One per line.'),
    saveBar('Save', () => api('/api/settings', { server: { trustProxy: st.trustProxy, allowedOrigins: st.origins.split('\n').map((x) => x.trim()).filter(Boolean) } })));
}

const loopbackOnly = (s) => ['127.0.0.1', '::1', 'localhost'].includes(s.network.host) || /^127\./.test(s.network.host);

/**
 * The words of Settings → Network: { address, warn, lead }. On a server (s.network.server) a dashboard open to the
 * network is open to the internet on plain http: said as a warning with doctor's fix, never "not opened here".
 */
export function networkWords(s) {
  const n = s.network;
  const local = loopbackOnly(s);
  if (n.server && !local) {
    return {
      address: 'Open to the internet on plain http.',
      warn: `Open to the network on plain http: ${n.server.why}, so anyone could read the password on the way. Close it on the computer: ${COMMAND} setup --access local`,
      lead: 'Then open it from elsewhere in one of these ways:',
    };
  }
  return {
    address: local ? 'Only this computer can open the page; turn on Settings → Public link to open it from anywhere.' : 'Other devices on the network can open the page.',
    warn: null,
    lead: n.server ? `Not opened to the network here: ${n.server.why}, so anyone could read the password on the way. To open it from elsewhere:` : '',
  };
}

/** The network line under the address: where it names the public link, a link opens its switch. */
export function addressHint(s) {
  const w = networkWords(s).address;
  return /Public link/.test(w) ? h('span', w, ' ', h('a', { href: link(PUBLIC_LINK_SWITCH) }, 'Open the switch')) : w;
}

/** "Folders Hoprig may open": the allowed folders, and how far Files and the editor reach (server.roots, server.reach). */
function foldersPanel(settings) {
  const roots = Array.isArray(settings.server.roots) ? settings.server.roots : [];
  const area = h('textarea.field.mono', { rows: Math.max(2, roots.length + 1), value: roots.join('\n'), spellcheck: 'false', autocapitalize: 'off' });
  return panel({ id: 'folders', icon: 'folder', title: 'Folders Hoprig may open', desc: 'Sessions, Tia and automations always stay inside these folders; the choice below is only for Files and the editor.' },
    field('Folders (one full path per line)', area, 'Fewer folders means less of the computer is reachable from here.'),
    saveBar('Save', () => api('/api/settings', { server: { roots: area.value.split('\n').map((x) => x.trim()).filter(Boolean) } })),
    reachRow(settings));
}

/** Leaving this device (the one place of Log out). */
function thisDevicePanel() {
  return panel({ id: 'this-device', icon: 'logout', title: 'This device' },
    h('div.savebar', btn('secondary', {
      icon: 'logout',
      label: 'Log out on this device',
      onclick: async () => {
        if (await confirmSheet({ title: 'Log out on this device?', ok: 'Log out' })) {
          await api('/api/logout', {}).catch(() => {});
          location.href = url('/login');
        }
      },
    })));
}

function securityPage(ctx) {
  return [
    ctx.here ? panel({ icon: 'user', title: 'Sign in another device', desc: 'A phone or tablet signs in by scanning a code instead of typing the password.' }, ...signIn(ctx)) : null,
    ctx.here ? passwordPanel() : h('p.banner.muted', icon('lock', { size: 18 }), h('span', `The password of ${openLabel()} is changed on that computer.`)),
    foldersPanel(ctx.settings),
    ctx.here ? thisDevicePanel() : null,
    fold('settings-security', 'Advanced', networkPanel(ctx.settings), h('p.hint', 'Add-on gateways are under ', h('a', { href: link('#/settings/addons') }, 'Add-ons'), '.')),
  ];
}

// The list's line says what a person looks for here: the password and his phone (the sign-in code is on this page).
export const securitySummary = ({ settings: s, here }) => (here ? 'Password · sign in your phone' : loopbackOnly(s) ? 'this computer only' : 'open to the network');

registerSettingsPage({ id: 'notifications', title: 'Notifications', icon: 'bell', order: 20, desc: 'Get told when a session needs you, so you do not have to keep looking.', summary: notifySummary, render: notifyPage });
registerSettingsPage({
  id: 'appearance', title: 'Appearance', icon: 'sun', order: 30, desc: 'How Hoprig looks and types on this device.', summary: lookSummary,
  render: ({ settings: s }) => [lookPanel(), editorPanel(), desktopSettings(), voicePanel(), quickPanel(s.server.quickActions), fold('settings-appearance', 'Advanced', terminalsPanel(s.backend))],
});
registerSettingsPage({ id: 'security', title: 'Security and sign-in', icon: 'lock', order: 40, desc: 'The password, signing in a phone, the folders Hoprig may open, and where this page can be reached from.', summary: securitySummary, render: securityPage });

// ======================= the Settings page =======================

/**
 * Other names of a settings page that an address may hold (a link in a message, Get started's steps), and the pages
 * whose content moved: Editor and Coding tools are cards now, About and Field reports are part of Version and updates.
 * Used only when no page has the name itself.
 */
export const SETTINGS_ALIASES = Object.freeze({ 'signin-device': 'security', editor: 'appearance', codingtools: 'new-sessions', about: 'updates', field: 'updates' });
/** The part of the page that a moved name opens at (the card it became). */
const MOVED_PART = Object.freeze({ editor: 'code-editor', codingtools: 'coding-tools', field: 'field-send' });
/** A page that left Settings for a page of its own: its old address goes there. */
export const MOVED_OUT = Object.freeze({ work: '#/work/tasks' });
/** The part of the new page an old address opens at: the one it names (`?show=owner-id`), else the Work settings fold. */
const MOVED_OUT_PART = Object.freeze({ work: 'work-place' });
export const movedOutHref = (sub, query) => `${MOVED_OUT[sub]}?show=${partOf(query) || MOVED_OUT_PART[sub]}`;
/** Parts that moved to another page: `<page>?show=<part>` opens the page and part named here. */
export const MOVED_PARTS = Object.freeze({ 'new-sessions': { folders: 'security' }, about: { 'this-device': 'security' } });

/**
 * The page an address names: its own id or one of its other names, else the first page. `missing`: the address
 * named a page that is not there, which the page says (never another page shown as if it were the one asked for).
 * `part`: the `show` part of the address; a part that moved opens the page it moved to.
 */
export function chooseSettingsPage(pages, sub, part = null) {
  const moved = Object.hasOwn(MOVED_PARTS, sub) && part && Object.hasOwn(MOVED_PARTS[sub], part) ? MOVED_PARTS[sub][part] : null;
  const own = pages.find((p) => p.id === sub) || null;
  const id = moved || (own ? sub : Object.hasOwn(SETTINGS_ALIASES, sub) ? SETTINGS_ALIASES[sub] : sub);
  const page = pages.find((p) => p.id === id) || null;
  // A page drawn inside another row: the address opens that row.
  const host = page && Object.hasOwn(MERGED_INTO, page.id) ? pages.find((p) => p.id === MERGED_INTO[page.id]) || page : page;
  return { chosen: host || pages[0], missing: !!sub && !page };
}

/** The pages drawn inside another row, as a closed fold: old id → the row that holds it. */
export const MERGED_INTO = Object.freeze({ handsoff: 'new-sessions', 'public-link': 'security', workspace: 'automations' });
/** The rows of the list, in order. Add-ons has no row: it opens only at its own address. */
const ROW_ORDER = ['new-sessions', 'root', 'notifications', 'appearance', 'security', 'tia', 'automations', 'updates'];
const NO_ROW = new Set(['addons']);

/** The rows of the list out of every page shown: the merged ones and Add-ons left out; a page a feature adds comes last. */
export function settingsRows(pages) {
  const rank = (p) => (ROW_ORDER.includes(p.id) ? ROW_ORDER.indexOf(p.id) : ROW_ORDER.length + p.order / 1000);
  return pages.filter((p) => !Object.hasOwn(MERGED_INTO, p.id) && !NO_ROW.has(p.id)).sort((a, b) => rank(a) - rank(b));
}

/** A closed fold with the old page's name and its content, drawn when first opened (at once when `now`, open when `openIt`). */
function mergedFold(p, ctx, now, openIt) {
  const body = h('div.fold-body');
  const draw = () => {
    let content;
    try {
      content = p.render(ctx);
    } catch (e) {
      content = h('p.form-error', e.message);
    }
    fill(body, content);
  };
  const d = h('details.fold', { id: p.id }, h('summary.fold-summary', h('span', p.title), icon('chevronDown', { size: 18 })), body);
  let drawn = false;
  const once = () => {
    if (drawn) return;
    drawn = true;
    draw();
  };
  if (now) {
    if (openIt) d.open = true;
    once();
  } else d.addEventListener('toggle', () => d.open && once());
  return d;
}

/** What a row shows: its own page, then the pages merged into it as closed folds. `open`: the merged page to open now; `part`: any part an address names (every merged page is then drawn, so the part is there to find). */
export function pageBody(chosen, pages, ctx, { open = null, part = null } = {}) {
  let own;
  try {
    own = chosen.render(ctx);
  } catch (e) {
    own = h('p.form-error', e.message);
  }
  const merged = pages.filter((p) => MERGED_INTO[p.id] === chosen.id);
  return [own, ...merged.map((p) => mergedFold(p, ctx, !!part || open === p.id, open === p.id))];
}

/** The part to open for an address: the one it names, else the card a moved page became. */
export const partFor = (sub, part, pages) => part || (Object.hasOwn(MERGED_INTO, sub) && pages.some((p) => p.id === sub) ? sub : !pages.some((p) => p.id === sub) && Object.hasOwn(MOVED_PART, sub) ? MOVED_PART[sub] : null);

/** The foot of the list: the version, and "Show Get started again" while Home's Get started is closed. */
function settingsFoot({ settings, state, here }) {
  const closed = here && !!((state && state.getStartedDismissed) || (store.data && store.data.getStartedDismissed));
  const again = h('span', ' · ', btn('ghost small', { label: 'Show Get started again', onclick: async () => {
    try {
      await api('~/api/settings', { server: { getStartedDismissed: false } });
    } catch (e) {
      return toast(e, { kind: 'error' });
    }
    await store.refresh();
    again.remove();
    toast('"Get started" is back on Home');
  } }));
  return h('p.hint.settings-foot', `${APP_NAME} ${settings.version || ''}`.trim(), closed ? again : null);
}

function viewSettings({ frame, sub, query }) {
  store.viewing = null;
  const here = !machine.current; // this dashboard's own settings
  const list = h('nav.split-list', { 'aria-label': 'Settings pages' });
  const pane = h('div.split-pane', h('div.empty', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Loading settings…')));
  const split = h(`div.split${sub ? '.has-page' : '.no-page'}`, list, pane);
  frame({
    title: 'Settings',
    page: 'settings',
    intro: here ? null : `The settings of ${openLabel()}.`,
    back: sub ? link('#/settings') : null,
    backLabel: 'Settings',
    backOnPhoneOnly: true, // the list stays on the left on a desktop
    wide: true,
    body: [split],
  });
  let alive = true;
  const isAlive = () => alive;
  let summarize = () => {};
  const onSaved = () => summarize();
  window.addEventListener('saved', onSaved);

  async function load() {
    let settings;
    let state;
    try {
      [settings, state] = await Promise.all([api('/api/settings'), api('/api/state')]);
    } catch (e) {
      fill(pane, h('div.empty', icon('alert', { size: 32 }), h('p', e.message), btn('secondary', { label: 'Try again', icon: 'refresh', onclick: load })));
      return;
    }
    if (!alive) return;
    const ctx = { settings, state, here, isAlive };
    const shownWhen = (p) => { if (!p.when) return true; try { return p.when(ctx) !== false; } catch { return false; } };
    const pages = registeredSettingsPages().filter((p) => (here || !p.onlyHere) && shownWhen(p));
    if (sub && !pages.some((p) => p.id === sub) && Object.hasOwn(MOVED_OUT, sub)) {
      location.replace(link(movedOutHref(sub, query)));
      return;
    }
    const { chosen, missing } = chooseSettingsPage(pages, sub, partOf(query));
    const lines = new Map();
    // The one-line states: now, and again after anything on the page is saved.
    summarize = async () => {
      try {
        ctx.settings = await api('/api/settings');
      } catch {
        /* keep the last */
      }
      for (const [p, line] of lines) Promise.resolve().then(() => p.summary(ctx)).then((t) => (line.textContent = t || ''), () => {});
    };
    fill(list, h('div.rows', settingsRows(pages).map((p) => {
      const line = h('span.row-sub', '');
      lines.set(p, line);
      Promise.resolve().then(() => p.summary(ctx)).then((t) => (line.textContent = t || ''), () => {});
      // Marked as open only when it is (a phone shows the list alone at #/settings).
      return h(`a.row${p === chosen && !missing ? '.split-current' : ''}`, { href: link(`#/settings/${p.id}`), 'aria-current': sub && p === chosen && !missing ? 'page' : null },
        h('span.row-icon', icon(p.icon)),
        h('span.row-main', h('span.row-title', p.title, p.tag ? h('span.badge.soft.tag', p.tag) : null), line),
        h('span.row-end', icon('chevronRight', { size: 18 })));
    })), settingsFoot(ctx));
    if (missing) {
      return fill(pane, h('div.empty', icon('alert', { size: 32 }), h('p', 'This settings page does not exist.'),
        h('a.btn.secondary', { href: link('#/settings') }, 'See all settings')));
    }
    // The part to open for an address: the one it names, else the page that was merged into this row.
    const part = partFor(sub, partOf(query), pages);
    const content = pageBody(chosen, pages, ctx, { open: part, part });
    fill(pane,
      h('header.split-head', h('h2.split-title', chosen.title, chosen.tag ? h('span.badge.soft.tag', chosen.tag) : null), chosen.desc ? h('p.page-intro', chosen.desc) : null),
      h('div.split-body', content));
    // "?show=<part>": a sentence elsewhere that sends him here opens the page at the switch or field it names.
    if (part) showPart(part, { alive: isAlive });
  }
  load();
  return () => {
    alive = false;
    window.removeEventListener('saved', onSaved);
  };
}

registerPage({ id: 'settings', title: 'Settings', icon: 'settings', group: 'more', order: 100, perComputer: true, render: viewSettings });
