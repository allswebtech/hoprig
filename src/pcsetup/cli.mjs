// `hoprig pc …` and `hoprig project …`: one entry point, `main(command, args)`, returning the exit code.
//   pc status [--json] [--offline] [--projects <dir>]   what is there, what is missing, what needs attention
//   pc setup  [--yes] [--dry-run] [--kits a,b] [--recipe <file|https>] [--no-projects]
//   pc recipe save [file] [--with-email]                  "make my next computer like this one"
//   pc clone <repo>...                                    clone into the projects folder (+ dependency install)
//   pc leave --check [--also <folder>]… [--json]          what exists only here, before a format (leavecli.mjs)
//   project …                                             project workspaces (project.mjs)
//   get <name>…                                           = project clone (getproject.mjs)
import fs from 'node:fs';
import { formatResults } from '../setup/doctor.mjs';
import { bold } from '../setup/ui.mjs';
import { makeUi } from '../setup/ui.mjs';
import { detectKits, gitIdentity, sysFacts } from './detect.mjs';
import { KITS } from './kits.mjs';
import { projectMain } from './project.mjs';
import { projectRemotes, projectsDir } from './projects.mjs';
import { makeRecipe } from './recipe.mjs';
import { pcSetup, projectsStep } from './setup.mjs';
import { GROUPS, exitCode, pcStatus } from './status.mjs';
import { listWorkspaces } from './workspace.mjs';

export const USAGE = `usage:
  hoprig pc status [--json] [--offline]       what this computer has, what is missing, what needs attention
  hoprig pc setup [--yes] [--dry-run] [--kits ${KITS.map((k) => k.id).join(',')}] [--recipe <file|https address>]
  hoprig pc recipe save [file] [--with-email]  write a recipe to set up another computer like this one
  hoprig pc clone <git address | owner/repo>…  clone into the projects folder
  hoprig pc leave --check [--also <folder>]… [--json]  what exists only on this computer, before a format (reads only)
  hoprig project new|add|clone|status|sync|link …   project workspaces (docs/PC-SETUP.md)
  hoprig get <name | owner/name | git address>…     get projects (= project clone)`;

export async function status(args, { write = (s) => process.stdout.write(s), sys } = {}) {
  const known = ['--json', '--offline', '--projects'];
  const bad = args.filter((a, i) => a.startsWith('-') && !known.includes(a) && args[i - 1] !== '--projects');
  if (bad.length) {
    write(`${USAGE}\n`);
    return 2;
  }
  const pi = args.indexOf('--projects');
  const projects = pi >= 0 && args[pi + 1] ? args[pi + 1] : projectsDir();
  const checks = await pcStatus({ sys: sys || (await sysFacts()), offline: args.includes('--offline'), projects });
  const code = exitCode(checks);
  if (args.includes('--json')) {
    write(JSON.stringify({ ok: code === 0, checks }, null, 2) + '\n');
    return code;
  }
  write(`\n${bold('hoprig pc status')}\n`);
  for (const [g, title] of Object.entries(GROUPS)) {
    const list = checks.filter((c) => c.group === g);
    if (list.length) write(`\n${bold(title)}\n${formatResults(list)}\n`);
  }
  const fails = checks.filter((c) => c.status === 'fail').length;
  write(`\n${fails ? `${fails} thing${fails > 1 ? 's' : ''} missing (✗): run the fix under each one (hoprig pc setup installs the kits).` : 'Everything needed is here.'}\n`);
  return code;
}

/**
 * The kits a recipe of this computer names: a default kit with anything of it here, an optional kit only when it is
 * complete here (a MySQL server alone is no reason to put PHP on the next computer).
 */
export function recipeKits(found) {
  const here = (k) => (found[k.id] || []).filter((i) => i.state !== 'na' && !['identity', 'signin'].includes(i.id));
  return KITS.filter((k) => (k.defaultOn ? here(k).some((i) => i.state === 'ok') : here(k).length > 0 && here(k).every((i) => i.state === 'ok'))).map((k) => k.id);
}

/** The recipe of this computer (kits that are complete here, versions as information, the projects). */
export async function currentRecipe({ withEmail = false, sys } = {}) {
  const s = sys || (await sysFacts());
  const found = await detectKits(s);
  const kits = recipeKits(found);
  const tools = {};
  for (const k of KITS) for (const i of found[k.id] || []) if (i.version) tools[i.id] = i.version;
  const dir = projectsDir();
  const workspaces = new Set(listWorkspaces(dir));
  const all = await projectRemotes(dir);
  const { capture } = await import('../setup/system.mjs');
  const { gitRead } = await import('../gitread.mjs');
  const wsUrls = [];
  for (const w of workspaces) {
    const r = await gitRead(w, ['config', '--get', 'remote.origin.url'], { run: capture });
    if (r.ok) wsUrls.push(r.stdout.trim());
  }
  const repos = all.filter((u) => !wsUrls.includes(u));
  const { TOOLS } = await import('../codetools/index.mjs');
  const codingTools = TOOLS.filter((t) => t.managed && t.installedVersion()).map((t) => t.id);
  return makeRecipe({ kits, tools, codingTools, projectsDir: dir, repos, workspaces: all.filter((u) => wsUrls.includes(u)), identity: await gitIdentity(s), withEmail });
}

export async function main(command, args = []) {
  const ui = makeUi({});
  const write = (s) => process.stdout.write(s);
  if (command === 'project') return projectMain(args, { ui, write });
  if (command === 'get') return (await import('./getproject.mjs')).getMain(args, { ui, write });
  const [sub, ...rest] = args;
  switch (sub) {
    case 'status':
      return status(rest, { write });
    case 'setup':
      return pcSetup(rest, { ui });
    case 'recipe': {
      if (rest[0] !== 'save') {
        write(`${USAGE}\n`);
        return 2;
      }
      const file = rest.slice(1).find((a) => !a.startsWith('-'));
      const recipe = await currentRecipe({ withEmail: rest.includes('--with-email') });
      const text = JSON.stringify(recipe, null, 2) + '\n';
      if (!file) write(text);
      else {
        fs.writeFileSync(file, text, { flag: 'wx' });
        write(`Saved ${file}: on the next computer run  hoprig pc setup --recipe ${file}\n`);
      }
      return 0;
    }
    case 'clone': {
      if (!rest.length) {
        write(`${USAGE}\n`);
        return 2;
      }
      ui.yes = rest.includes('--yes');
      const repos = rest.filter((a) => !a.startsWith('-'));
      const sys = await sysFacts();
      const r = await projectsStep(ui, sys, { recipe: { repos } });
      return r.failed.length ? 1 : 0;
    }
    case 'leave':
      return (await import('../workspace/leavecli.mjs')).leaveMain(rest, { write });
    default:
      write(`${USAGE}\n`);
      return sub ? 2 : 0;
  }
}
