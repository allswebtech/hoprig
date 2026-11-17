// Automations (#/automations/<tab>): things the dashboard does by itself, by fixed rules, without AI (src/automation).
// One page per computer, in four parts, each with its own address:
//   Schedules  (#/automations, the first)   the list, "Add schedule", a form that reads like a sentence
//   Queue      (#/automations/queue)        the messages waiting per session (added from a session's "Queue" button)
//   Rules      (#/automations/rules)        one switch per automation, in two groups
//   Activity   (#/automations/activity)     what the automations did, newest first, in plain sentences
// "Pause all automations", rarely used, is under Rules → Advanced; while it is on, a banner with Resume says so on
// every part.
// The same file brings the session view's "Queue" button and the "3 queued" badge on Home's session cards.
import { icon } from './icons.js';
import { TOOL_NAMES, ago, api, at, btn, chooseSheet, confirmSheet, fill, h, isCodingCard, link, machine, needsYouFirst, openSheet, servesTool, stateOf, tildePath, toast } from './lib.js';
import { chatTools } from './chat/start.js';
import { registerCardBadge, registerPage, registerSessionAction } from './registry.js';
import { emptyState, errorBox, fold, groupHead, panel, savedMark, tabBar, toggle } from './shell.js';
import { store } from './store.js';
import { accountLabel, providerLine } from './providerword.js';
import './addons.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TABS = [
  ['schedules', 'Schedules', 'clock'],
  ['queue', 'Queue', 'send'],
  ['rules', 'Rules', 'zap'],
  ['activity', 'Activity', 'text'],
];
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const folderName = (dir) => String(dir || '').split(/[\\/]/).filter(Boolean).pop() || dir || '';

// ---------- words (exported for the tests) ----------

