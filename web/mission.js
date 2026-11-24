// Tia's missions on the Work page (src/mission): the Team tab (#/work/team: her switches and limits, her missions,
// the roles and their numbers), one mission's screen (#/work/mission/<id>), the sheet "Give Tia a goal" (Plans) and
// the morning brief on Today. Everything here reads GET /api/work/missions; nothing is worked out in the page that
// the server did not count.
import { icon } from './icons.js';
import { api, btn, confirmSheet, fill, h, kindLabel, openSheet, toast } from './lib.js';
import { emptyState, errorBox, field, groupHead, skeletonRows, toggle } from './shell.js';
import { money } from './chat/words.js';
import { keepFocus } from './workdo.js';
import { placeLinks } from './operator-ways.js';

// running: a session of it works now; waiting: none does (the line under it says why); paused: Tia is OFF.
export const MISSION_WORDS = { planning: 'Planning', running: 'Working', waiting: 'Waiting', paused: 'Paused: Tia OFF', done: 'Done', waits: 'Waits for you', failed: 'Failed', stopped: 'Stopped' };
export const TASK_WORDS = { queued: 'Waiting its turn', running: 'A session works on it', review: 'Ready for your review', done: 'Done', his: 'Yours to look at', failed: 'Failed', dropped: 'Dropped', stopped: 'Stopped' };
const MISSION_ICONS = { planning: 'sparkle', running: 'play', waiting: 'clock', paused: 'power', done: 'check', waits: 'bell', failed: 'alert', stopped: 'stop' };
const ROLE_WORDS = { developer: 'Developer', reviewer: 'Reviewer', tester: 'Tester', researcher: 'Researcher', writer: 'Writer', ops: 'Ops' };
const ROLE_SUBS = { developer: 'writes the change and its tests', reviewer: 'reads another session\'s work and says pass or fix; it cannot write', tester: 'writes and repairs tests; it cannot run them', researcher: 'finds things out in the project and writes them down', writer: 'writes documents', ops: 'writes down what would have to be run, step by step; it cannot run it' };
export const NUMBERS_WORDS = 'Tokens: what the coding tool counted for every run of a task (the work, its reviews, its fixes). Minutes: time on the clock. First time: its check and its review passed with no fix. Cost: the coding tool\'s own cost line.';
const ORDER_WORDS = 'Tia uses only the providers you allow here, in this order, and moves to the next one at a usage limit. Gateways and API keys go first; a subscription is used only when you add it here, since a subscription is meant for a person at the keyboard.';

const tokens = (n) => (Number(n) || 0).toLocaleString('en');
const mins = (n) => `${Number(n) || 0} min`;
const RUN_WHO = { work: 'Its session', review: 'Its review', fix: 'Its fix' };
/** A session that runs now: for how long, and what it may spend (its tokens and cost come when it ends). */
const goingWords = (r) => `${RUN_WHO[r.kind] || 'Its session'} runs${r.startedAt ? ` for ${Math.max(0, Math.round((Date.now() - Date.parse(r.startedAt)) / 60_000))} min` : ''}${r.budget ? `, may spend up to ${money(r.budget)}` : ''}`;
const firstWords = (v) => (v === true ? 'Yes' : v === false ? 'No, it needed a fix' : 'Not yet');
const enc = encodeURIComponent;
export const missionHref = (id) => `#/work/mission/${enc(id)}`;
const badge = (state) => h(`span.badge.ms-badge.ms-${state}`, icon(MISSION_ICONS[state] || 'info', { size: 12 }), MISSION_WORDS[state] || state);

/**
 * "Tia OFF", one press: the master switch off. On: the button. Off: what is still to be set to turn her on (`steps`, the
 * server's) and the way there (`turnOn(step)`: Team opens her switches at that step; elsewhere a link to Team).
 */
export function offBar(s, after, { steps = [], turnOn = null } = {}) {
  if (!s.on) {
    const left = steps.filter((x) => !x.done);
    return h('div.banner.info.ms-offbar', { role: 'status', tabindex: -1, dataset: { key: 'offbar' } }, icon('power', { size: 18 }),
      h('span', h('strong', 'Tia is OFF. '), 'A goal you give her becomes a plan for you to accept and start yourself.', left.length ? ` To turn her on: ${left.map((x) => x.words).join('; ')}.` : ''),
      turnOn ? btn('secondary small', { icon: 'power', label: 'Turn Tia on…', onclick: () => turnOn(left.length ? left[0].key : 'on') })
        : h('a.btn.secondary.small', { href: '#/work/team' }, 'Her switches on Team'));
  }
  return h('div.banner.ok-box.ms-offbar', icon('zap', { size: 18 }),
    h('span', h('strong', 'Tia is ON. '), 'She starts the tasks of plans you accept, in the projects you turned on, within your limits.'),
    btn('danger small', { icon: 'power', label: 'Tia OFF', dataset: { key: 'tia-off' }, onclick: async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api('/api/work/missions/off', {});
        toast(s.offStops ? 'Tia is OFF: nothing new starts, and what ran is stopped' : 'Tia is OFF: nothing new starts; what runs goes to its end');
      } catch (x) {
        toast(x, { kind: 'error' });
      }
      after({ focus: 'offbar' }); // the keyboard lands on the line that now says she is OFF
    } }));
}

