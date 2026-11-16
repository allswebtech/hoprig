// Linking the coding tools' folders into the AI brain from the page (GET/POST /api/workspace/link,
// src/workspace/link.mjs): the one helper every place uses that would otherwise say "run hoprig workspace link" (the
// AI brain page, Skills, Get started, a computer's Setup tab, Settings → Workspace). A sheet says what will happen to
// each link, grouped by coding tool, then "Link" does it and says what was done; nothing is overwritten (a conflict is
// left alone with its reason). toolsPart() is the AI brain page's "Coding tools": the state per tool, one button.
import { icon } from './icons.js';
import { TOOL_NAMES, api, btn, fill, h, openSheet } from './lib.js';
import { errorBox, groupHead, okBox } from './shell.js';

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

/** "Claude Code and Codex read": the coding tools of these entries, with the verb that fits. */
const whoReads = (entries) => {
  const ids = [...new Set(entries.flatMap(toolsOf))];
  return `${ids.map(toolName).join(', ').replace(/, ([^,]*)$/, ' and $1') || 'Your coding tools'} read${ids.length === 1 ? 's' : ''}`;
};

/**
 * The sheet: the plan, then "Link". `after()` runs once links were made. `prefix`: '' for the open computer, '~'
 * for this dashboard itself (Get started). Resolves with true when it linked.
 */
export async function linkBrainSheet(after = () => {}, { prefix = '' } = {}) {
  let plan;
  try {
    plan = await api(`${prefix}/api/workspace/link`);
  } catch (e) {
    return void openSheet({ title: 'Link the AI brain' }, (close) => [errorBox(e.message), h('div.sheet-actions', btn('secondary', { label: 'Close', onclick: () => close() }))]);
  }
  return openSheet({ title: 'Link the AI brain', subtitle: `So ${whoReads(plan.entries)} the same rules, skills and memory from the AI brain, and they travel with it.` }, (close) => {
    const out = h('div');
    const actions = h('div.sheet-actions');
    if (!plan.todo) {
      fill(actions, btn('primary', { label: 'Close', onclick: () => close() }));
      return [plan.already ? okBox('Everything is linked already.') : h('p.sheet-text', 'Nothing can be linked now:'), plan.already ? null : entryList(plan.entries, false), actions];
    }
    const go = btn('primary', { icon: 'check', label: 'Link', onclick: async () => {
      go.disabled = true;
      go.classList.add('busy');
      try {
        const r = await api(`${prefix}/api/workspace/link`, {});
        const bad = r.entries.filter((e) => e.error).length;
        fill(out, bad ? errorBox(`${bad} could not be linked; the rest is done.`) : okBox(r.entries.some((e) => e.action === 'conflict') ? 'Linked. What was in the way is left as it was.' : `Linked. ${whoReads(r.entries)} these from the AI brain now.`),
          entryList(r.entries, true));
        list.remove();
        intro.remove();
        fill(actions, btn('primary', { label: 'Done', onclick: () => close(true) }));
        after();
      } catch (e) {
        fill(out, errorBox(e.message));
        go.disabled = false;
        go.classList.remove('busy');
      }
    } });
    fill(actions, btn('secondary', { label: 'Cancel', onclick: () => close() }), go);
    const intro = h('p.sheet-text', 'What will happen to each link:');
    const list = entryList(plan.entries, false);
    return [intro, list, h('p.hint', 'Nothing is overwritten: a file or folder that is moved is kept as a dated backup next to where it was.'), out, actions];
  }).then((v) => v === true);
}

/**
 * The note with the "Link now" button, for any page: empty while it loads and when there is nothing to link (no
 * brain, everything linked, an older computer). `only`: link ids to look at (e.g. ['skills'] on Skills); `text(plan)`
 * the sentence; `after()` once it linked. `prefix` as above.
 */
export function linkBrainNote({ only = null, text = null, after = () => {}, prefix = '' } = {}) {
  const box = h('div.bl-note-slot');
  async function load() {
    let plan;
    try {
      plan = await api(`${prefix}/api/workspace/link`);
    } catch {
      return fill(box); // an older computer without the route, or no brain: nothing to offer
    }
    const todo = plan.entries.filter((e) => !LEFT.includes(e.action) && (!only || only.includes(e.id)));
    if (!plan.brain || !todo.length) return fill(box);
    const said = text ? text(todo) : todo.every((e) => toolsOf(e).join() === 'claude')
      ? `Claude Code does not read ${todo.map((e) => e.what).join(', ').replace(/, ([^,]*)$/, ' and $1')} from the AI brain yet.`
      : `Not everything is linked yet: ${whoReads(todo).replace(/ reads?$/, '')} do not read all of the AI brain.`;
    fill(box, h('div.banner.info.bl-note', { role: 'status' }, icon('brain', { size: 18 }),
      h('span.bl-note-text', said),
      btn('small primary', { icon: 'check', label: 'Link now', onclick: async () => {
        if (await linkBrainSheet(() => {}, { prefix })) {
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
 * A coding tool's links still to make, counted and named from the same entries (the server's count is of these):
 * "Not linked yet: 2 links to make (rules, memory), 1 in the way".
 */
export function todoWords(t, entries = []) {
  const todo = entries.filter((e) => (e.tools || []).includes(t.id) && !['already', 'conflict'].includes(e.action) && !e.error).map((e) => e.what);
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