/** "Every day at 08:30", "Weekdays at 18:00", "Mon, Wed at 09:00", "Once, Sat 15 Nov at 10:00". */
export function whenText(w) {
  if (w.kind === 'daily') return `Every day at ${w.time}`;
  if (w.kind === 'weekly') {
    const d = [...w.days].sort().join(',');
    if (d === '1,2,3,4,5') return `Weekdays at ${w.time}`;
    if (d === '0,6') return `Weekends at ${w.time}`;
    if (d === '0,1,2,3,4,5,6') return `Every day at ${w.time}`;
    if (w.days.length === 1) return `Every ${DAY_NAMES[w.days[0]]} at ${w.time}`;
    return `${[...w.days].sort().map((x) => DAYS[x]).join(', ')} at ${w.time}`;
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(w.date || '') ? new Date(`${w.date}T00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : 'a day to pick';
  return `Once, ${date} at ${w.time}`;
}

/**
 * "start a chat in api-server on Auto mode" / "send a message to data-pipeline". `accountLabel(name)` gives a
 * provider's display name, `sessionLabel(name)` a session's (a chat is "chat:<id>": its title). o.named: the computer
 * offers more than one coding tool, so the sentence names Claude Code too ("start Claude Code in a terminal").
 */
export function whatText(a, accountLabel = (n) => n, sessionLabel = (n) => (n.startsWith('chat:') ? 'a chat' : n), o = {}) {
  if (a.type === 'start') {
    const where = folderName(a.dir);
    const chat = a.in === 'chat';
    const other = chat && a.tool && a.tool !== 'claude';
    const what = !o.named ? (chat ? 'a chat' : 'a session') + (other ? ` with ${TOOL_NAMES[a.tool] || a.tool}` : '')
      : chat ? `a chat with ${other ? TOOL_NAMES[a.tool] || a.tool : 'Claude Code'}` : 'Claude Code in a terminal';
    return `start ${what}${where ? ` in ${where}` : ''}${a.profile ? ` on ${accountLabel(a.profile)}` : ''}`;
  }
  return `send a message to ${a.session ? sessionLabel(a.session) : 'a session'}`;
}

/** The whole schedule as one sentence: "Every day at 08:30, start a session in api-server on Auto mode." */
export const scheduleSentence = (s, accountLabel, sessionLabel, o = {}) => `${whenText(s.when)}, ${whatText(s.action, accountLabel, sessionLabel, o)}.`;

const WHO = { queue: 'Queue', schedules: 'Schedule', restore: 'Reopen after a restart', retry: 'Try again', updates: 'Updates', idle: 'Housekeeping', hub: 'Another dashboard' };

/**
 * One line of Activity in plain words: { title, sub, problem } — the title says what happened as a sentence, `problem`
 * (or null) what went wrong. `sessionLabel(name)`: a session as a person reads it (a chat is "chat:<id>": its title,
 * else "a chat"; never its id).
 */
export function activityLine(e, sessionLabel = (n) => (n.startsWith('chat:') ? 'a chat' : n)) {
  const did = String(e.did || '').trim();
  const title = `${cap(did)}${/[.!?]$/.test(did) ? '' : '.'}`;
  // Lines written before the wording was plain named a setting by its key; said in the page's words instead.
  const o = String(e.outcome || 'ok').replace(/\(not saved in the brain's history: the commitMap switch is off\)/, 'not saved in the AI brain\'s history (Settings → Workspace: "Save a change of the map" is off)');
  const problem = /^failed/.test(o) ? `It did not work${o.slice(6) ? `: ${o.replace(/^failed:?\s*/, '')}` : ''}.`
    : /^gave up/.test(o) ? 'It gave up; open the session to see why.'
      : /^missed/.test(o) ? `Missed: ${o.replace(/^missed:?\s*/, '')}.`
        : null;
  const note = problem || o === 'ok' ? null : cap(o.replace(/:\s*/, ': '));
  return { title, sub: [WHO[e.automation] || cap(e.automation), e.session ? sessionLabel(String(e.session)) : null, note].filter(Boolean).join(' · '), problem };
}

const GAINED = /^The map gained (.+)$/;
const and = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);

/**
 * Entries one after another as one row: [{ e, n }], `e` the newest (the log is newest first). The same sentence
 * again is one row with how many times (n). Several "The map gained …" of one round (the same outcome, within a
 * minute) are one sentence: "The map gained api-server, docs-site and mobile-app".
 */
export function foldActivity(entries) {
  const out = [];
  const kin = (a, b) => a.automation === b.automation && (a.session || '') === (b.session || '') && a.outcome === b.outcome;
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && kin(last.e, e) && last.e.did === e.did && !last.gained) {
      last.n++;
      continue;
    }
    const g = GAINED.exec(String(e.did || ''));
    const near = last && Math.abs(Date.parse(last.at) - Date.parse(e.time)) <= 60_000;
    if (g && last && last.gained && kin(last.e, e) && near) {
      if (!last.gained.includes(g[1])) last.gained.push(g[1]);
      last.e = { ...last.e, did: `The map gained ${and([...last.gained].reverse())}` };
      last.at = e.time;
      continue;
    }
    out.push({ e, n: 1, ...(g ? { gained: [g[1]], at: e.time } : {}) });
  }
  return out.map(({ e, n }) => ({ e, n }));
}

// ---------- the data of the open computer: kept per computer, so a part draws at once when it was seen before ----------
const cache = new Map(); // computer key → GET /api/automation
const keyOf = () => machine.current || '~';


/** Save automation settings; resolves the new status or throws after saying why. */
async function saveSettings(patch) {
  try {
    await api('/api/automation/settings', patch);
    const st = await api('/api/automation');
    cache.set(keyOf(), st);
    return st;
  } catch (e) {
    toast(`${e.message}. Nothing was changed; try again.`, { kind: 'error', ms: 6000 });
    throw e;
  }
}

const loading = (text = 'Loading…') => h('div.empty.compact.au-loading', h('div.spinner', { 'aria-hidden': 'true' }), h('p', text));

// ---------- the page ----------
function viewAutomations({ frame, sub }) {
  const tab = TABS.find((t) => t[0] === sub) ? sub : sub ? null : 'schedules';
  if (!tab) {
    location.replace(link('#/automations'));
    return () => {};
  }
  let alive = true;
  const isAlive = () => alive;
  const bannerSlot = h('div.au-banner');
  const content = h('div.au-content');
  const tabs = tabBar('Parts of Automations', TABS.map(([id, label, ic]) => ({ id, label, icon: ic, href: link(id === 'schedules' ? '#/automations' : `#/automations/${id}`) })), tab);

  const addSchedule = (preset = null) => scheduleForm(null, preset).then((ok) => ok && load());
  frame({
    title: 'Automations',
    page: 'automations',
    intro: 'What the dashboard does for you by fixed rules, without AI.',
    primary: tab === 'schedules' ? { label: 'Add schedule', icon: 'plus', onclick: () => addSchedule() } : null,
    body: [tabs, bannerSlot, content],
  });

  const setPaused = async (v) => {
    const next = await saveSettings({ paused: v });
    paintBanner(next);
    if (tab === 'rules') paintContent(next);
  };
  /** The rare switch, for Rules → Advanced (on a card, as every rule above it is). */
  function pauseRow(st) {
    const row = toggle('Pause all automations', !!st.settings.paused, async (v) => {
      try {
        await setPaused(v);
      } catch (e) {
        row.querySelector('input').checked = !v;
        throw e;
      }
    }, 'Nothing is sent, started, closed or updated by itself while this is on. Your schedules and queues are kept.');
    return row;
  }
  function paintBanner(st) {
    fill(bannerSlot, st && st.settings.paused
      ? h('div.banner.warn.au-inline', { role: 'status' }, icon('alert', { size: 18 }), h('span', 'All automations are paused. Nothing runs by itself until you resume them.'),
        btn('small secondary', { label: 'Resume', onclick: () => setPaused(false).catch(() => {}) }))
      : null);
  }
  function paintContent(st) {
    if (tab === 'schedules') return fill(content, schedulesPart(st, { reload: load, addSchedule }));
    if (tab === 'queue') return fill(content, queuePart(st, load));
    if (tab === 'rules') return fill(content, rulesPart(st, (next) => { paintBanner(next); }), fold('automations-advanced', 'Advanced', panel({}, pauseRow(st))));
    return activityPart(content, isAlive);
  }

  async function load() {
    let st;
    try {
      st = await api('/api/automation');
    } catch (e) {
      if (!alive) return;
      if (!cache.get(keyOf())) {
        fill(content, errorBox(`Could not load the automations: ${e.message}`, load));
      } else toast(`Could not refresh: ${e.message}`, { kind: 'error' });
      return;
    }
    if (!alive) return;
    cache.set(keyOf(), st);
    paintBanner(st);
    paintContent(st);
  }

  const seen = cache.get(keyOf());
  paintBanner(seen || null);
  if (seen) paintContent(seen);
  else fill(content, loading());
  load();
  return () => {
    alive = false;
  };
}

registerPage({ id: 'automations', title: 'Automations', icon: 'clock', group: 'more', order: 10, perComputer: true, render: viewAutomations });

// ---------- Schedules ----------

function schedulesPart(st, { reload, addSchedule }) {
  const off = !st.settings.schedules.enabled;
  const turnOn = async () => {
    try {
      await saveSettings({ schedules: { enabled: true } });
      toast('Schedules are on again');
      reload();
    } catch {
      /* said why */
    }
  };
  const offBanner = off
    ? h('div.banner.info.au-inline', icon('info', { size: 18 }), h('span', 'Schedules are turned off, so none of these runs.'), btn('small secondary', { label: 'Turn schedules on', onclick: turnOn }))
    : null;
  if (!st.schedules.length) {
    const example = {
      label: 'Morning dependency check',
      when: { kind: 'weekly', time: '08:30', days: [1, 2, 3, 4, 5] },
      prompt: 'Check for outdated dependencies and write a short summary',
    };
    return [offBanner, h('div.au-empty',
      emptyState('clock', 'No schedules yet. A schedule starts a session or sends a message at a set time, for example:'),
      h('p.au-example', '“Weekdays at 08:30, start a session in my project that checks for outdated dependencies.”'),
      btn('secondary', { icon: 'pencil', label: 'Start from this example', onclick: () => addSchedule(example) }))];
  }
  const list = st.schedules.map((s) => scheduleRow(s, reload, st.timeZone));
  return [
    offBanner,
    groupHead('Schedules', st.schedules.length),
    h('div.rows', list),
    h('p.hint.au-foot', 'Times are this computer\'s clock. A message waits in the session\'s queue (a chat queues it itself), so it never interrupts a reply. A run missed while the computer was off still runs if it is less than 2 hours late.'),
  ];
}

/**
 * When a schedule runs next, always as a day and the 24-hour clock its rule is written in ("today 18:00",
 * "tomorrow 08:30", "Tue 08:30", "21 Nov 08:30"): one list never mixes "in 7 h 1 min" with "Tue 08:30". The day and
 * the clock are the computer's (`timeZone`, from the server), as its rule sentence is, also when the page is opened
 * from another time zone; without it, the browser's. A time already past (a page left open) says its day too.
 */
export function nextRunText(ms, now = Date.now(), timeZone = undefined) {
  const opts = { hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' };
  let zone = timeZone;
  let f;
  try {
    f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: zone });
  } catch {
    zone = undefined; // a zone this browser does not know: its own clock
    f = new Intl.DateTimeFormat('en-US', opts);
  }
  const parts = (t) => Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  const a = parts(ms);
  const dayNo = (p) => Date.UTC(p.year, p.month - 1, p.day) / 86_400_000;
  const days = dayNo(a) - dayNo(parts(now));
  const two = (n) => String(n).padStart(2, '0');
  const name = (o) => new Date(ms).toLocaleDateString([], { ...o, timeZone: zone });
  const day = days === 0 ? 'today' : days === 1 ? 'tomorrow' : days === -1 ? 'yesterday' : days > 1 && days < 7 ? name({ weekday: 'short' }) : name({ day: 'numeric', month: 'short' });
  return `${day} ${two(a.hour % 24)}:${two(a.minute)}`; // % 24: an engine that writes midnight as 24
}

function scheduleRow(s, reload, timeZone) {
  const mark = savedMark();
  const line = providerLine((label) => scheduleSentence(s, label));
  const next = !s.enabled ? 'Off' : s.nextAt ? `Next run ${nextRunText(s.nextAt, Date.now(), timeZone)}` : 'Done: it ran once';
  const turn = async (e) => {
    const on = e.target.checked;
    try {
      const { id, nextAt, lastAt, since, ...rest } = s;
      await api('/api/automation/schedules', { op: 'change', id, schedule: { ...rest, enabled: on } });
      mark.show(on ? 'On' : 'Off');
      setTimeout(reload, 900);
    } catch (err) {
      e.target.checked = !on;
      toast(`${err.message}. Nothing was changed.`, { kind: 'error', ms: 6000 });
    }
  };
  const remove = async () => {
    if (!(await confirmSheet({ title: 'Remove this schedule?', text: `${s.label ? `${s.label}: ` : ''}${line.textContent} It will not run again.`, ok: 'Remove', danger: true }))) return;
    try {
      await api('/api/automation/schedules', { op: 'delete', id: s.id });
      toast('Schedule removed');
    } catch (e) {
      toast(`${e.message}. The schedule is still there.`, { kind: 'error', ms: 6000 });
    }
    reload();
  };
  return h(`div.row.static.au-sched${s.enabled ? '' : '.off'}`,
    h('span.row-icon', icon('clock')),
    h('div.au-sched-main',
      h('span.row-title', s.label || line, mark),
      s.label ? h('span.au-sentence-line', line) : null,
      h('span.row-sub', next, s.lastAt ? ` · last ran ${ago(s.lastAt)}` : ''),
      h('div.au-sched-actions',
        btn('small ghost', { icon: 'pencil', label: 'Change', onclick: async () => (await scheduleForm(s)) && reload() }),
        btn('small ghost', { icon: 'trash', label: 'Remove', onclick: remove }))),
    h('input.switch', { type: 'checkbox', role: 'switch', checked: s.enabled, 'aria-label': `${s.label || 'This schedule'}: on or off`, onchange: turn }));
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The add / change form. `preset` fills a new one (the example). Resolves true when saved. */
async function scheduleForm(old, preset = null) {
  const d = store.data || { sessions: [], profiles: [] };
  // The projects to pick from, recent first, as New session lists them; "Another folder" types one.
  const [recent, proj, tools] = await Promise.all([
    api('/api/folders/recent').catch(() => ({ folders: [] })),
    api('/api/pcsetup/projects').catch(() => null), // an older computer, or no projects folder
    chatTools(), // the coding tools a chat can run on the open computer (Claude Code alone on most)
  ]);
  const folders = [...new Set([
    ...recent.folders.map((f) => f.path),
    ...(proj ? [...proj.workspaces.flatMap((w) => w.repos.map((r) => r.dir)), ...proj.repos.map((r) => r.dir)] : []),
  ])];
  // A schedule starts Claude Code in a terminal, or a chat in its coding tool: only the providers that serve that tool.
  const toolOf = (a) => (a.in === 'chat' && a.tool ? a.tool : 'claude');
  const accountsFor = (tool) => (d.profiles || []).filter((p) => servesTool(p, tool)).map((p) => [p.name, p.virtual ? 'Auto mode (the next provider at a limit)' : p.label]);
  // The provider a new schedule names first: the computer's default for that coding tool (src/defaultprovider.mjs:
  // `recommended`, another tool's in `toolDefaults`), else the first that serves it.
  const firstFor = (tool) => {
    const list = accountsFor(tool);
    const rec = tool === 'claude' ? d.recommended : d.toolDefaults && d.toolDefaults[tool] ? d.toolDefaults[tool].recommended : null;
    return (tool === 'claude' ? rec : list.some(([n]) => n === rec) && rec) || (list[0] || [''])[0];
  };
  const firstAccount = firstFor('claude');
  // Where a message can go: the coding sessions in a terminal and the open chats (by their title).
  const targets = (d.sessions || []).filter((x) => isCodingCard(x) || x.kind === 'chat')
    .map((x) => [x.name, x.kind === 'chat' ? `Chat: ${x.title || x.display || 'New chat'}` : x.name]);
  const claudeSessions = targets.map(([n]) => n);
  const sessionLabel = (n) => (targets.find(([x]) => x === n) || [null, n.startsWith('chat:') ? 'a chat' : n])[1].replace(/^Chat: (.*)$/, 'the chat "$1"');
  const tomorrow = ymd(new Date(Date.now() + 86_400_000));
  const s = old
    ? JSON.parse(JSON.stringify({ label: old.label || '', when: old.when, action: old.action, enabled: old.enabled }))
    : {
      label: (preset && preset.label) || '',
      enabled: true,
      when: (preset && preset.when) || { kind: 'daily', time: '09:00' },
      action: { type: 'start', in: 'chat', dir: folders[0] || '', profile: firstAccount, prompt: (preset && preset.prompt) || '' },
    };
  return openSheet({ title: old ? 'Change schedule' : 'New schedule', subtitle: 'Read the sentence: that is what will happen.', wide: true }, (close) => {
    const err = h('p.form-error', { role: 'alert' });
    const sentence = h('p.au-sentence', { 'aria-live': 'polite' });
    const paintSentence = () => (sentence.textContent = scheduleSentence(s, accountLabel, sessionLabel, { named: tools.length > 1 }));
    const whenBox = h('div.au-form-part');
    const whatBox = h('div.au-form-part');
    const seg = (label, options, cur, pick) => h('div.segmented', { role: 'radiogroup', 'aria-label': label },
      options.map(([v, t]) => h('button.seg', { type: 'button', role: 'radio', 'aria-checked': String(cur === v), onclick: () => pick(v) }, h('span', t))));
    const paintWhen = () => {
      const w = s.when;
      fill(whenBox,
        seg('How often', [['daily', 'Every day'], ['weekly', 'On some days'], ['once', 'Once']], w.kind, (k) => {
          s.when = k === 'once' ? { kind: k, time: w.time, date: tomorrow } : k === 'weekly' ? { kind: k, time: w.time, days: [1, 2, 3, 4, 5] } : { kind: k, time: w.time };
          paintWhen();
          paintSentence();
        }),
        w.kind === 'weekly'
          ? h('div.checks.au-days', { role: 'group', 'aria-label': 'Days' }, DAYS.map((name, i) => h('label.check', h('input', { type: 'checkbox', checked: w.days.includes(i), onchange: (e) => { w.days = e.target.checked ? [...w.days, i].sort() : w.days.filter((x) => x !== i); } }), h('span', name))))
          : null,
        h('div.au-inline-fields',
          w.kind === 'once' ? h('label.fieldrow', h('span.field-label', 'Day'), h('input.field', { type: 'date', value: w.date, min: ymd(new Date()), oninput: (e) => (w.date = e.target.value) })) : null,
          h('label.fieldrow', h('span.field-label', 'At'), h('input.field', { type: 'time', value: w.time, required: true, oninput: (e) => (w.time = e.target.value) }))));
    };
    // A project from the list, or "Another folder…" with a box to type its path.
    const folderPick = (a) => {
      const other = h('input.field', { value: folders.includes(a.dir) ? '' : tildePath(a.dir), placeholder: '~/projects/my-app', 'aria-label': 'Folder path', autocapitalize: 'off', spellcheck: 'false',
        oninput: (e) => (a.dir = e.target.value.trim()) });
      const typed = !folders.length || (a.dir && !folders.includes(a.dir));
      other.classList.toggle('hidden', !typed);
      const sel = h('select.field', { 'aria-label': 'In the folder', onchange: (e) => {
        const v = e.target.value;
        other.classList.toggle('hidden', v !== '');
        a.dir = v || other.value.trim();
        if (v === '') other.focus();
      } },
      folders.map((f) => h('option', { value: f, selected: f === a.dir }, `${folderName(f)} — ${tildePath(f)}`)),
      h('option', { value: '', selected: typed }, 'Another folder…'));
      return h('div.fieldrow', h('span.field-label', 'In the folder'), sel, other);
    };
    const paintWhat = () => {
      const a = s.action;
      fill(whatBox,
        seg('What it does', [['start', 'Start a session'], ['send', 'Send a message']], a.type, (t) => {
          s.action = t === 'start' ? { type: 'start', in: 'chat', dir: folders[0] || '', profile: firstAccount, prompt: '' } : { type: 'send', session: claudeSessions[0] || '', text: '' };
          paintWhat();
          paintSentence();
        }),
        a.type === 'start'
          ? [
            h('div.field-label', 'Open in'),
            seg('Open in', [['chat', 'A chat'], ['terminal', 'A terminal']], a.in === 'chat' ? 'chat' : 'terminal', (v) => {
              if (v === 'chat') a.in = 'chat';
              else {
                delete a.in;
                delete a.tool; // a terminal a schedule starts runs Claude Code
                if (!accountsFor('claude').some(([n]) => n === a.profile)) a.profile = firstAccount;
              }
              paintWhat();
              paintSentence();
            }),
            // Where more than one coding tool is offered: a terminal a schedule starts is Claude Code's, said so.
            a.in !== 'chat' && tools.length > 1 ? h('p.hint', 'A schedule starts Claude Code in a terminal; for another coding tool, choose A chat.') : null,
            // The coding tool of the chat, where this computer offers more than one.
            a.in === 'chat' && tools.length > 1 ? [
              h('div.field-label', 'Coding tool'),
              seg('Coding tool', tools.map((t) => [t.id, t.name]), toolOf(a), (v) => {
                if (v === 'claude') delete a.tool;
                else a.tool = v;
                if (!accountsFor(v).some(([n]) => n === a.profile)) a.profile = firstFor(v);
                paintWhat();
                paintSentence();
              }),
            ] : null,
            folderPick(a),
            accountsFor(toolOf(a)).length
              ? h('label.fieldrow', h('span.field-label', 'On the provider'),
                h('select.field', { onchange: (e) => { a.profile = e.target.value; paintSentence(); } }, accountsFor(toolOf(a)).map(([v, t]) => h('option', { value: v, selected: v === a.profile }, t))))
              : h('p.hint', `No provider serves ${TOOL_NAMES[toolOf(a)] || toolOf(a)} yet: add one under Providers.`),
            h('label.fieldrow', h('span.field-label', 'First message (optional)'),
              h('textarea.field', { rows: 2, value: a.prompt || '', placeholder: `What ${toolOf(a) === 'claude' ? 'Claude' : TOOL_NAMES[toolOf(a)] || 'it'} should start with`, oninput: (e) => (a.prompt = e.target.value) })),
          ]
          : [
            claudeSessions.length || a.session
              ? h('label.fieldrow', h('span.field-label', 'To the session'),
                h('select.field', { onchange: (e) => { a.session = e.target.value; paintSentence(); } },
                  [...new Set([a.session, ...claudeSessions].filter(Boolean))].map((n) => h('option', { value: n, selected: n === a.session }, (targets.find(([x]) => x === n) || [n, n])[1]))))
              : h('p.hint', 'No session of a coding tool is open on this computer. Start one first, or pick "Start a session".'),
            h('label.fieldrow', h('span.field-label', 'Message'),
              h('textarea.field', { rows: 2, value: a.text || '', required: true, placeholder: 'run the tests and fix what fails', oninput: (e) => (a.text = e.target.value) })),
          ]);
    };
    paintWhen();
    paintWhat();
    paintSentence();
    const form = h('form.au-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const schedule = { ...s, label: s.label.trim() };
        if (!schedule.label) delete schedule.label;
        if (schedule.action.type === 'start' && !schedule.action.prompt) delete schedule.action.prompt;
        if (schedule.when.kind === 'weekly' && !schedule.when.days.length) {
          err.textContent = 'Pick at least one day.';
          return;
        }
        try {
          await api('/api/automation/schedules', old ? { op: 'change', id: old.id, schedule } : { op: 'add', schedule });
          toast(old ? 'Schedule saved' : 'Schedule added');
          close(true);
        } catch (x) {
          err.textContent = `${cap(x.message)}. Change it above and save again.`;
        }
      },
    },
    sentence,
    h('div.field-label', 'When'), whenBox,
    h('div.field-label', 'What'), whatBox,
    h('label.fieldrow', h('span.field-label', 'Name (optional)'), h('input.field', { value: s.label, maxlength: 60, placeholder: 'Morning checks', oninput: (e) => (s.label = e.target.value) })),
    err,
    h('div.sheet-actions',
      h('button.btn.secondary', { type: 'button', onclick: () => close(false) }, 'Cancel'),
      h('button.btn.primary', { type: 'submit' }, old ? 'Save' : 'Add schedule')));
    // Every change of a field shows in the sentence at once.
    form.addEventListener('input', paintSentence);
    form.addEventListener('change', paintSentence);
    return form;
  }).then((v) => v === true);
}

