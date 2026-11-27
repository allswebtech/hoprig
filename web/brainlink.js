// Linking the coding tools' folders into the AI brain from the page (GET/POST /api/workspace/link,
// src/workspace/link.mjs): the one helper every place uses that would otherwise say "run hoprig workspace link" (the
// AI brain page, Skills, Get started, a computer's Setup tab, Settings → Workspace). A sheet says what will happen to
// each link, grouped by coding tool, then "Link" does it and says what was done; nothing is overwritten (a conflict is
// left alone with its reason). toolsPart() is the AI brain page's "Coding tools": the state per tool, one button.
import { icon } from './icons.js';
import { TOOL_NAMES, api, btn, fill, h, link, openSheet } from './lib.js';
import { errorBox, fold, groupHead, okBox, tabBar } from './shell.js';

/**
 * The three tabs of Projects: Projects, Skills, Memory. Every one of the three pages puts this first in its body, with
 * nothing above it. `current`: 'projects' | 'skills' | 'memory'. Plain links: each tab is a page of its own.
 */
export function projectsTabs(current) {
  return tabBar('Projects', [
    { id: 'projects', label: 'Projects', href: link('#/workspace') },
    { id: 'skills', label: 'Skills', href: link('#/skills') },
    { id: 'memory', label: 'Memory', href: link('#/brain') },
  ], current);
}

const LEFT = ['already', 'conflict'];
const mark = (e) => (e.error ? 'alert' : e.action === 'conflict' ? 'minus' : 'check');

/** One line per link: what it is for, where, and what happens (or happened) to it. */
function entryItems(entries, after) {
  return h('ul.bl-list', entries.map((e) => h(`li.bl-item${e.error ? '.bad' : e.action === 'conflict' ? '.left' : e.action === 'already' ? '.ok' : ''}`,
    h('span.bl-mark', icon(mark(e), { size: 14 })),
    h('span.bl-body',
      h('span.bl-what', e.what[0].toUpperCase() + e.what.slice(1)),
      h('span.bl-path', h('code', e.link), ' → ', h('code', e.target)),
      h('span.bl-words', after ? (e.error ? `Not done: ${e.error}` : e.done) : e.words)))));
}

const toolName = (id) => TOOL_NAMES[id] || id;
const toolsOf = (e) => (Array.isArray(e.tools) && e.tools.length ? e.tools : [e.tool || 'claude']);

/** The entries under a heading per coding tool (one heading when only Claude Code is on, or the computer is older). */
function entryList(entries, after) {
  const keys = [...new Set(entries.map((e) => toolsOf(e).join('+')))];
  if (keys.length < 2) return entryItems(entries, after);
  return h('div.bl-groups', keys.map((k) => [
    h('h3.bl-tool', k.split('+').map(toolName).join(' and ')),
    entryItems(entries.filter((e) => toolsOf(e).join('+') === k), after),
  ]));
}

/** "Claude Code and OpenCode read": the coding tools of these entries, with the verb that fits. */
/** "Claude Code and OpenCode": the coding tools these links are for. */
export const toolNames = (entries) => [...new Set(entries.flatMap(toolsOf))].map(toolName).join(', ').replace(/, ([^,]*)$/, ' and $1') || 'your coding tools';
const whoReads = (entries) => {
  const n = new Set(entries.flatMap(toolsOf)).size;
  const who = toolNames(entries);
  return `${who[0].toUpperCase()}${who.slice(1)} read${n === 1 ? 's' : ''}`;
};

/**
 * The sheet's words. `switchOn`: opened from a button that says Switch on (Get started's skills step, the Skills
 * page), so the sheet says the same, with one plain line of what it does first and the links folded under "What
 * exactly"; else the AI brain page's own words (Link).
 */
