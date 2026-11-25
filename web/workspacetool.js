// A group's own command on the Workspace page (src/workspace/toolweb.mjs, docs/WORKSPACE.md "A group's own command"):
// under the groups, each command a group of the map names, what it is, what this computer lacks for it and its state
// here. The yes is a sheet that shows what it makes first (the dry run) and makes it only on "Allow on this computer",
// for exactly what the sheet showed; "Remove the command from this computer" is its undo. Nothing here starts it.
import { icon } from './icons.js';
import { api, btn, confirmSheet, fill, h, link, openSheet, toast } from './lib.js';
import { errorBox } from './shell.js';
import { KIT_TITLES } from './tiaactivity.js';

/** The state of a group's command on this computer, in the page's words: [badge, sentence or null]. */
export function stateWords(t) {
  if (t.state === 'waits' && t.changed) return ['Asks again', `The map changed it since your yes (${t.why.replace(/^the map changed it, /, '')}): it is made again only after a new yes.`];
  return ({
    waits: ['Waits for your yes', 'It is made on this computer only after your yes.'],
    made: ['Allowed here', null],
    blocked: ['Would not start', `It would not start now: ${t.why}.`],
    stale: ['Cannot start', `It cannot start: ${t.why}. A new yes makes it again.`],
    gone: ['Missing', 'Your yes is kept, but the command is not on this computer any more. A new yes makes it again.'],
    absent: ['Group not here', 'The group is not on this computer, so there is nothing to allow yet.'],
  })[t.state] || [t.state, t.why || null];
}

/** What the command is, in sentences: the file it starts, that arguments pass unchanged, and what this computer lacks. */
export function toolLines(t) {
  const out = [`Starts ${t.run} in the group's folder, with every argument passed on unchanged. Hoprig never runs it by itself.`];
  for (const m of t.missing || []) out.push(`Needs ${m.program}, which this computer does not have${m.kit ? `: ${KIT_TITLES[m.kit] || m.kit} in Set up this computer installs it` : ''}.`);
  const [, said] = stateWords(t);
  if (said) out.push(said);
  return out;
}

/** The sheet's words for the dry run of the yes (POST /api/workspace/tools/allow { dryRun: true }). */
export function allowWords(p) {
  const bin = p.launcher.slice(0, p.launcher.lastIndexOf('/')) || p.launcher;
  return [
    `The group ${p.group} (${p.url}) names its own command ${p.name}. It starts ${p.file}.`,
    `Hoprig writes a small command ${p.name} at ${p.launcher}. At every start Hoprig checks again that the group is here with this address, that the map still says this name and file, and that the group's own repository tracks the file; only then it runs the file, with your arguments unchanged.`,
    'Hoprig never runs it by itself. You can remove it from this computer here at any time.',
    p.removed ? `The command it made before (${p.removed}) goes.` : null,
    p.onPath ? null : `${bin} is not on your PATH: to run ${p.name} by its name, add that folder to your shell's start file (Hoprig does not edit it).`,
  ].filter(Boolean);
}

/** The yes: what it makes is asked first, then made for exactly what the sheet showed. Resolves true when made. */
export async function allowSheet(group, after = () => {}) {
  let plan;
  try {
    plan = await api('/api/workspace/tools/allow', { group, dryRun: true });
  } catch (e) {
    toast(e, { kind: 'error', ms: 8000 });
    return false;
  }
  return openSheet({ title: `Allow the command ${plan.name} on this computer?` }, (close) => {
    const state = h('div', { 'aria-live': 'polite' });
    const yes = btn('primary', { icon: 'check', label: 'Allow on this computer', onclick: async () => {
      yes.disabled = true;
      try {
        await api('/api/workspace/tools/allow', { group, seen: plan.seen });
        toast(`${plan.name} is a command on this computer now`);
        close(true);
        after();
      } catch (e) {
        yes.disabled = false;
        fill(state, errorBox(e));
      }
    } });
    return [...allowWords(plan).map((t, i) => h(i ? 'p.hint' : 'p.sheet-text', t)), state,
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', autofocus: true, onclick: () => close(false) }, 'Not now'), yes)];
  }).then((v) => v === true);
}

/** The undo: what goes is asked first (removeTool's dry run), then only Hoprig's own launcher goes, and the yes. */
export async function removeSheet(group, after = () => {}) {
  let look;
  try {
    look = await api('/api/workspace/tools/remove', { group, dryRun: true });
  } catch (e) {
    return void toast(e, { kind: 'error', ms: 8000 });
  }
  const what = look.removed.length ? `${look.removed.join(', ')} is removed` : 'There is no command of Hoprig\'s for it here to remove';
  const ok = await confirmSheet({ title: `Remove ${look.name || 'the command'} from this computer?`, text: `${what}, and your yes is forgotten on this computer. The group and its file stay as they are.`, ok: 'Remove the command' });
  if (!ok) return;
  try {
    await api('/api/workspace/tools/remove', { group });
    toast(`${look.name || 'The command'} is removed from this computer`);
    after();
  } catch (e) {
    toast(e, { kind: 'error', ms: 8000 });
  }
}

function toolRow(t, reload) {
  const [badge] = stateWords(t);
  const canAllow = ['waits', 'gone', 'stale'].includes(t.state) || (t.state === 'blocked' && t.fix === 'allow');
  const canRemove = ['made', 'gone', 'stale'].includes(t.state) || (t.state === 'blocked' && t.fix !== 'restore');
  return h('div.row.static.ws-tool',
    h('span.row-icon', icon('terminal')),
    h('span.row-main',
      h('span.row-title', t.name, h('span.badge.soft', badge)),
      h('span.row-sub', `The command of the group ${t.group}`),
      toolLines(t).map((l) => h('span.row-sub.pj-wrap', l)),
      t.missing && t.missing.some((m) => m.kit) ? h('span.row-sub.pj-wrap', h('a', { href: link('#/computer/setup') }, 'Set up this computer')) : null),
    canAllow || canRemove ? h('div.mrow-actions',
      canAllow ? btn('small primary', { icon: 'check', label: 'Allow on this computer', onclick: () => allowSheet(t.group, reload) }) : null,
      canRemove ? btn('small ghost', { icon: 'minus', label: 'Remove the command from this computer', onclick: () => removeSheet(t.group, reload) }) : null) : null);
}

/** The commands of the map's groups (GET /api/workspace/tools), under the groups; nothing when no group names one. */
export function groupTools(reload = () => {}) {
  const box = h('div.ws-group-tools');
  const draw = async () => {
    let r;
    try {
      r = await api('/api/workspace/tools');
    } catch (e) {
      // An older Hoprig on another computer has no such route: nothing to say then.
      return void fill(box, e.status === 404 ? null : errorBox(`The groups' commands could not be read: ${e.message}`));
    }
    const again = () => (draw(), reload());
    fill(box, r.tools.length ? [h('p.field-label', 'Commands of your groups'), h('div.rows', r.tools.map((t) => toolRow(t, again)))] : null);
  };
  draw();
  return box;
}