// ---------- Queue ----------

function queuePart(st, reload) {
  const rows = Object.entries(st.queues || {}).filter(([, q]) => q.count || q.paused).sort((a, b) => b[1].count - a[1].count);
  const off = !st.settings.queue.enabled;
  return [
    off ? h('p.banner.info', icon('info', { size: 18 }), h('span', 'Sending the next queued message is turned off under Rules, so queued messages wait.')) : null,
    h('div.savebar.start', btn('primary', { icon: 'plus', label: 'Queue a message', onclick: () => queueFor(reload) })),
    rows.length
      ? [groupHead('Sessions with a queue', rows.length),
        h('div.rows', rows.map(([name, q]) => h('button.row.au-queue', { type: 'button', onclick: () => queueSheet(name, reload) },
          h('span.row-icon', icon('send')),
          h('span.row-main',
            h('span.row-title', name),
            h('span.row-sub', `${q.count} ${q.count === 1 ? 'message waits' : 'messages wait'}${q.paused ? ' · paused: nothing is sent until you resume' : q.waits ? ` · ${q.waits}` : ' · sent one per finished reply'}`)),
          h('span.row-end', icon('chevronRight', { size: 18 })))))]
      : emptyState('send', 'Nothing is queued. A queue holds your next messages for a session and sends one each time a reply ends.'),
    h('p.hint.au-foot', 'Tap a session to see, reorder or remove what waits. A session\'s more button (…) has Queue as well.'),
  ];
}