// ---------- the Team tab ----------

/** The Team tab: Tia OFF, her missions, the roles with their numbers, and her switches and limits. → { refresh }. */
export function paintTeam(content, { onGoal }) {
  let alive = true;
  async function load({ focus = null } = {}) {
    let d;
    try {
      d = await api('/api/work/missions');
    } catch (e) {
      if (alive) fill(content, errorBox(`Could not load Tia's missions: ${e.message}`, load));
      return;
    }
    if (!alive) return;
    const keepOpen = content.querySelector('details.ms-settings[open]');
    // Drawn again after every save: the focus stays on the control it was on (each has its data-key).
    keepFocus(content, () => fill(content, offBar(d.settings, load, { steps: d.steps || [], turnOn }), missionsPart(d, onGoal), teamPart(d), settingsPart(d, load, !!keepOpen)));
    const at = focus && content.querySelector(`[data-key="${focus}"]`);
    if (at) at.focus();
  }
  /** Tia OFF's "Turn Tia on…": her switches open, the focus on the first step still to be set. */
  function turnOn(step) {
    const fold = content.querySelector('details.ms-settings');
    if (fold) fold.open = true;
    const at = content.querySelector(`[data-step="${step}"]`);
    if (!at) return;
    at.focus();
    at.scrollIntoView({ block: 'center' });
  }
  fill(content, skeletonRows(4));
  load();
  return { refresh: load, stop: () => (alive = false) };
}

function missionRow(m) {
  const c = m.counts || {};
  const facts = [`${m.tasks.length} task${m.tasks.length === 1 ? '' : 's'}`, c.done ? `${c.done} done` : null, c.waits ? `${c.waits} wait${c.waits === 1 ? 's' : ''} for you` : null, c.failed ? `${c.failed} failed` : null, money(m.total.cost)].filter(Boolean).join(' · ');
  const face = m.face || m.state;
  // One name for the whole row, with its parts apart: a screen reader reads the parts' text joined with no space.
  return h('a.row.ms-row', { href: missionHref(m.id), dataset: { key: `mission:${m.id}` }, 'aria-label': `${m.goal}, ${MISSION_WORDS[face] || face}, ${m.project}, ${facts}${m.why ? `. ${m.why}` : ''}` },
    h('span.row-icon', icon(MISSION_ICONS[m.face || m.state] || 'info')),
    h('span.row-main', h('span.row-title.ms-goal', m.goal), h('span.row-sub', badge(m.face || m.state), h('span', `${m.project} · ${facts}`)), m.why ? h('span.row-sub.ms-why', m.why) : null),
    h('span.row-end', icon('chevronRight', { size: 18 })));
}

function missionsPart(d, onGoal) {
  const list = d.missions || [];
  const broken = (d.broken || []).length ? h('p.hint.ms-broken', `${d.broken.length} mission file${d.broken.length === 1 ? '' : 's'} could not be read and ${d.broken.length === 1 ? 'is' : 'are'} left alone: ${d.broken.slice(0, 3).join(', ')}`) : null;
  return h('section.wk-section', groupHead('Missions', list.length),
    list.length ? h('div.rows', list.slice(0, 40).map(missionRow))
      : h('div.card.wk-start', emptyState('sparkle', d.settings.on ? 'No missions yet. Give Tia a goal: she plans it with Plan with AI, and once you accept the plan her sessions do its tasks.' : 'No missions yet. Turn Tia on below for a project, then give her a goal.', btn('secondary', { icon: 'sparkle', label: 'Give Tia a goal', dataset: { key: 'goal' }, onclick: onGoal }))),
    broken);
}

/** His corrections of a role, as the Team tab shows them: "You sent back 4 of its tasks this week." */
export const sentBack = (d, r) => {
  const n = (d.corrected || {})[r.role] || 0;
  // Only this week's count: the role's tasks above count every mission kept, so "4 of its 9" would mix two spans.
  return n ? `You sent back ${n} of its tasks this week.` : null;
};
/** Said once under the first such line: the counts are for him to read, nothing acts on them. */
export const SHOWN_ONLY = 'Only shown to you; nothing changes by itself from it.';

