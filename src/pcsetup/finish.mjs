// What a fresh clone of a project gets set up, and the one place where each of it is done, said or asked:
//   memory     Claude Code's memory folder for the project linked to the one in its repository
//   hooks      git's hooks path set to the repository's .githooks
//   env        .env made from .env.example (the owner fills in its values)
//   install    the dependency install of each repository, always asked
// A fresh clone (`hoprig get`, `workspace restore`, `project setup`) does them. A dry run only says each one. A project
// that was already on this computer is not changed by a get or a restore: what is missing is said with the one
// command that does it (`hoprig project setup <name>`), or asked item by item when a person is at a terminal.
import fs from 'node:fs';
import path from 'node:path';
import { stream } from '../setup/system.mjs';
import { sysFacts } from './detect.mjs';
import { prepareEnv, projectNeeds, projectsDir } from './projects.mjs';
import { runInstall } from './setup.mjs';
import { hooksToUse, linkMemory, planMemories, useHooks } from './workspace.mjs';
import { leaves, leavesWords } from '../workspace/inside.mjs';

/**
 * The memory links of a member that comes with its group's repository, planned (its own memory, else the group's:
 * groups.mjs), for finishProject's `memories`. `ref`: <place>/<name>.
 */
export async function groupPlan(ref) {
  const { planGroupMemories } = await import('../workspace/groups.mjs');
  const { groupsMap } = await import('../workspace/where.mjs');
  const { workspaceDir } = await import('../workspace/layout.mjs');
  return planGroupMemories(groupsMap(), { dir: workspaceDir(), projects: projectsDir() }, { only: ref });
}

/** The lines `project link` and a fresh clone print for the memory links made (linkMemories' result). */
export function report(ui, links) {
  for (const l of links) ui.line(l.done === 'conflict' ? 'warn' : 'ok', `memory for ${l.launch === '.' ? 'the project' : l.launch}: ${l.done}${l.detail ? ` (${l.detail}; ${l.fix})` : ''}`);
}

// A planned link's launch folder in words: its key in project.json, or (a group's pairs are absolute) its path inside the project.
const launchName = (p, root) => {
  const l = path.isAbsolute(p.launch) ? path.relative(root, p.launch) || '.' : p.launch;
  return l === '.' ? 'the project' : l;
};

const named = (l, root) => ({ ...l, launch: path.isAbsolute(l.launch) ? path.relative(root, l.launch) || '.' : l.launch });

const memoryWords = (p, root) => {
  const what = `Claude Code's memory for ${launchName(p, root)}`;
  const to = path.relative(root, p.memory);
  return p.action === 'merge' ? `move the files of ${what} into ${to}, keep its old folder as a backup, and link it there` : `link ${what} to ${to}`;
};

/**
 * Everything a fresh clone would set up in the project at `root` and that is not there yet, read only:
 * [{ kind, dir, what, do }] (`what`: plain words after "would"; `do()` does it and says so), and `notes`: what is in
 * the way or missing on the computer (said in every case, never done).
 */