/** The coding sessions of the open computer a message can be queued for, the ones that need you first. */
export function queueChoices(sessions, queues = {}) {
  return sessions.filter(isCodingCard).sort(needsYouFirst).map((x) => {
    const q = queues[x.name];
    return { value: x.name, label: x.display || x.name, icon: 'sparkle',
      sub: `${stateOf(x).text}${q && q.count ? ` · ${q.count} queued` : ''}` };
  });
}

/** "Queue a message": pick the session, then its queue sheet with the message box ready. */
async function queueFor(reload) {
  const d = store.data || { sessions: [] };
  let queues = {};
  try {
    queues = (await api('/api/automation')).queues || {};
  } catch {
    /* the counts are only a help */
  }
  const items = queueChoices(d.sessions || [], queues);
  if (!items.length) return toast('No session of a coding tool runs on this computer. Start one first.', { kind: 'info' });
  const name = items.length === 1 ? items[0].value : await chooseSheet({ title: 'Queue a message for', subtitle: 'Sent when its current reply ends', items });
  if (name) queueSheet(name, reload);
}

// ---------- Rules ----------

/** One rule with a choice at its end instead of a switch. */
function choiceRow(label, value, options, onchange, hint) {
  const mark = savedMark();
  const sel = h('select.field.au-select', { 'aria-label': label, onchange: async (e) => {
    try {
      await onchange(e.target.value);
      mark.show();
    } catch {
      e.target.value = String(value);
    }
  } }, options.map(([v, t]) => h('option', { value: String(v), selected: String(v) === String(value) }, t)));
  return h('div.switchrow.au-choice', h('span.switchrow-text', h('span.switchrow-label', label, mark), hint ? h('span.hint', hint) : null), sel);
}