function teamPart(d) {
  const cell = (label, value) => h('div.ms-num', h('span.ms-num-v', value), h('span.ms-num-l', label));
  return h('section.wk-section', groupHead('The team', d.team.length),
    h('p.hint.ms-hint', 'Each task is done by one session with a role, and checked by a reviewer session that did not write it. ', NUMBERS_WORDS),
    h('div.ms-roles', d.team.map((r) => h(`div.card.ms-role${r.on ? '' : '.ms-off'}`,
      h('div.ms-role-head', h('strong', ROLE_WORDS[r.role] || r.role), h(`span.badge.soft${r.on ? '' : '.ms-offtag'}`, r.on ? 'On' : 'Off')),
      h('p.hint.ms-role-sub', ROLE_SUBS[r.role] || ''),
      h('div.ms-nums',
        cell(r.role === 'reviewer' ? 'tasks looked at' : 'tasks', String(r.tasks)),
        r.role === 'reviewer' ? cell('reviews', String(r.runs)) : cell('first time', r.judged ? `${r.passedFirst} of ${r.judged}` : '—'),
        cell('tokens', tokens(r.tokens)), cell('cost', `${money(r.cost)}${r.costUnknown ? '+' : ''}`), cell('minutes', String(r.minutes))),
      sentBack(d, r) ? h('p.hint.ms-role-back', sentBack(d, r), r === d.team.find((x) => sentBack(d, x)) ? ` ${SHOWN_ONLY}` : '') : null))),
    d.team.some((r) => r.costUnknown) ? h('p.hint.ms-hint', '+ : some runs reported no cost; their tokens are counted.') : null);
}

