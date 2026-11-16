// The Services of a computer (GET /api/services, POST /api/services/action, GET /api/services/logs;
// src/desktop/services.mjs): the list with each one's state, start, stop and restart, and the last lines of a
// service's log. The user's own services change at once; the system's ask for the computer's password the way Setup
// does (used once, not kept, sent only in a JSON field so the hub refuses it over a leg that is not encrypted).
// This dashboard's own service is never changed from here, and stopping SSH asks for its name to be typed first.
// On a computer whose services cannot be changed this way (Windows) the list is read-only.
import { icon } from '../icons.js';
import { api, at, confirmSheet, fill, h, insecure, openSheet, promptSheet, toast } from '../lib.js';
import { plainLegSheet } from '../setupjob.js';
import { choice, errorLine, errorText, filterField, poll, sortBy, table, when } from './native.js';

const STATES = [['all', 'All'], ['running', 'Running'], ['stopped', 'Stopped'], ['failed', 'Failed']];
const STATE_WORD = { running: 'Running', stopped: 'Stopped', failed: 'Failed' };
// Whether a service starts with the computer, in plain words (systemd's own word in the tooltip).
const START_WORD = { enabled: 'Yes', 'enabled-runtime': 'Yes', linked: 'Yes', 'linked-runtime': 'Yes', disabled: 'No', static: 'When needed', indirect: 'When needed', generated: 'Yes', transient: 'No', masked: 'Blocked', manual: 'No', boot: 'Yes', system: 'Yes' };
// What a stop or a restart does, said before it is done (the user's own services change on one press otherwise).
const ASK = {
  stop: (n) => `${n} stops now, and whatever runs in it stops with it. It runs again when it is started here, or when the computer starts if it starts with the computer.`,
  restart: (n) => `${n} stops and starts again. Whatever runs in it is cut off for a moment and starts over.`,
};
const VERB = { start: 'Start', stop: 'Stop', restart: 'Restart' };
const DONE = { start: 'started', stop: 'stopped', restart: 'restarted' };
const LOG_LINES = 120;

/** Which of the filter's groups a service is in. */
const groupOf = (s) => (s.active === 'failed' ? 'failed' : s.active === 'active' || s.active === 'activating' || s.active === 'reloading' ? 'running' : 'stopped');