function rulesPart(st, after) {
  const s = st.settings;
  const set = async (patch) => {
    const next = await saveSettings(patch);
    after(next);
    return next;
  };
  // A switch that says "Saved" when the change is kept, and goes back when it was not.
  const rule = (label, on, patch, hint, done = () => {}) => {
    const row = toggle(label, on, async (v) => {
      try {
        await set(patch(v));
        done(v);
      } catch (e) {
        row.querySelector('input').checked = !v;
        throw e;
      }
    }, hint);
    return row;
  };
  const hours = [1, 2, 4, 8, 12, 24, 48, 168].map((n) => [n, n === 168 ? 'a week' : `${n} ${n === 1 ? 'hour' : 'hours'}`]);
  const minutes = [15, 30, 60, 120, 240].map((n) => [n, n < 60 ? `${n} minutes` : `${n / 60} ${n === 60 ? 'hour' : 'hours'}`]);
  const idleShells = h('div.au-sub', choiceRow('Quiet for', s.idle.shellHours, hours, (v) => set({ idle: { shellHours: Number(v) } })));
  const idleGateway = h('div.au-sub', choiceRow('Unused for', s.idle.gatewayMinutes, minutes, (v) => set({ idle: { gatewayMinutes: Number(v) } })));
  idleShells.hidden = !s.idle.shells;
  idleGateway.hidden = !s.idle.gateway;
  return [
    panel({ icon: 'clock', title: 'While you are away', desc: 'Keep the work going when you are not watching.' },
      rule('Send the next queued message', s.queue.enabled, (v) => ({ queue: { enabled: v } }),
        'Each time a reply ends, the next message from that session\'s queue is sent.'),
      rule('Try again after a server error', s.retry.enabled, (v) => ({ retry: { enabled: v } }),
        'In a Claude Code session: when the provider\'s servers are busy or the connection breaks, it waits a little and sends "continue", up to three times; never at a usage limit.'),
      rule('Reopen sessions after a restart', !!st.restoreOn, (v) => ({ restore: { enabled: v } }),
        'Claude Code sessions lost when the computer or the dashboard restarts come back with their conversation; nothing is typed into them.')),
    panel({ icon: 'settings', title: 'Housekeeping', desc: 'Keep the computer tidy. New versions have a page of their own: Settings → Updates.' },
      rule('Close idle terminals', s.idle.shells, (v) => ({ idle: { shells: v } }),
        'Closes a plain terminal that nobody uses after it has been quiet for a while; a coding tool\'s session is never closed.', (v) => (idleShells.hidden = !v)),
      idleShells,
      rule('Stop an unused gateway', s.idle.gateway, (v) => ({ idle: { gateway: v } }),
        'Stops an add-on gateway that no session has used for a while, to free memory; it starts again when a session needs it.', (v) => (idleGateway.hidden = !v)),
      idleGateway),
  ];
}