function settingsPart(d, reload, open) {
  const s = d.settings;
  const save = async (patch) => {
    try {
      await api('/api/work/missions/settings', patch);
    } catch (e) {
      toast(e, { kind: 'error', ms: 6000 });
      throw e;
    } finally {
      reload();
    }
  };
  const projects = (d.projects || []).map((p, i) => {
    const ps = s.projects[p] || { on: false, test: null };
    const test = h('input.field.ms-test', { type: 'text', dataset: { key: `test:${p}` }, value: (ps.test || []).join(' '), placeholder: 'npm test', 'aria-label': `The test command of ${p}`, spellcheck: false });
    return h('div.ms-project',
      toggle(p, ps.on, (v) => save({ projects: { [p]: { on: v, test: ps.test } } }), ps.on ? 'Tia works on this by herself.' : 'Off: its goals are plans you start yourself.', { key: `project:${p}`, ...(i === 0 ? { step: 'project' } : {}) }),
      h('div.ms-test-row', field('Its test command', test, 'A code task passes its check only when this ends well in its branch. Words split by spaces; no shell.'),
        btn('small secondary', { label: 'Save', dataset: { key: `save:${p}` }, onclick: () => save({ projects: { [p]: { on: ps.on, test: test.value.trim() ? test.value.trim().split(/\s+/) : null } } }).then(() => toast('Saved')).catch(() => {}) })));
  });
  // The providers: the allowed ones in his order (with "up"), then the others.
  const known = d.providers || [];
  const allowed = s.providers.filter((n) => known.some((p) => p.name === n));
  const others = known.filter((p) => !allowed.includes(p.name));
  const kindOf = (n) => (known.find((p) => p.name === n) || {}).kind;
  const firstProv = allowed[0] || (others[0] && others[0].name);
  const provRow = (name, i, on) => h('div.ms-prov',
    h('label.ms-prov-check', h('input', { type: 'checkbox', checked: on, dataset: { key: `prov:${name}`, ...(name === firstProv ? { step: 'providers' } : {}) }, onchange: (e) => save({ providers: e.target.checked ? [...allowed, name] : allowed.filter((x) => x !== name) }).catch(() => {}) }),
      h('span', h('strong', name), ' ', h('span.hint', kindLabel({ kind: kindOf(name) })))),
    on && i > 0 ? btn('small ghost', { icon: 'up', title: `Move ${name} up`, label: 'Up', dataset: { key: `up:${name}` }, onclick: () => save({ providers: [...allowed.slice(0, i - 1), name, allowed[i - 1], ...allowed.slice(i + 1)] }).catch(() => {}) }) : null);
  const num = (label, key, v, attrs, hint, conv = Number) => {
    const el = h('input.field.ms-numin', { type: 'number', value: String(v), ...attrs, 'aria-label': label, dataset: { key, ...(key === 'capUsd' ? { step: 'capUsd' } : {}) } });
    el.addEventListener('change', () => {
      const x = conv(el.value);
      if (Number.isFinite(x)) save({ [key]: x }).then(() => toast('Saved')).catch(() => {});
    });
    return field(label, el, hint);
  };
  const here = Math.max(1, Number(d.slots) || 1);
  const from = h('input.field', { type: 'time', dataset: { key: 'from' }, value: s.hours ? s.hours.from : '09:00', 'aria-label': 'From' });
  const to = h('input.field', { type: 'time', dataset: { key: 'to' }, value: s.hours ? s.hours.to : '18:00', 'aria-label': 'To' });
  const kinds = [['docs', 'Documents (the writer\'s tasks)'], ['tests', 'Tests (the tester\'s tasks)']];
  const body = h('div.ms-settings-body',
    h('div.card.ms-block',
      toggle('Tia works by herself', s.on, (v) => save({ on: v }), 'The master switch. Off is "Tia OFF": nothing of hers starts, in any project.', { key: 'on', step: 'on' }),
      toggle('Tia OFF stops what runs', s.offStops, (v) => save({ offStops: v }), s.offStops ? 'When you press Tia OFF, her sessions that run are stopped.' : 'When you press Tia OFF, her sessions that run go to their end; nothing further starts.', { key: 'offStops' })),
    h('div.card.ms-block', h('h3.ms-h3', 'Projects'), projects.length ? projects : h('p.hint', 'No project in the workspace yet.')),
    h('div.card.ms-block', h('h3.ms-h3', 'Limits'),
      h('div.ms-grid',
        num('Spend cap per day ($)', 'capUsd', s.capUsd, { min: 0, max: 10000, step: 0.5 }, 'Counted from each run\'s own cost line. At the cap nothing new starts. 0: nothing starts.'),
        num('Token cap per day', 'capTokens', s.capTokens, { min: 0, step: 1000 }, 'For providers that report tokens but no cost. 0: such providers are not used.', (x) => Math.round(Number(x))),
        // The number that holds: never more than this computer runs by itself at once (its slots).
        num('Sessions at once', 'atOnce', Math.min(s.atOnce, here), { min: 1, max: Math.min(4, here) }, s.atOnce > here ? `You set ${s.atOnce}; this computer runs ${here} by itself at once, so ${here} here.` : `Never more than this computer runs by itself at once (${here}).`, (x) => Math.round(Number(x))),
        num('Time limit (minutes)', 'minutes', s.minutes, { min: 1, max: 240 }, 'Each session is stopped at this time limit.', (x) => Math.round(Number(x)))),
      toggle('Only in working hours', !!s.hours, (v) => save({ hours: v ? { from: from.value || '09:00', to: to.value || '18:00' } : null }), 'Outside them nothing of hers starts; this computer\'s time zone of Work.', { key: 'hours' }),
      s.hours ? h('div.ms-hours', field('From', from), field('To', to), btn('small secondary', { label: 'Save hours', dataset: { key: 'hours-save' }, onclick: () => save({ hours: { from: from.value, to: to.value } }).then(() => toast('Saved')).catch(() => {}) })) : null),
    h('div.card.ms-block', h('h3.ms-h3', 'Providers'), h('p.hint.ms-hint', ORDER_WORDS),
      known.length ? h('div.ms-provs', allowed.map((n, i) => provRow(n, i, true)), others.map((p) => provRow(p.name, 0, false))) : h('p.hint', 'There is no provider for Claude Code yet: add one under Providers.')),
    h('div.card.ms-block', h('h3.ms-h3', 'Accept by itself'),
      h('p.hint.ms-hint', 'Only for these kinds, only when their check and their review passed. It is Work\'s Accept: nothing is merged or pushed.'),
      kinds.map(([k, label]) => toggle(label, s.selfAccept.includes(k), (v) => save({ selfAccept: v ? [...s.selfAccept, k] : s.selfAccept.filter((x) => x !== k) }), undefined, { key: `self:${k}` }))),
    h('div.card.ms-block', h('h3.ms-h3', 'Roles'),
      h('p.hint.ms-hint', 'A task whose role is off is yours to do.'),
      Object.keys(ROLE_WORDS).map((r) => toggle(ROLE_WORDS[r], !s.rolesOff.includes(r), (v) => save({ rolesOff: v ? s.rolesOff.filter((x) => x !== r) : [...s.rolesOff, r] }), ROLE_SUBS[r], { key: `role:${r}` }))));
  return h('details.fold.ms-settings', { open },
    h('summary.fold-summary', h('span', 'Tia\'s switches and limits'), icon('chevronDown', { size: 18 })),
    h('div.fold-body', body));
}

