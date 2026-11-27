// Settings → Hands-off: the project's switch and its note (src/server/handsoff.mjs). What it answers and what it never
// does is said here in plain words, the same as in docs/HANDS-OFF.md.
import { openConsentSheet, uncoveredLine } from './handsoff.js';
import { api, fill, h, toast } from './lib.js';
import { registerSettingsPage } from './registry.js';
import { field, fold, panel, saveBar, toggle } from './shell.js';

const WHAT = 'With Hands-off on, Hoprig answers by itself, with no AI: a question gets the option the coding tool marked as recommended; a question with no mark gets your note for the project, where the tool takes a written answer; a plan in the App is approved and the session keeps the mode it had. Tool permissions follow the session\'s mode as always.';
const NEVER = 'The first check, the net, reads a question\'s words for a fixed list of signs — money or a paid plan, a sign-in, a push or a merge, a release or publishing, sending something out, a delete outside the folder, admin rights, switching a safety rule off, or giving the session more freedom — and leaves those to you, also when an option is marked as recommended. It only ever makes a question wait: it leans towards waiting, so it can hold an ordinary question and an unusual wording can slip past it. Every answer is shown on the session and in Activity; one press on the session or on the project\'s switch stops it; three answers in a row with no work between them, or ten within an hour, stop it too. It is off after an install and after every update.';
const WALL = 'The second check, the wall, reads what a session is about to do, at the act, and holds it as your card in every permission mode: administrator rights, publishing or a release, a pull or merge request, a push that would move a default branch or a tag, a delete outside the session\'s folder, and a move or write to Hoprig\'s own files. A command it cannot read with certainty waits for you. This is the part that holds; the net only makes a question wait.';

// A project's name is its folder's last part; the whole path stands under it.
const folderName = (dir) => String(dir).replace(/\/+$/, '').split('/').pop() || dir;

/** One project's row. `draft`: a note typed but not saved yet (kept over a reload of the list). */
function projectRow(p, reload, draft) {
  const note = h('textarea.field', { rows: 3, maxlength: 2000, placeholder: 'How you want such questions answered, for example: "Choose the option with the fewest new dependencies."', 'aria-label': `Your note for ${p.dir}` }, p.note || '');
  note.value = typeof draft === 'string' ? draft : p.note || '';
  note.dataset.dir = p.dir;
  note.dataset.saved = p.note || '';
  return h('div.ho-project',
    h('p.ho-project-path.hint', p.dir),
    toggle(folderName(p.dir), p.on, async (on) => {
      await api('/api/handsoff/project', { dir: p.dir, on });
      if (on === true) openConsentSheet(); // the first time any switch is turned on, this browser sees the sheet once
      reload(); // the row is drawn again, with the line about sessions it cannot cover (uncovered) while they run
    }, p.stale ? 'It was turned off by the update; turn it on again.' : p.on ? 'On for every session in this folder that has no switch of its own.' : 'Off.'),
    // Sessions in this folder that started before Hands-off could hold their commands: the switch answers their
    // questions but holds none of their acts. Named on every read of the project, so the line stays while they run.
    uncoveredLine(p.uncovered),
    field('Your note for this project', note),
    saveBar('Save the note', () => api('/api/handsoff/project', { dir: p.dir, note: note.value }).then(reload)));
}

function render() {
  const list = h('div.ho-projects', h('p.muted', 'Loading…'));
  const dir = h('input.field', { type: 'text', placeholder: '~/projects/shop', 'aria-label': 'Folder of a project' });
  const reload = async () => {
    // A note typed in a row and not saved yet stays as typed (the list is drawn anew after each change).
    const drafts = new Map((list.querySelectorAll ? [...list.querySelectorAll('textarea[data-dir]')] : []).filter((t) => t.value !== t.dataset.saved).map((t) => [t.dataset.dir, t.value]));
    try {
      const r = await api('/api/handsoff');
      fill(list, r.projects.length ? r.projects.map((p) => projectRow(p, reload, drafts.get(p.dir))) : h('p.muted', 'No project has Hands-off yet.'));
    } catch (e) {
      fill(list, h('p.form-error', e.message));
    }
  };
  reload();
  return [
    panel({ icon: 'sparkle', title: 'What Hands-off answers', desc: WHAT },
      fold('handsoff-decides', 'How it decides what to leave to you', h('p.hint', NEVER), h('p.hint', WALL)),
      h('button.btn.secondary.small', { type: 'button', onclick: () => openConsentSheet({ always: true }) }, 'Read the first-time summary again')),
    panel({ icon: 'folder', title: 'Projects', desc: 'Turn it on per project. A session can also be turned on or stopped on its own page.' },
      list,
      field('Add a project folder', dir, 'Its full path, or one that starts with ~ for your home folder.'),
      saveBar('Add (off until you turn it on)', async () => {
        if (!dir.value.trim()) return toast('Write the folder first', { kind: 'error' });
        await api('/api/handsoff/project', { dir: dir.value.trim(), on: false });
        dir.value = '';
        reload();
      })),
  ];
}

registerSettingsPage({
  id: 'handsoff', title: 'Hands-off', icon: 'sparkle', order: 25,
  // Shown unless the owner hid the feature (handsOff.offered:false): the server sends offered as the shipped default.
  when: (ctx) => !!(ctx && ctx.settings && ctx.settings.handsOff && ctx.settings.handsOff.offered),
  desc: 'Let Hoprig answer the questions a coding tool marks as recommended, or with your note, so the work goes on without you.',
  summary: async () => {
    const r = await api('/api/handsoff');
    const on = r.projects.filter((p) => p.on).length;
    return on ? `On in ${on} project${on > 1 ? 's' : ''}` : 'Off';
  },
  render,
});