// ---------- Activity ----------

async function activityPart(box, isAlive) {
  if (!box.querySelector('.au-activity')) fill(box, loading('Loading what the automations did…'));
  let r;
  try {
    r = await api('/api/automation/log?limit=50');
  } catch (e) {
    if (isAlive()) fill(box, errorBox(`Could not load the activity: ${e.message}`, () => activityPart(box, isAlive)));
    return;
  }
  if (!isAlive()) return;
  const refresh = btn('secondary small', { icon: 'refresh', label: 'Refresh', onclick: () => activityPart(box, isAlive).then(() => toast('Up to date')) });
  if (!r.entries.length) {
    fill(box, h('div.au-activity', emptyState('text', 'Nothing yet. Each time an automation does something, it shows here in one sentence.'), h('div.au-foot-row', refresh)));
    return;
  }
  // A chat by its title while it is open; one that closed since is "a chat".
  const chats = new Map(((store.data && store.data.sessions) || []).filter((x) => x.kind === 'chat').map((x) => [x.name, x.title || x.display]));
  const sessionLabel = (n) => (n.startsWith('chat:') ? (chats.get(n) ? `the chat "${chats.get(n)}"` : 'a chat') : n);
  fill(box, h('div.au-activity',
    groupHead('Newest first', r.entries.length),
    h('div.rows', foldActivity(r.entries).map(({ e, n }) => {
      const l = activityLine(e, sessionLabel);
      return h(`div.row.static.au-act${l.problem ? '.bad' : ''}`,
        h('span.row-icon', icon(l.problem ? 'alert' : 'check', { size: 18 })),
        h('span.row-main',
          h('span.au-act-title', l.title, n > 1 ? h('span.badge.soft.au-act-n', `${n} times`) : null),
          l.problem ? h('span.au-act-problem', l.problem) : null,
          h('span.row-sub', `${l.sub} · ${n > 1 ? 'last ' : ''}${ago(Date.parse(e.time))}`)));
    })),
    h('div.au-foot-row', h('p.hint', 'The newest 50, kept on this computer.'), refresh)));
}