// ---------- one mission ----------

// ---------- a task's tests ----------

export const OUTSIDE_WORDS = 'Outside the box, the tests run as you, on this computer. A session of Tia wrote or changed them, so they can read your files and keys, use the network, and change or delete anything you can. Run them outside only when you have read what the branch changed.';
const resultWords = (r) => (r.ok ? 'they passed' : r.timedOut ? 'they did not end in time' : r.code == null ? 'they did not finish' : 'they failed');
const NO_NET = '(a test that needs the network fails there)';

/** Whether this computer has no box, by the server's answer now (`box`) or, without one, by the gate's. */
export const noBoxHere = (g, box) => (box ? box.ok === false : !!(g && g.noBox));

/** Where a task's tests ran and what they said, in one line a person reads at a glance. `box`: the server's answer. */
export function testsLine(g, box = null) {
  if (!g) return null;
  if (g.here) return `${g.here.boxed ? 'You ran the tests in the box (no network, without your home)' : 'You ran the tests outside the box, as you'}: ${resultWords(g.here)}${g.here.boxed && !g.here.ok && !g.here.timedOut ? ` ${NO_NET}` : ''}.`;
  if (g.boxed) {
    const r = g.tests && g.tests.result;
    if (r === 'timeout') return `The tests ran in the box and were stopped${g.tests.limit ? ` after ${g.tests.limit}` : ''}: they did not end in time.`;
    if (r === 'passed' || (!r && g.ok)) return 'The tests ran in the box (no network, without your home) and passed.';
    return `The tests ran in the box (no network, without your home) and did not pass ${NO_NET}.`;
  }
  if (g.testsNotRun) {
    if (noBoxHere(g, box)) {
      const why = String((box && box.why) || g.notRunWhy || '').replace(/^no box on this computer:?\s*/, '');
      const step = (box && box.step) || g.step || '';
      return `This computer has no box${why || step ? ` (${[why, step ? `${step}, to run the tests safely` : ''].filter(Boolean).join(': ')})` : ''}. You can run them outside the box, as you.`;
    }
    // While the check runs, a "no box" reason waits for its answer, so the line never says "no box" and "checking" at once.
    if (box && box.checking) {
      const why = /^no box on this computer\b/.test(String(g.notRunWhy || '')) ? '' : g.notRunWhy;
      return `The tests were not run${why ? `: ${why}` : ''}. Checking whether this computer has a box (a safe place to run tests, with no network)…`;
    }
    return `The tests were not run${g.notRunWhy ? `: ${g.notRunWhy}` : ''}. They are yours to check.`;
  }
  return null;
}

/**
 * How often a session ran the tests itself in the box and how its last such run ended, in one short line of the tests
 * part that says which run counts. The count is per session (the engine resets it at each work or fix run). Its words
 * by where the task is: `running` (a work or fix session runs now: the check comes after it); the check `gate` ran
 * after these runs (by its time, which the engine keeps) and its line is `shown` above; it ran after them but its line
 * is not shown (it failed before the tests ran); or no check came after them. null when no session ran them itself.
 */
export function selfTestsLine(s, { running = false, gate = null, shown = false } = {}) {
  if (!s || !Number.isInteger(s.runs) || s.runs < 1) return null;
  const n = s.runs === 1 ? 'once' : `${s.runs} times`;
  const last = s.last === 'passed' ? 'passed' : s.last === 'timeout' ? 'did not end in time' : 'failed';
  const lim = s.limit === 'runs' ? ', then reached its run limit' : s.limit === 'time' ? ', then reached its time limit' : '';
  if (running) return `This session has run the tests itself ${n} so far (last: ${last})${lim}. The check runs them again after it ends.`;
  const after = !!(gate && gate.at && s.at && Date.parse(gate.at) >= Date.parse(s.at));
  if (after && shown) return `Before that, its session ran the tests itself ${n} (last: ${last})${lim}. Only the run above counts.`;
  if (after) return `Its session ran the tests itself ${n} (last: ${last})${lim}. The check after it did not run them: only the check's own run counts.`;
  return `Its last session ran the tests itself ${n} (last: ${last})${lim}. That is not the check: only the check's own run counts.`;
}