export async function setupItems(root, manifest, { ui, dir, runner = stream, sys, ref, memories = null, at = {} }) {
  const items = [];
  const notes = [];
  // A folder named as commands name its project (<place>/<name> in a group), then its path inside the project.
  const name = ref || path.basename(root);
  const rel = (d) => (path.resolve(d) === path.resolve(root) ? name : `${name}/${path.relative(root, d)}`);
  // `memories`: the planned links when they are not the project's own (a member that comes with its group's
  // repository uses the group's: groups.mjs planGroupMemories). An entry's folder is where its session starts, so a
  // code repository this run cloned into a project that was here gets its link like a fresh clone.
  for (const p of memories || planMemories(root, manifest.memories, { ref })) {
    if (p.action === 'already') continue;
    if (p.action === 'conflict') notes.push(`memory for ${launchName(p, root)}: left alone (${p.detail}; ${p.fix})`);
    // linkMemory checks once more right before the link is made (inside.mjs): the plan may be a moment old.
    else items.push({ kind: 'memory', dir: p.launchAbs || root, what: memoryWords(p, root), do: async () => report(ui, [named(linkMemory(p, { at }), root)]) });
  }
  // Only folders really inside the project (inside.mjs): a code folder that leads out (project.json names code/web
  // where code is a link to elsewhere) gets no hooks setting, no .env and no install; it is said instead.
  const dirs = [];
  for (const d of [root, ...manifest.repos.map((r) => path.join(root, r.dir))].filter((x) => fs.existsSync(x))) {
    const out = leaves(root, d, at);
    if (out) notes.push(`${rel(d)}: not followed: ${leavesWords(out)}`);
    else dirs.push(d);
  }
  for (const d of dirs) {
    if (await hooksToUse(d)) items.push({ kind: 'hooks', dir: d, what: `use the git hooks in .githooks for ${rel(d)}`, do: async () => (await useHooks(d, undefined, root, at)) && ui.line('ok', `${rel(d)}: git hooks from .githooks`) });
  }
  for (const d of dirs) {
    const n = projectNeeds(d, { has: sys.has });
    if (n.envExample) items.push({ kind: 'env', dir: d, what: `copy .env.example to .env in ${rel(d)}`, do: () => prepareEnv(d, (l) => ui.line('info', l), root, at) });
    if (n.node && !n.node.ok) notes.push(`${rel(d)} wants Node ${n.node.wants}, this computer has ${n.node.have}: run nvm install in ${d}`);
    for (const i of n.installs) {
      if (!i.ready) notes.push(`${rel(d)}: ${i.label} — ${i.why}`);
      else items.push({ kind: 'install', dir: d, what: `run ${i.label} in ${rel(d)}`, question: `${path.basename(d)}: run ${i.label}? (installs its dependencies)`, do: () => runInstall(ui, d, i, runner, { root, at }) });
    }
  }
  return { items, notes };
}

/**
 * Set up a project after its repositories are there. `fresh`: true when this run cloned the project (everything is
 * done; a dependency install is asked first, as always), else the folders this run cloned into a project that was
 * already here (only those are set up; for the rest each item is asked at a terminal, else said). With ui.dryRun
 * nothing is done: each item is said. `kinds`: only these kinds of items (a group's own folder gets its memory link
 * only); `command`: the one that does what is said (else `hoprig project setup <name>`).
 * → { items: how many were to set up, left: [what was not done and is said] }
 */
export async function finishProject(root, manifest, { ui, dir, runner = stream, fresh = true, sys = null, ref = null, memories = null, kinds = null, command = null, at = {} }) {
  const name = ref || path.basename(root); // how commands name it: <place>/<name> in a group
  const all = await setupItems(root, manifest, { ui, dir, runner, sys: sys || (await sysFacts()), ref: name, memories, at });
  const items = kinds ? all.items.filter((it) => kinds.includes(it.kind)) : all.items;
  const notes = kinds ? all.notes.filter((n) => (n.startsWith('memory ') ? kinds.includes('memory') : kinds.some((k) => k !== 'memory'))) : all.notes;
  for (const n of notes) ui.line('warn', n);
  const left = [];
  for (const it of items) {
    if (fresh === true || fresh.has(it.dir)) {
      if (it.kind === 'install') {
        if (await ui.confirm(it.question, true)) await it.do(); // a dry run: "would ask"
      } else if (ui.dryRun) ui.note(`(dry run) would ${it.what}`);
      else await it.do();
    } else if (ui.interactive && !ui.yes) {
      // A person is at the terminal: each item is theirs to choose, and nothing happens on Enter.
      if (await ui.confirm(`${name} was already here: ${it.what}?`, false)) await it.do();
    } else left.push(it.what);
  }
  if (left.length) ui.line('info', `${name} was already here, so nothing in it was changed. A fresh clone would also ${left.join('; ')}. To do that:  ${command || `hoprig project setup ${name}`}`);
  return { items: items.length, left };
}