// ---------- the queue: session view and Home ----------

/**
 * The "3 queued" badges on Home. Home draws a card again only when the session itself changed, so each badge is
 * a live element this file fills: queue sizes are asked per computer at most every 5 seconds (on the page's own
 * poll), and every badge still on the page is painted with the answer.
 */
const counts = new Map(); // machine key → { at, queues }
const badges = new Set(); // { el, key, name }

function paintBadge(b) {
  const q = ((counts.get(b.key) || {}).queues || {})[b.name];
  b.el.classList.toggle('hidden', !(q && q.count));
  b.el.title = q && q.paused ? 'Queue paused' : 'Sent one per finished reply';
  fill(b.el, q && q.count ? [icon('clock', { size: 13 }), ` ${q.count} queued${q.paused ? ' · paused' : ''}`] : null);
}

function askCounts(key, m) {
  const c = counts.get(key);
  if (c && Date.now() - c.at < 5000) return;
  counts.set(key, { at: Date.now(), queues: c ? c.queues : {} });
  api(at(m, '/api/automation')).then((r) => {
    counts.set(key, { at: Date.now(), queues: r.queues || {} });
    for (const b of badges) {
      if (!b.el.isConnected) badges.delete(b);
      else if (b.key === key) paintBadge(b);
    }
  }).catch(() => {});
}