/** The tests part of a task's card: where they ran, what they printed, and his own press while they wait for him. */
function testsBlock(x, f, mid, reload, box = null) {
  const g = f.gate;
  const line = testsLine(g, box);
  // The session's own count shows also with no line of the check (none yet, or one that failed before the tests ran).
  // "Only the run above counts" is said only when the check above really ran the tests (in the box, or his own run):
  // a line that says the tests were NOT run (busy, no box, a box that could not run them) is not such a run.
  const own = selfTestsLine(f.selfTests, { running: !!(f.run && f.run.kind !== 'review'), gate: g, shown: !!(g && (g.boxed || g.here)) });
  const ownLine = own ? h('p.ms-tests-line.ms-self-tests', own) : null;
  if (!line) return ownLine ? h('div.ms-tests', ownLine) : null;
  const printed = (g.here && g.here.out) || g.printed || '';
  const status = h('p.ms-tests-status', { role: 'status' });
  const waiting = x.state === 'review' && g.testsNotRun;
  // No box on this computer: the press in the box cannot work, so it is not offered (as before the box was wired).
  const none = noBoxHere(g, box);
  // Not disabled while it runs: a disabled button loses the keyboard's focus, which the redraw then cannot give back.
  // Both buttons say they are busy instead, and a press of either says why nothing more starts.
  let going = false;
  const busy = (on) => {
    for (const b of [inBox, out].filter(Boolean)) {
      if (on) b.setAttribute('aria-disabled', 'true');
      else b.removeAttribute('aria-disabled');
    }
  };
  const BUSY_WORDS = (outside) => `The tests are running ${outside ? 'outside the box' : 'in the box'} now; press again once this ends.`;
  let goingOutside = false;
  const press = async (b, outside) => {
    if (going) {
      status.textContent = BUSY_WORDS(goingOutside);
      return;
    }
    going = true;
    goingOutside = outside;
    status.textContent = outside ? 'Running the tests outside the box…' : 'Running the tests in the box…';
    b.setAttribute('aria-busy', 'true');
    busy(true);
    try {
      const { here } = await api(`/api/work/missions/${enc(mid)}/tasks/${enc(x.id)}/run-tests`, outside ? { outside: true } : {});
      toast(`${here.boxed ? 'In the box' : 'Outside the box'}: ${resultWords(here)}`);
      reload();
    } catch (e) {
      status.textContent = e.message;
      b.removeAttribute('aria-busy');
      busy(false);
      going = false;
    }
  };
  const inBox = waiting && !none ? btn('secondary small', { icon: 'play', label: g.here ? 'Run them again in the box' : 'Run the tests in the box', dataset: { key: `box:${x.id}` }, onclick: () => press(inBox, false) }) : null;
  const out = waiting ? btn(none ? 'secondary small' : 'ghost small', { label: 'Run them outside the box…', dataset: { key: `outside:${x.id}` }, onclick: async () => {
    if (going) return press(out, true); // says why, and opens no sheet
    if (!(await confirmSheet({ title: 'Run the tests outside the box?', text: OUTSIDE_WORDS, ok: 'Run them outside the box', danger: true }))) return;
    press(out, true);
  } }) : null;
  return h('div.ms-tests',
    h('p.ms-tests-line', line),
    ownLine,
    printed ? h('details.ms-printed', h('summary', 'What the tests printed (their last lines)'), h('pre.ms-printed-text', printed)) : null,
    waiting && !g.here && !none ? h('p.hint.ms-tests-hint', 'In the box the tests have no network and cannot see your home. Running them outside is a separate step that asks you first.') : null,
    waiting ? h('div.ms-tests-actions', inBox, out) : null,
    waiting ? status : null);
}