/** The password sheet for one service action. Resolves the password or null. */
function passwordFor(action, name, wrong) {
  const plain = insecure();
  return openSheet({ title: 'The computer\'s password', subtitle: `${VERB[action]} ${name} needs administrator rights (sudo).` }, (close) => {
    const input = h('input.field', { type: 'password', autofocus: true, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Password' });
    const err = h('p.form-error', { role: 'alert' }, wrong ? 'That password was not accepted. Try again.' : '');
    return h('form', { onsubmit: (e) => {
      e.preventDefault();
      if (!input.value) err.textContent = 'Type the password.';
      else close(input.value);
    } },
    plain ? h('div.banner.warn', icon('lock', { size: 18 }), h('span', 'This page is not encrypted (http): the password would cross the network readable by anyone on the way. Open the dashboard over HTTPS, or do it in a terminal.')) : null,
    h('label.fieldrow', h('span.field-label', 'The password of your account on this computer'), input, h('span.hint', 'Used once for this, not saved.')),
    err,
    h('div.sheet-actions',
      h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'),
      h(`button.btn.${plain ? 'secondary' : 'primary'}`, { type: 'submit' }, plain ? 'Send it anyway' : VERB[action])));
  });
}

export function mount(root, { machine }) {
  const call = (p, body) => api(at(machine, p), body);
  let scope = null;
  let data = null;
  let q = '';
  let group = 'all';
  let chosen = null; // the service whose log is shown
  const busy = new Set(); // names with an action on the way
  const note = h('div');
  const status = h('span.dapp-status', { role: 'status' });
  const scopeBox = h('span');
  const t = table('Services', [
    { key: 'name', label: 'Name', w: 'minmax(150px, 1.3fr)', narrow: 'minmax(0, 1fr)' },
    { key: 'description', label: 'What it is', w: 'minmax(120px, 1.6fr)', narrow: false },
    { key: 'group', label: 'State', w: '104px', narrow: 'auto' },
    { key: 'enabled', label: 'Starts with the computer', w: '104px', narrow: false },
    { key: 'act', label: '', sort: false, w: '178px', narrow: 'auto' },
  ], { sort: { key: 'name', desc: false }, onSort: () => draw() });
  const logHead = h('div.dapp-loghead');
  const logBody = h('pre.dapp-log.mono', { tabindex: '0' });
  const logPane = h('section.dapp-logpane.hidden', { 'aria-label': 'The service\'s log' }, logHead, logBody);

  // Each button carries the scope of the list its row came from: an action always goes to that list's service.
  const actBtn = (s, sc, action, ic) => h('button.btn.secondary.small.dapp-act', { type: 'button', title: `${VERB[action]} ${s.name}`, 'aria-label': `${VERB[action]} ${s.name}`, disabled: busy.has(s.name), dataset: { scope: sc }, onclick: (e) => {
    e.stopPropagation();
    act(s, sc, action);
  } }, icon(ic, { size: 14 }), h('span.dapp-word', VERB[action]));
  function actions(s, sc) {
    if (s.own) return h('span.badge.soft', { title: 'This dashboard runs in it: it is changed in a terminal, not here' }, 'this dashboard');
    if (data.readOnly) return null;
    const g = groupOf(s);
    return h('span.dapp-acts', g === 'running' ? [actBtn(s, sc, 'restart', 'refresh'), actBtn(s, sc, 'stop', 'stop')] : actBtn(s, sc, 'start', 'play'));
  }
  function draw() {
    if (!data) return;
    const sc = data.scope;
    const s = q.trim().toLowerCase();
    const found = data.services.map((x) => ({ ...x, group: groupOf(x) }))
      .filter((x) => (group === 'all' || x.group === group) && (!s || `${x.name} ${x.description}`.toLowerCase().includes(s)));
    t.draw(sortBy(found, t.sort.key, t.sort.desc).map((x) => ({
      key: x.name,
      cls: chosen === x.name ? 'dapp-picked' : null,
      cells: [
        h('button.dapp-link', { type: 'button', title: `Show the log of ${x.name}`, dataset: { scope: sc }, onclick: () => showLog(x.name, sc) }, h('span.dapp-link-text', x.name), x.ssh ? h('span.badge.soft', 'SSH') : null),
        h('span.dapp-dim', { title: x.description }, x.description || '–'),
        h(`span.pill.dapp-st-${x.group}`, { title: `systemd: ${x.active}${x.sub && x.sub !== x.active ? ` (${x.sub})` : ''}` }, h('span.dot'), h('span.dapp-st-word', STATE_WORD[x.group])),
        h('span.dapp-dim', { title: x.enabled ? `systemd: ${x.enabled}` : '' }, START_WORD[x.enabled] || x.enabled || '–'),
        actions(x, sc),
      ],
    })));
    status.textContent = `${found.length} of ${data.services.length}`;
  }

  async function load() {
    const asked = scope;
    let got;
    try {
      got = await call(`/api/services${asked ? `?scope=${encodeURIComponent(asked)}` : ''}`);
    } catch (e) {
      fill(note, errorLine(e));
      return;
    }
    // The switch moved on while this was on its way: this answer is the other list's, and is dropped.
    if (asked !== scope) return; // (the switch asked for its own list already: it comes right after this one)
    data = got;
    if (!scope) {
      scope = data.scope;
      fill(scopeBox, data.scopes.length > 1 ? choice('Whose services', data.scopes.map((x) => [x, x === 'user' ? 'Yours' : 'The system\'s']), scope, (v) => {
        scope = v;
        data = null;
        chosen = null;
        logPane.classList.add('hidden');
        t.draw([]);
        list.now();
      }) : null);
    }
    fill(note,
      data.note ? h('div.banner.muted', h('span', data.note)) : null,
      data.readOnly ? h('div.banner.info', icon('info', { size: 18 }), h('span', 'Read-only here: on this computer a service is changed in a terminal opened as administrator.')) : null,
      scope === 'system' && !data.readOnly ? h('p.hint.dapp-hint', 'Changing one of the system\'s services asks for this computer\'s password.') : null);
    draw();
  }

  async function act(s, sc, action) {
    // A stop or a restart is said first (SSH and the like ask for their name instead, on the server's word).
    if (ASK[action] && !s.critical) {
      const yes = await confirmSheet({ title: `${VERB[action]} ${s.name}?`, text: ASK[action](s.name), ok: VERB[action], danger: action === 'stop' });
      if (!yes) return;
    }
    let extra = {};
    busy.add(s.name);
    draw();
    try {
      for (;;) {
        let r;
        try {
          r = await call('/api/services/action', { scope: sc, name: s.name, action, ...extra });
        } catch (e) {
          if (e.code === 'plain-leg') await plainLegSheet({ label: machine || undefined, page: e.data.page || null });
          else toast(errorText(e), { kind: 'error', ms: 8000 });
          return;
        }
        if (r.ok) {
          toast(`${s.name} ${DONE[action]}.`);
          if (chosen === s.name) showLog(s.name, sc);
          return;
        }
        if (r.needsConfirm) {
          const typed = await promptSheet({ title: `${VERB[action]} ${s.name}?`, text: `${r.why} To go on, type ${s.name}.`, ok: VERB[action], placeholder: s.name, danger: true,
            label: `Type ${s.name} to confirm`, check: (v) => (v.trim() === s.name ? '' : `Type ${s.name} exactly.`) });
          if (typed === null) return;
          extra = { ...extra, confirm: s.name };
          continue;
        }
        if (r.needsPassword && r.notAllowed) {
          toast('This account may not use administrator rights (sudo) on this computer.', { kind: 'error', ms: 9000 });
          return;
        }
        if (r.needsPassword && r.plainLeg) {
          await plainLegSheet({ label: machine || undefined });
          return;
        }
        if (r.needsPassword) {
          const pw = await passwordFor(action, s.name, r.wrong === true);
          if (pw === null) return;
          extra = { ...extra, password: pw };
          continue;
        }
        return;
      }
    } finally {
      busy.delete(s.name);
      list.now();
    }
  }

  async function showLog(name, sc = data && data.scope) {
    chosen = name;
    draw();
    logPane.classList.remove('hidden');
    fill(logHead, h('strong', name), h('span.hint', `the last ${LOG_LINES} lines`), h('span.desk-grow'),
      h('button.dapp-btn', { type: 'button', title: 'Read again', 'aria-label': 'Read the log again', onclick: () => showLog(name, sc) }, icon('refresh', { size: 14 })),
      h('button.dapp-btn', { type: 'button', title: 'Close the log', 'aria-label': 'Close the log', onclick: () => {
        chosen = null;
        logPane.classList.add('hidden');
        draw();
      } }, icon('x', { size: 14 })));
    logBody.textContent = 'Reading…';
    try {
      const r = await call(`/api/services/logs?scope=${encodeURIComponent(sc)}&name=${encodeURIComponent(name)}&lines=${LOG_LINES}`);
      if (chosen !== name) return;
      const lines = (r.entries || []).map((e) => `${when(e.time)}  ${e.message}`);
      logBody.textContent = lines.length ? lines.join('\n') : r.note || 'Nothing in its log.';
      if (r.note && lines.length) logBody.textContent += `\n\n(${r.note})`;
      logBody.scrollTop = logBody.scrollHeight;
    } catch (e) {
      if (chosen === name) logBody.textContent = errorText(e);
    }
  }

  fill(root,
    h('div.dapp-bar', scopeBox, choice('State', STATES, group, (v) => {
      group = v;
      draw();
    }), filterField('Filter services', (v) => {
      q = v;
      draw();
    }), status),
    note, h('div.dapp-split', t.el, logPane));
  root.classList.add('dapp-services');
  const list = poll(root, load, 5000);
  return () => (list.stop(), t.stop());
}