export function linkSheetWords(entries, switchOn = false) {
  if (!switchOn) return { title: 'Link the AI brain', subtitle: `So ${whoReads(entries)} the same rules, skills and memory from the AI brain, and they travel with it.`, lead: null, button: 'Link', done: 'Linked.' };
  const who = toolNames(entries);
  const one = new Set(entries.flatMap(toolsOf)).size <= 1;
  return { title: 'Switch on your stored skills', subtitle: null,
    lead: `${who[0].toUpperCase()}${who.slice(1)} then ${one ? 'uses' : 'use'} the skills, rules and memory kept in your AI brain, on this computer. Nothing is deleted.`,
    button: 'Switch on', done: 'Switched on.' };
}

/**
 * The sheet: the plan, then "Link" (or "Switch on", `switchOn`). `after()` runs once links were made. `prefix`: ''
 * for the open computer, '~' for this dashboard itself (Get started). Resolves with true when it linked.
 */
export async function linkBrainSheet(after = () => {}, { prefix = '', switchOn = false } = {}) {
  let plan;
  try {
    plan = await api(`${prefix}/api/workspace/link`);
  } catch (e) {
    return void openSheet({ title: linkSheetWords([], switchOn).title }, (close) => [errorBox(e), h('div.sheet-actions', btn('secondary', { label: 'Close', onclick: () => close() }))]);
  }
  const w = linkSheetWords(plan.entries, switchOn);
  return openSheet({ title: w.title, ...(w.subtitle ? { subtitle: w.subtitle } : {}) }, (close) => {
    const out = h('div');
    const actions = h('div.sheet-actions');
    if (!plan.todo) {
      fill(actions, btn('primary', { label: 'Close', onclick: () => close() }));
      return [plan.already ? okBox('Everything is linked already.') : h('p.sheet-text', 'Nothing can be linked now:'), plan.already ? null : entryList(plan.entries, false), actions];
    }
    const go = btn('primary', { icon: 'check', label: w.button, onclick: async () => {
      go.disabled = true;
      go.classList.add('busy');
      try {
        const r = await api(`${prefix}/api/workspace/link`, {});
        const bad = r.entries.filter((e) => e.error).length;
        fill(out, bad ? errorBox(`${bad} could not be linked; the rest is done.`) : okBox(r.entries.some((e) => e.action === 'conflict') ? `${w.done} What was in the way is left as it was.` : `${w.done} ${whoReads(r.entries)} these from the AI brain now.`),
          entryList(r.entries, true));
        plain.remove();
        fill(actions, btn('primary', { label: 'Done', onclick: () => close(true) }));
        after();
      } catch (e) {
        fill(out, errorBox(e));
        go.disabled = false;
        go.classList.remove('busy');
      }
    } });
    fill(actions, btn('secondary', { label: 'Cancel', onclick: () => close() }), go);
    const what = [h('p.sheet-text', 'What will happen to each link:'), entryList(plan.entries, false), h('p.hint', 'Nothing is overwritten: a file or folder that is moved is kept as a dated backup next to where it was.')];
    // Switch on: the one plain line first, the paths folded (a newcomer cannot judge them, the curious can open them).
    const plain = w.lead ? h('div', h('p.sheet-text', w.lead), fold('link-what', 'What exactly', ...what)) : h('div', ...what);
    return [plain, out, actions];
  }).then((v) => v === true);
}

/**
 * The note with the "Switch on" button (the same word as Get started's skills step), for any page: empty while it loads and when there is nothing to link (no
 * brain, everything linked, an older computer). `only`: kinds of link to look at, for every coding tool (['skills'] on
 * Skills also takes OpenCode's "opencode:skills"); `text(todo)` the sentence; `after()` once it linked. `prefix` as above.
 * `switchOn`: the Skills page's stored skills (the button and its sheet say Switch on); else Link, the AI brain page's word.
 */
