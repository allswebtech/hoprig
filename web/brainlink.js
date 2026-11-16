// Linking Claude Code's folder into the AI brain from the page (GET/POST /api/workspace/link, src/workspace/link.mjs):
// the one helper every place uses that would otherwise say "run hoprig workspace link" (the AI brain page, Skills,
// Get started, a computer's Setup tab, Settings → Workspace). A sheet says what will happen to each link, then
// "Link" does it and says what was done; nothing is overwritten (a conflict is left alone with its reason).
import { icon } from './icons.js';
import { api, btn, fill, h, openSheet } from './lib.js';
import { errorBox, okBox } from './shell.js';

const LEFT = ['already', 'conflict'];
const mark = (e) => (e.error ? 'alert' : e.action === 'conflict' ? 'minus' : 'check');

/** One line per link: what it is for, where, and what happens (or happened) to it. */
function entryList(entries, after) {
  return h('ul.bl-list', entries.map((e) => h(`li.bl-item${e.error ? '.bad' : e.action === 'conflict' ? '.left' : e.action === 'already' ? '.ok' : ''}`,
    h('span.bl-mark', icon(mark(e), { size: 14 })),
    h('span.bl-body',
      h('span.bl-what', e.what[0].toUpperCase() + e.what.slice(1)),
      h('span.bl-path', h('code', e.link), ' → ', h('code', e.target)),
      h('span.bl-words', after ? (e.error ? `Not done: ${e.error}` : e.done) : e.words)))));
}

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
  return openSheet({ title: 'Link the AI brain', subtitle: 'So Claude Code reads its rules, skills and memory from the AI brain, and they travel with it.' }, (close) => {
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
        fill(out, bad ? errorBox(`${bad} could not be linked; the rest is done.`) : okBox(r.entries.some((e) => e.action === 'conflict') ? 'Linked. What was in the way is left as it was.' : 'Linked. Claude Code reads these from the AI brain now.'),
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
    const said = text ? text(todo) : `Claude Code does not read ${todo.map((e) => e.what).join(', ').replace(/, ([^,]*)$/, ' and $1')} from the AI brain yet.`;
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