/** A mission's screen: what it is, where it stands, each task with its numbers, and the line of every act. */
export function viewMission(content, id) {
  let alive = true;
  let timer = null;
  let drawn = null; // the answer on the screen
  async function load() {
    let d;
    let m;
    try {
      [d, { mission: m }] = await Promise.all([api('/api/work/missions'), api(`/api/work/missions/${enc(id)}`)]);
    } catch (e) {
      drawn = null;
      if (alive) fill(content, h('a.btn.ghost.ms-back', { href: '#/work/team' }, icon('back', { size: 16 }), 'Team'), errorBox(e, load));
      return;
    }
    if (!alive) return;
    const ended = !['planning', 'running', 'waits'].includes(m.state);
    clearTimeout(timer);
    // While the box's answer is being checked, it comes with a later read: read again soon.
    if (m.box && m.box.checking) timer = setTimeout(() => alive && load(), 1500);
    else if (!ended || m.tasks.some((x) => x.state === 'running')) timer = setTimeout(() => alive && load(), 5000);
    // The same answer as the one on the screen (and, while a session runs, the same minute): nothing is drawn again, so
    // the keyboard's and a screen reader's place stay; a changed one is drawn again with the focus kept.
    const key = JSON.stringify([d.settings, d.steps, m, m.tasks.some((x) => x.state === 'running') ? Math.floor(Date.now() / 60_000) : 0]);
    if (key === drawn) return;
    drawn = key;
    // Only the dashboard that runs a mission can stop it: another's says where it is stopped.
    const stop = ended || m.mine === false ? null : btn('secondary small', { icon: 'stop', label: 'Stop this mission', dataset: { key: 'stop' }, onclick: async () => {
      if (!(await confirmSheet({ title: 'Stop this mission?', text: d.settings.offStops ? 'Nothing more of it starts, and its sessions that run are stopped.' : 'Nothing more of it starts; its sessions that run go to their end.', ok: 'Stop it', danger: true }))) return;
      try {
        await api(`/api/work/missions/${enc(id)}/stop`, {});
      } catch (e) {
        toast(e, { kind: 'error' });
      }
      load();
    } });
    const t = m.total;
    const sum = h('div.card.ms-sum',
      h('div.ms-sum-head', badge(m.face || m.state), h('span.ms-sum-project', m.project), stop),
      h('h2.ms-title', m.goal),
      !ended && m.mine === false ? h('p.hint.ms-elsewhere', 'Started by another dashboard on this computer; stop it there.') : null,
      // Why it waits or stopped; a mission that waits for him says so in its lines below already.
      m.why && m.state !== 'waits' ? h('p.ms-why-line', m.why) : null,
      // The places its why names, from their codes (errorways.js); while it plans, the link to its plan below is the way.
      m.why && m.state !== 'waits' && m.state !== 'planning' ? placeLinks(m.ways, m.goal) : null,
      h('ul.ms-lines', m.lines.map((l) => h('li', l))),
      h('div.ms-nums.ms-totals', [['cost', `${money(t.cost)}${t.costUnknown ? '+' : ''}`], ['tokens', tokens(t.tokens)], ['minutes', String(t.minutes)], ['first time', t.judged ? `${t.passedFirst} of ${t.judged}` : '—']].map(([l, v]) => h('div.ms-num', h('span.ms-num-v', v), h('span.ms-num-l', l)))),
      h('p.hint.ms-hint', NUMBERS_WORDS),
      m.state === 'planning' ? h('p.ms-next', h('a', { href: m.proposal ? `#/work/proposal/${enc(m.proposal)}` : '#/work/plans' }, 'Look at its plan on Work → Plans'), ': nothing starts before you accept it.') : null);
    const full = new Map((m.tasksFull || []).map((x) => [x.id, x]));
    const taskRow = (x) => {
      const f = full.get(x.id) || {};
      return h(`div.row.static.ms-task.ms-t-${x.state}`,
        h('span.row-icon', icon(x.state === 'done' ? 'check' : x.state === 'review' || x.state === 'his' ? 'bell' : x.state === 'failed' ? 'alert' : x.state === 'running' ? 'play' : 'clock')),
        h('span.row-main',
          h('span.row-title.ms-goal', x.title),
          h('span.row-sub', h('strong', TASK_WORDS[x.state] || x.state), ` · ${x.role ? ROLE_WORDS[x.role] || x.role : 'Yours, by the plan'}${x.branch ? ` · ${x.branch}` : ''}`),
          x.why ? h('span.row-sub.ms-why', x.why) : null,
          x.why ? placeLinks(x.ways, x.title) : null,
          testsBlock(x, f, id, load, m.box || null),
          f.run ? h('span.row-sub.ms-task-nums.ms-going', goingWords(f.run)) : null,
          f.run && !x.runs ? null : h('span.row-sub.ms-task-nums', `${f.run ? 'Before it: ' : ''}${tokens(x.tokens)} tokens · ${mins(x.minutes)} · ${money(x.cost)}${x.costUnknown ? '+' : ''} · first time: ${firstWords(x.firstPass)}${f.fixes ? ` · ${f.fixes} fix${f.fixes === 1 ? '' : 'es'}` : ''}${f.provider ? ` · ${f.provider}${f.model ? `, ${f.model}` : ''}` : ''}`),
          x.state === 'review' ? h('span.row-sub', h('a', { href: '#/work', dataset: { key: `accept:${x.id}` } }, 'Accept or Send back on Today')) : null));
    };
    const line = h('section.wk-section', groupHead('What happened', m.line.length),
      h('ol.ms-line', [...m.line].reverse().slice(0, 100).map((l) => h('li', h('time', { datetime: l.at }, new Date(l.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })), h('span', l.task ? h('strong', `${l.task}: `) : null, l.words)))));
    keepFocus(content, () => fill(content,
      h('a.btn.ghost.small.ms-back', { href: '#/work/team', dataset: { key: 'back' } }, icon('back', { size: 16 }), 'Team'),
      offBar(d.settings, load, { steps: d.steps || [] }), sum,
      h('section.wk-section', groupHead('Tasks', m.tasks.length), m.tasks.length ? h('div.rows', m.tasks.map(taskRow)) : h('p.hint.wk-hint', m.state === 'planning' ? 'Its tasks are the ones of the plan you accept.' : 'This mission has no tasks.')),
      line));
  }
  fill(content, skeletonRows(4));
  load();
  return { refresh: load, stop: () => {
    alive = false;
    clearTimeout(timer);
  } };
}