/** The note's sentence: what is not linked yet, with "does" for one coding tool and "do" for more. */
export function noteWords(todo) {
  if (todo.every((e) => toolsOf(e).join() === 'claude')) return `Claude Code does not read ${todo.map((e) => e.what).join(', ').replace(/, ([^,]*)$/, ' and $1')} from the AI brain yet.`;
  const one = new Set(todo.flatMap(toolsOf)).size === 1;
  return `Not everything is linked yet: ${whoReads(todo).replace(/ reads?$/, '')} ${one ? 'does' : 'do'} not read all of the AI brain.`;
}

/** The line of Memory's banner while the brain is not linked: what switching on does, in plain words. */
export const SWITCH_ON_NOTE = 'Switch on so your coding tools use these rules, skills and memory. Nothing is deleted.';

export function linkBrainNote({ only = null, text = null, after = () => {}, prefix = '', switchOn = false } = {}) {
  const box = h('div.bl-note-slot');
  async function load() {
    let plan;
    try {
      plan = await api(`${prefix}/api/workspace/link`);
    } catch {
      return fill(box); // an older computer without the route, or no brain: nothing to offer
    }
    const todo = plan.entries.filter((e) => !LEFT.includes(e.action) && (!only || only.includes(String(e.id).split(':').pop())));
    if (!plan.brain || !todo.length) return fill(box);
    const said = text ? text(todo) : switchOn ? SWITCH_ON_NOTE : noteWords(todo);
    fill(box, h('div.banner.info.bl-note', { role: 'status' }, icon('brain', { size: 18 }),
      h('span.bl-note-text', said),
      btn('small primary', { icon: 'check', label: switchOn ? 'Switch on' : 'Link', onclick: async () => {
        if (await linkBrainSheet(() => {}, { prefix, switchOn })) {
          await load();
          after();
        }
      } })));
  }
  load();
  return box;
}

const STATE = {
  linked: ['check', 'Linked: it reads the brain\'s rules, skills and memory'],
  todo: ['alert', null],
  left: ['minus', 'Something is in the way; see Link for why'],
};

/**
 * A coding tool's links still to make, counted and named by their short names (the server's count is of these):
 * "Not linked yet: 4 links to make (rules, skills, settings, memory note), 1 in the way".
 */
export function todoWords(t, entries = []) {
  const todo = entries.filter((e) => (e.tools || []).includes(t.id) && !['already', 'conflict'].includes(e.action) && !e.error).map((e) => e.short || e.what);
  const n = todo.length || t.todo;
  return `Not linked yet: ${n} link${n === 1 ? '' : 's'} to make${todo.length ? ` (${todo.join(', ')})` : ''}${t.left ? `, ${t.left} in the way` : ''}`;
}

/**
 * The AI brain page's "Coding tools": per coding tool that is on, whether it reads the brain (linked, n to link, or
 * something in the way), and one "Link" button for all of them. An older computer (no per-tool state) gets the note.
 */
export function toolsPart({ after = () => {}, prefix = '' } = {}) {
  const box = h('div.bl-tools');
  async function load() {
    let plan;
    try {
      plan = await api(`${prefix}/api/workspace/link`);
    } catch {
      return fill(box);
    }
    if (!plan.brain) return fill(box);
    if (!Array.isArray(plan.tools)) return fill(box, linkBrainNote({ only: ['rules', 'memory'], after, prefix }));
    const rows = plan.tools.map((t) => {
      const [ic, text] = STATE[t.state] || STATE.todo;
      return h(`div.row.static.bl-tool-row.bl-${t.state}`,
        h('span.row-icon.bl-mark', icon(ic, { size: 15 })),
        h('span.row-main', h('span.row-title', t.name),
          h('span.row-sub', text || todoWords(t, plan.entries))));
    });
    fill(box,
      groupHead('Coding tools', plan.tools.length),
      h('div.rows', rows),
      plan.todo ? h('div.savebar.start', h('span.hint', 'Link shows each link before it is made.'), btn('primary', { icon: 'check', label: 'Link', onclick: async () => {
        if (await linkBrainSheet(() => {}, { prefix })) {
          await load();
          after();
        }
      } })) : null);
  }
  load();
  return box;
}