// The poller is joined when Home draws its first badge, not at load: a page without session cards starts nothing.
let following = false;
function followStore() {
  if (following) return;
  following = true;
  store.subscribe(() => {
    for (const key of new Set([...badges].map((b) => b.key))) askCounts(key, key === '~' ? null : key);
  });
}

registerCardBadge((s) => {
  if (!isCodingCard(s)) return null;
  followStore();
  const b = { el: h('span.badge.soft.hidden'), key: s.machine || '~', name: s.name };
  badges.add(b);
  paintBadge(b);
  askCounts(b.key, s.machine || null);
  return b.el;
});

registerSessionAction({
  id: 'queue',
  label: 'Queue',
  sub: 'Messages sent one per finished reply',
  icon: 'clock',
  async describe({ name }) {
    try {
      const q = await api(`/api/automation/queue/${encodeURIComponent(name)}`);
      return { sub: q.items.length ? `${q.items.length} queued${q.paused ? ' · paused' : ''}` : 'Messages sent one per finished reply' };
    } catch (e) {
      return e.status === 404 || e.status === 503 ? null : {}; // a computer without automations: no row
    }
  },
  run: ({ name }) => queueSheet(name, () => {}),
});

/** The queue of one session, in a sheet: add, reorder, remove, pause. */
function queueSheet(name, after) {
  const base = `/api/automation/queue/${encodeURIComponent(name)}`;
  const list = h('div.rows');
  const pauseBtn = h('button.btn.small.secondary', { type: 'button' }, 'Pause');
  const input = h('textarea.field', { rows: 3, placeholder: 'What to do next', 'aria-label': 'Message to queue' });
  const err = h('p.form-error', { role: 'alert' });
  let q = { paused: false, items: [] };
  const op = async (body) => {
    err.textContent = '';
    try {
      q = await api(base, body);
      paint();
      after();
      return true;
    } catch (e) {
      err.textContent = e.message;
      return false;
    }
  };
  // Why the next message waits although the session looked free: its coding tool was not the program in front.
  const waits = h('p.banner.info', { role: 'status' });
  function paint() {
    waits.style.display = q.waits ? '' : 'none'; // .banner is a flex box: the hidden attribute alone would not hide it
    waits.textContent = q.waits ? `Waiting: ${q.waits}.` : ''; // the server's plain sentence (automation/queue.mjs HELD_WHY)
    pauseBtn.textContent = q.paused ? 'Resume' : 'Pause';
    pauseBtn.onclick = () => op({ op: 'pause', paused: !q.paused });
    fill(list, q.items.length
      ? q.items.map((it, i) => h('div.row.static',
        h('span.order-n', String(i + 1)),
        h('span.row-main', h('span.row-title', { style: { whiteSpace: 'normal', overflowWrap: 'anywhere' } }, it.text.length > 140 ? `${it.text.slice(0, 139)}…` : it.text)),
        btn('icon ghost', { icon: 'up', title: 'Earlier', disabled: i === 0, onclick: () => op({ op: 'move', id: it.id, to: i - 1 }) }),
        btn('icon ghost', { icon: 'down', title: 'Later', disabled: i === q.items.length - 1, onclick: () => op({ op: 'move', id: it.id, to: i + 1 }) }),
        btn('icon ghost', { icon: 'x', title: 'Remove', onclick: () => op({ op: 'remove', id: it.id }) })))
      : h('p.muted', 'Nothing queued.'));
  }
  api(base).then((r) => {
    q = r;
    paint();
  }).catch((e) => (err.textContent = e.message));
  paint();
  setTimeout(() => input.focus(), 50); // the message box is what one came for
  return openSheet({ title: `Queue · ${name}`, subtitle: 'Each time a reply ends, the next message is sent. It waits while the session needs your OK, hits a limit or an error.', wide: true }, (close) => [
    waits,
    list,
    h('div.mrow-actions', pauseBtn, btn('small ghost', { icon: 'trash', label: 'Clear all', onclick: () => op({ op: 'clear' }) })),
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (!input.value.trim()) return;
        if (await op({ op: 'add', text: input.value })) input.value = '';
      },
    },
    input,
    err,
    h('div.sheet-actions',
      h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Done'),
      h('button.btn.primary', { type: 'submit' }, 'Add to queue'))),
  ]);
}