// ---------- the goal ----------

/** "Give Tia a goal": the goal and its project. → what the server did, or null. */
export function goalSheet(projects) {
  return openSheet({ title: 'Give Tia a goal', subtitle: 'Plan with AI plans it; you accept the plan first' }, (close) => {
    const goal = h('textarea.field.wk-goal', { rows: 4, maxlength: 2000, autofocus: true, 'aria-label': 'The goal', placeholder: 'What you want reached, in your own words: "add a contact page to the shop site"' });
    const proj = h('select.field', { 'aria-label': 'The project' }, (projects || []).map((p) => h('option', { value: p }, p)));
    const err = h('p.form-error', { role: 'alert' });
    const words = h('p.hint.ms-goal-words', 'Loading…');
    const say = async () => {
      try {
        const d = await api('/api/work/missions');
        const s = d.settings;
        const on = s.on && s.projects[proj.value] && s.projects[proj.value].on;
        words.textContent = on ? 'Tia is on for this project: once you accept the plan, her sessions do its tasks, each on a branch of its own, within your limits. Nothing is merged or pushed.'
          : `${s.on ? 'Tia is not on for this project' : 'Tia is OFF'}: the plan's tasks will be yours to start, as with Plan with AI. Turn her on under Work → Team.`;
      } catch {
        words.textContent = '';
      }
    };
    proj.addEventListener('change', say);
    say();
    const go = btn('primary', { icon: 'sparkle', label: 'Give the goal', onclick: async () => {
      err.textContent = '';
      if (goal.value.trim().length < 3) {
        err.textContent = 'Write the goal first.';
        return;
      }
      go.disabled = true;
      try {
        const r = await api('/api/work/missions', { goal: goal.value.trim(), project: proj.value });
        if (r.proposal && r.proposal.state === 'failed') {
          err.textContent = r.proposal.reason || 'The planning session did not start.';
          go.disabled = false;
          return;
        }
        toast(r.plain ? 'A session is planning it: its plan shows on Plans for you to accept' : 'A session is planning it: accept its plan on Plans, and Tia begins');
        close(r);
      } catch (e) {
        err.textContent = e.message;
        go.disabled = false;
      }
    } });
    if (!(projects || []).length) return [emptyState('folder', 'There is no project in the workspace yet.')];
    return [field('The goal', goal), field('The project', proj), words, err, h('div.sheet-actions', go)];
  });
}

// ---------- the morning brief on Today ----------

/** Today's part "Tia's brief": what was finished, what waits, what failed and why, what it cost. Nothing without missions. */
export async function paintBrief(slot) {
  let d;
  try {
    d = await api('/api/work/missions');
  } catch {
    fill(slot);
    return;
  }
  const b = d.brief;
  // Nothing finished, failed or spent since yesterday and nothing waits: no brief that repeats old news.
  if (!d.missions.length || b.shown === false) {
    fill(slot);
    return;
  }
  const item = (x, why) => h('a.row.ms-row', { href: missionHref(x.mission) },
    h('span.row-icon', icon(why === 'failed' ? 'alert' : why === 'waits' ? 'bell' : 'check')),
    h('span.row-main', h('span.row-title.ms-goal', x.title), h('span.row-sub', `${x.project} · ${x.why || (why === 'finished' ? 'done' : '')}`)),
    h('span.row-end', icon('chevronRight', { size: 18 })));
  fill(slot, h('section.wk-section.ms-brief', groupHead('Tia\'s brief'),
    h('div.card.ms-brief-card', h('ul.ms-lines', b.lines.map((l) => h('li', l))), b.running ? h('p.hint', `${b.running} mission${b.running === 1 ? '' : 's'} still going.`) : null, h('a.ms-more', { href: '#/work/team' }, 'Missions and the team')),
    b.waits.length ? h('div.rows', b.waits.slice(0, 10).map((x) => item(x, 'waits'))) : null,
    b.failed.length ? h('div.rows', b.failed.slice(0, 10).map((x) => item(x, 'failed'))) : null));
}
