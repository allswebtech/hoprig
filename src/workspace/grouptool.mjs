// A group's own tool (docs/WORKSPACE.md, "A group's own tool"): a group that is a repository may name one command
// of its own in the map, `"tool": { "name": "kit", "run": "kit.sh", "needs": ["git", "jq"], "needsOn": { "mac": [...] } }`.
// What Hoprig does with it, and nothing more:
//   1. after the owner's yes on THIS computer (the group's address, the name and the file shown), it writes a small
//      launcher <name> into the folder of its own `hoprig` command. The launcher does not start the group's file: it
//      starts Hoprig (`hoprig workspace tool run <group> -- <arguments>`), which checks AT EVERY START and only then
//      replaces itself by the file (exec: the same arguments, exit code and signals);
//   2. status names the programs of `needs` this computer lacks, and the kit that installs one where Hoprig has it;
//   3. it never runs the tool by itself.
// A map is data from a git server, so a tool is not trusted by being written there. The yes (kept in Hoprig's own
// settings on this computer) is tied to what the owner was SHOWN: the group's address, the name and the run path. At
// every start the group must be on this computer with that address, the map must still say that name and run, and the
// run file must be a regular file really inside the group's folder (inside.mjs) that the group's own repository tracks
// (never one of another repository in its folder, nor one it does not track). Anything else: it does not start,
// says why in one sentence and how to allow it again. A name that is hop, hoprig or a command already on PATH is
// refused; nothing Hoprig did not make (a dangling link too) is replaced at the launcher's name. No shell start file is
// edited, nothing is written into a repository. Every look-up by a group's name goes through a Map (a group may be
// called `__proto__`).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRead } from '../gitread.mjs';
import { loadConfig, saveConfig } from '../config.mjs';
import { capture, which } from '../setup/system.mjs';
import { dim } from '../setup/ui.mjs';
import { KITS } from '../pcsetup/kits.mjs';
import { isGitRepo, projectsIn, workspaceDir } from './layout.mjs';
import { leaves, leavesWords, realOf } from './inside.mjs';
import { readMap, sameUrl } from './map.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
export const MARK = '# hoprig-group-tool:';
export const RESERVED = ['hop', 'hoprig'];
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const PLATFORM = { darwin: 'mac', linux: 'linux', win32: 'windows' };
const HOPRIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'hoprig.mjs');

/**
 * The folder Hoprig's own command is in: ~/.local/bin when `hoprig setup` put it there, else the folder of the
 * `hoprig` found on PATH, else ~/.local/bin.
 */
export function commandDir({ home = os.homedir(), env = process.env } = {}) {
  const local = path.join(home, '.local', 'bin');
  if (fs.existsSync(path.join(local, 'hoprig'))) return local;
  const found = which('hoprig', env);
  return found ? path.dirname(found) : local;
}

/** Is `dir` on PATH (so a command there is found by its name)? */
export const onPathDir = (dir, env = process.env) => String(env.PATH || '').split(path.delimiter).some((d) => d && path.resolve(d) === path.resolve(dir));

/** The marker line of a group's launcher: the group exactly (quoted), never a prefix of another group's. */
export const markerLine = (group) => `${MARK} ${JSON.stringify(group)}`;

/**
 * The launcher's text: it starts Hoprig, which checks the tool again and then becomes it. `argv`: how this Hoprig is
 * started (node and its own bin/hoprig.mjs, so the launcher never depends on a wrapper on PATH).
 */
export const launcherText = (group, argv = [process.execPath, HOPRIG]) => `#!/bin/sh\n${markerLine(group)}\n# Made by Hoprig after your yes. Hoprig checks the group's command again at every start. To take it away:  hoprig workspace tool remove ${group}\nexec ${argv.map(shq).join(' ')} workspace tool run ${shq(group)} -- "$@"\n`;

const lst = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
/** A launcher Hoprig made (for exactly this group when `group` is given): a regular file with the marker line. */
export const ourLauncher = (file, group = null) => {
  const st = lst(file);
  if (!st || !st.isFile()) return false;
  let second;
  try {
    second = fs.readFileSync(file, 'utf8').split('\n')[1];
  } catch {
    return false;
  }
  return typeof second === 'string' && (group === null ? second.startsWith(`${MARK} "`) : second === markerLine(group));
};

/**
 * The programs a launcher starts (its node and its bin/hoprig.mjs), as written in its exec line, or null. A launcher
 * names the paths of the Node and the Hoprig that made it: a Node upgrade (nvm, brew) or a checkout that went away
 * leaves it unable to start.
 */
export function launcherStarts(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const line = text.split('\n').find((l) => l.startsWith('exec '));
  if (!line) return null;
  const words = [...line.slice(5).matchAll(/'((?:[^']|'\\'')*)'/g)].slice(0, 2).map((m) => m[1].replace(/'\\''/g, "'"));
  return words.length === 2 ? words : null;
}

/** The yes kept on this computer: Map group → { name, run, url }. */
const yesOf = (cfg = loadConfig()) => new Map(cfg.groupTools && typeof cfg.groupTools === 'object' && !Array.isArray(cfg.groupTools) ? Object.entries(cfg.groupTools).filter(([, v]) => v && typeof v === 'object') : []);
const saveYes = (m) => saveConfig({ groupTools: Object.fromEntries(m) });
/** The map's groups by folder: a Map, never a plain object. */
const groupsOf = (map) => new Map(((map && map.groups) || []).map((g) => [g.dir, g]));

/** The programs of `needs` (and of `needsOn` for this system) that this computer lacks, each with a kit that has it. */
export function missingNeeds(tool, { env = process.env, platform = process.platform } = {}) {
  const want = [...(tool.needs || []), ...(((tool.needsOn || {})[PLATFORM[platform]]) || [])];
  return [...new Set(want)].filter((p) => !which(p, env, platform)).map((p) => {
    const kit = KITS.find((k) => k.items.some((i) => (i.bins || [i.id]).includes(p)));
    return { program: p, ...(kit ? { kit: kit.id, fix: `hoprig pc setup --kits ${kit.id}` } : {}) };
  });
}

/**
 * Why `run` may not be started, or null: a regular file really inside the group's folder (inside.mjs: no link that
 * leads out on the way, the group's folder where the map says), no link at its own name, executable, and a file of
 * the group's OWN repository: tracked by it (git ls-files), and not inside another repository in the group's folder.
 * The owner's yes is for the address he was shown; a folder of the group may hold another repository (a map's
 * "others" entry cloned into it, a member of a held folder) or files the group's repository ignores, which come from
 * somewhere else.
 */
export async function runProblem(groupDir, run, { at = {}, cmd = capture } = {}) {
  if (typeof run !== 'string' || !run || path.isAbsolute(run) || run.split('/').includes('..')) return `"${String(run).slice(0, 80)}" is not a file inside the group`;
  const file = path.join(groupDir, ...run.split('/'));
  const out = leaves(groupDir, groupDir, at) || leaves(groupDir, file, at);
  if (out) return `${leavesWords(out)}: a tool is never started through one`;
  const st = lst(file);
  if (!st) return `${run} is not in the group's folder`;
  if (st.isSymbolicLink()) return `${run} is a link: a tool is started only from a real file inside the group`;
  if (!st.isFile()) return `${run} is not a file`;
  if (process.platform !== 'win32' && !(st.mode & 0o111)) return `${run} is not executable (chmod +x it in the group's repository)`;
  const own = realOf(groupDir);
  const top = await gitRead(path.dirname(file), ['rev-parse', '--show-toplevel'], { run: cmd, timeout: 10_000 });
  const in_ = top.ok ? top.stdout.trim() : '';
  if (!in_ || in_ !== own) return `${run} is not a file of the group's repository (${in_ && in_.startsWith(own + path.sep) ? `it is in ${path.relative(own, in_).split(path.sep).join('/')}, another repository` : 'git does not find the group\'s repository there'})`;
  const tracked = await gitRead(groupDir, ['ls-files', '--error-unmatch', '--', run], { run: cmd, timeout: 10_000 });
  if (!tracked.ok) return `${run} is not a file of the group's repository (the repository does not track it)`;
  return null;
}

/** The address of the group's repository on this computer (its origin), or null. */
async function originOf(gdir, cmd) {
  if (!isGitRepo(gdir)) return null;
  const r = await gitRead(gdir, ['config', '--get', 'remote.origin.url'], { run: cmd, timeout: 10_000 });
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Why the group's command would not start now, or null: the same checks `tool run` makes at every start. `y`: the
 * yes kept for it ({ name, run, url }). → { why, fix } | null; `fix`: what helps, 'allow' only where a new yes can
 * succeed (the map changed what is shown), 'restore' for a group that is not here, else 'remove' (allow would refuse
 * the same way: take the command away).
 */
async function startProblem(g, y, { dir, at, cmd }) {
  const gdir = path.join(dir, ...g.dir.split('/'));
  if (!g.tool) return { why: `the map no longer names a tool for ${g.dir}`, fix: 'remove' };
  if (y.name !== g.tool.name || y.run !== g.tool.run) return { why: changedWords(y), fix: 'allow' };
  if (!y.url) return { why: 'your yes was given without the group\'s address', fix: 'allow' };
  if (!g.url || !sameUrl(g.url, y.url)) return { why: `the map gives ${g.dir} another address than the one your yes was for (${y.url})`, fix: 'allow' };
  if (!lst(gdir)) return { why: `${g.dir} is not on this computer`, fix: 'restore' };
  const origin = await originOf(gdir, cmd);
  if (!origin || !sameUrl(origin, y.url)) return { why: `the repository in ${g.dir} here is ${origin ? `another one (${origin})` : 'not the group\'s'}: your yes was for ${y.url}`, fix: 'remove' };
  const why = await runProblem(gdir, y.run, { at, cmd });
  return why ? { why, fix: 'remove' } : null;
}

const changedWords = (y) => `the map changed it, it was ${y.name} → ${y.run}`;

/** The command that helps, in the words of a line: a new yes, getting the group, or taking the command away. */
export const fixWords = (fix, group) => ({
  allow: `to allow it again:  hoprig workspace tool allow ${group}`,
  restore: `to get the group:  hoprig workspace restore`,
  remove: `to take the command away:  hoprig workspace tool remove ${group}`,
  map: 'hoprig workspace status says why', // a map refused or not read: an allow would be refused the same way
})[fix];

/**
 * Every group tool of the map on this computer: [{ group, name, run, file, launcher, state, why?, changed?, missing }].
 * Said truthfully after every change. state:
 *   made      the yes is kept for this address, name and run; the launcher is there and it would start
 *   waits     no yes on this computer (or it was for another name or run: `changed`)
 *   blocked   the yes is kept, but it would not start now: `why`
 *   gone      the yes is kept and it would start, but the launcher is missing (hoprig workspace tool allow makes it)
 *   stale     the launcher is there, but the Node or the Hoprig it starts is not on this computer any more (allow again)
 *   absent    the group is not on this computer and there is no yes
 */
export async function toolsState({ dir = workspaceDir(), projects = projectsIn(), map = null, home = os.homedir(), env = process.env, platform = process.platform, cfg = null, cmd = capture } = {}) {
  const m = map || readMap(dir).map;
  const yes = yesOf(cfg || loadConfig());
  const bin = commandDir({ home, env });
  const at = { dir, projects };
  const out = [];
  for (const g of (m && m.groups) || []) {
    if (!g.tool) continue;
    const gdir = path.join(dir, ...g.dir.split('/'));
    const e = { group: g.dir, name: g.tool.name, run: g.tool.run, file: path.join(gdir, ...g.tool.run.split('/')), launcher: path.join(bin, g.tool.name), missing: missingNeeds(g.tool, { env, platform }) };
    const y = yes.get(g.dir);
    if (!y) e.state = lst(gdir) ? 'waits' : 'absent';
    else if (y.name !== g.tool.name || y.run !== g.tool.run) Object.assign(e, { state: 'waits', changed: true, why: changedWords(y) });
    else {
      const p = await startProblem(g, y, { dir, at, cmd });
      if (p) Object.assign(e, { state: 'blocked', why: p.why, fix: p.fix });
      else if (!ourLauncher(path.join(bin, y.name), g.dir)) e.state = 'gone';
      else {
        const starts = launcherStarts(path.join(bin, y.name));
        const lost = starts ? starts.find((x) => !fs.existsSync(x)) : null;
        if (!starts) Object.assign(e, { state: 'stale', why: 'it no longer has the line Hoprig wrote to start it' });
        else if (lost) Object.assign(e, { state: 'stale', why: `it starts ${lost}, which is not on this computer any more (made by another Node or Hoprig)` });
        else e.state = 'made';
      }
    }
    out.push(e);
  }
  return out;
}

/**
 * Make the launcher of a group's tool, after the owner's yes (the caller asks it). `dryRun`: everything checked,
 * nothing written: the plan to show. `plan`: what was shown; the real call refuses when the map says anything else
 * now, and the yes kept is the plan's own values, never a second read of the map.
 * → { group, name, run, url, launcher, file, onPath, removed?: old launcher, dryRun }. Throws { status } with why.
 */
export async function allowTool(group, { dir = workspaceDir(), projects = projectsIn(), home = os.homedir(), env = process.env, dryRun = false, plan = null, cmd = capture } = {}) {
  if (process.platform === 'win32') throw fail(400, 'a group\'s tool gets its launcher on macOS and Linux only');
  const m = readMap(dir);
  if (m.errors) throw fail(409, `the workspace map was refused: ${m.errors.join('; ')}`);
  const g = groupsOf(m.map).get(group);
  if (!g) throw fail(404, `"${String(group).slice(0, 100)}" is not a group of the map`);
  if (!g.tool) throw fail(404, `${g.dir} has no tool in the map`);
  const { name, run } = g.tool;
  const gdir = path.join(dir, ...g.dir.split('/'));
  if (!lst(gdir)) throw fail(404, `${g.dir} is not on this computer: hoprig workspace restore gets it`);
  const origin = await originOf(gdir, cmd);
  if (!g.url || !origin || !sameUrl(origin, g.url)) throw fail(409, `${g.dir} here is ${origin ? `another repository (${origin})` : 'not the group\'s repository'} than the map says (${g.url}): refused`);
  if (RESERVED.includes(name)) throw fail(400, `the tool's name "${name}" is Hoprig's own command: refused`);
  const bin = commandDir({ home, env });
  const launcher = path.join(bin, name);
  // A command of that name that is not this group's launcher (on PATH, or anything at all in the folder, a dangling
  // link too): never shadowed or replaced.
  const found = which(name, env);
  if (found && !ourLauncher(found, g.dir)) throw fail(409, `a command "${name}" is on this computer already (${found}): the tool's launcher would hide it, so it is refused`);
  if (lst(launcher) && !ourLauncher(launcher, g.dir)) throw fail(409, `${launcher} is there already and is not this group's launcher: refused`);
  const why = await runProblem(gdir, run, { at: { dir, projects }, cmd });
  if (why) throw fail(400, `${g.dir}: ${why}`);
  const file = path.join(gdir, ...run.split('/'));
  if (plan && (plan.name !== name || plan.run !== run || plan.url !== g.url || plan.file !== file)) throw fail(409, `the map changed while you were asked (now ${name} → ${file}, ${g.url}): nothing was made; run the command again to see it`);
  const yes = yesOf();
  const old = yes.get(g.dir);
  const oldLauncher = old && old.name !== name ? path.join(bin, old.name) : null;
  const out = { group: g.dir, name, run, url: g.url, launcher, file, onPath: onPathDir(bin, env), dryRun };
  if (oldLauncher && ourLauncher(oldLauncher, g.dir)) out.removed = oldLauncher;
  if (dryRun) return out;
  // Hoprig's own command folder, outside the workspace: a new file beside the name, then one rename over it.
  fs.mkdirSync(bin, { recursive: true });
  const tmp = `${launcher}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, launcherText(g.dir), { mode: 0o755, flag: 'wx' });
  fs.renameSync(tmp, launcher);
  if (out.removed) fs.rmSync(out.removed, { force: true });
  yes.set(g.dir, { name, run, url: g.url });
  saveYes(yes);
  return out;
}

/** Take a group's launcher away (only one Hoprig made for this group) and forget the yes. → { group, name, removed, dryRun } */
export function removeTool(group, { home = os.homedir(), env = process.env, dryRun = false } = {}) {
  const yes = yesOf();
  const y = yes.get(group);
  if (!y) return { group, removed: [], dryRun, note: `${group} has no yes on this computer: nothing to remove` };
  const removed = [];
  const launcher = typeof y.name === 'string' ? path.join(commandDir({ home, env }), y.name) : null;
  if (launcher && ourLauncher(launcher, group)) removed.push(launcher);
  if (!dryRun) {
    for (const f of removed) fs.rmSync(f, { force: true });
    yes.delete(group);
    saveYes(yes);
  }
  return { group, name: y.name, removed, dryRun };
}

/**
 * `hoprig workspace tool run <group> -- <arguments>` (what a launcher starts): the checks of every start, then this
 * process becomes the group's file (process.execve: the same arguments, exit code and signals; where Node has no
 * execve, the file runs as a child with the terminal, a kill or hang-up passed on and its exit code returned).
 * → exit code (only when it did not start).
 */
export async function runTool(group, args, { dir = workspaceDir(), projects = projectsIn(), err = (s) => process.stderr.write(s), cmd = capture } = {}) {
  const name = String(group).slice(0, 100);
  const say = (why, fix = 'allow') => (err(`the command of ${name} was not started: ${why}; ${fixWords(fix, name)}\n`), 126);
  let m;
  try {
    m = readMap(dir);
  } catch (e) {
    return say(`the workspace map could not be read (${e.message})`, 'map');
  }
  if (m.errors) return say(`the workspace map was refused (${m.errors.join('; ')})`, 'map');
  if (!m.map) return say('there is no workspace map on this computer', 'map');
  const g = groupsOf(m.map).get(group);
  if (!g) return say('it is not a group of the workspace map any more', 'remove');
  const y = yesOf().get(group);
  if (!y) return say('there is no yes for it on this computer');
  const p = await startProblem(g, y, { dir, at: { dir, projects }, cmd });
  if (p) return say(p.why, p.fix);
  const file = path.join(dir, ...g.dir.split('/'), ...y.run.split('/'));
  if (typeof process.execve === 'function') process.execve(file, [file, ...args], process.env);
  const child = spawn(file, args, { stdio: 'inherit' });
  // Ctrl-C and Ctrl-\ go from the terminal to its whole process group, the tool included: Hoprig only waits (passed
  // on, the tool would get each twice). A signal sent to Hoprig alone (a kill, a closed terminal) is passed on.
  const pass = [['SIGINT', () => {}], ['SIGQUIT', () => {}], ...['SIGTERM', 'SIGHUP'].map((s) => [s, () => child.kill(s)])];
  for (const [s, f] of pass) process.on(s, f);
  const [code, signal] = await new Promise((resolve) => child.on('exit', (c, s) => resolve([c, s])));
  for (const [s, f] of pass) process.off(s, f);
  if (signal) process.kill(process.pid, signal);
  return code ?? 1;
}

/** The lines for restore, the upkeep and status: tools that wait for a yes, and ones that would not start (never made by themselves). */
export const toolLines = (tools) => tools.flatMap((t) => {
  if (t.state === 'waits') return [`${t.group} has its own command ${t.name}${t.changed ? ` (${t.why})` : ''}: it is made only after your yes on this computer:  hoprig workspace tool allow ${t.group}`];
  if (t.state === 'stale') return [`${t.name} (the command of ${t.group}) cannot start: ${t.why}. To make it again:  hoprig workspace tool allow ${t.group}`];
  if (t.state === 'gone') return [`${t.name} (the command of ${t.group}) is missing: your yes is kept, to make it again:  hoprig workspace tool allow ${t.group}`];
  if (t.state === 'blocked') return [`${t.name} (the command of ${t.group}) would not start: ${t.why}; ${fixWords(t.fix, t.group)}`];
  return [];
});
/** toolLines as one line (restore's notes, the upkeep's needs), or null. */
export const waitingLine = (tools) => toolLines(tools).join('; ') || null;

export const TOOL_USAGE = `  hoprig workspace tool [list] [--json]        the commands of your groups (the map's "tool"): made, waiting for
                                               your yes on this computer, or why one would not start
  hoprig workspace tool allow <group> [--yes] [--dry-run] [--json]
                                               make the group's command after your yes (its address, the name and
                                               the file are shown first); Hoprig never runs it by itself
  hoprig workspace tool remove <group> [--dry-run] [--json]
                                               take the command away (only one Hoprig made) and forget the yes
  hoprig workspace tool run <group> -- <arguments>
                                               what the command starts: Hoprig checks it again, then runs the file`;

/** The line about the workspace rules file after a command was made or taken away (wsrules.mjs), when it is older. */
async function sayRulesFile(ui, what) {
  try {
    const line = await (await import('../pcsetup/wsrules.mjs')).rulesFileNote(what);
    if (line) ui.line('info', line);
  } catch {
    /* the file is a note for coding sessions: a read that fails says nothing here */
  }
}

const STATE_WORDS = { made: 'made', waits: 'waits for your yes', blocked: 'would not start', stale: 'cannot start', gone: 'its command is missing', absent: 'the group is not on this computer' };
const pathLine = (bin) => `export PATH="${bin}:$PATH"`;

/** `hoprig workspace tool …`. → exit code */
export async function toolMain(args, { ui, write, usage }) {
  if (args[0] === 'run') {
    const sep = args.indexOf('--');
    const head = sep < 0 ? args.slice(1) : args.slice(1, sep);
    if (head.length !== 1) return usage();
    return runTool(head[0], sep < 0 ? [] : args.slice(sep + 1));
  }
  const { flags } = await import('../pcsetup/project.mjs');
  const [sub0, ...rest0] = args;
  const sub = sub0 && !sub0.startsWith('--') ? sub0 : 'list';
  const rest = sub0 && !sub0.startsWith('--') ? rest0 : args;
  const o = flags(rest, { json: 'bool', 'dry-run': 'bool', yes: 'bool' });
  const json = (v) => (write(JSON.stringify(v, null, 2) + '\n'), 0);
  const failed = (e) => {
    if (o.json) {
      write(JSON.stringify({ ok: false, error: e.message }, null, 2) + '\n');
      return 1;
    }
    ui.line('fail', e.message);
    return 1;
  };
  if (o.errors.length) return usage();
  if (sub === 'list') {
    if (o._.length) return usage();
    let tools;
    try {
      tools = await toolsState();
    } catch (e) {
      return failed(e);
    }
    if (o.json) return json({ tools });
    if (!tools.length) ui.note('no group of the map has a tool');
    for (const t of tools) {
      const fix = t.state === 'blocked' ? t.fix : ['waits', 'gone', 'stale'].includes(t.state) ? 'allow' : null;
      ui.line(t.state === 'made' ? 'ok' : ['blocked', 'stale'].includes(t.state) ? 'warn' : 'info', `${t.name}  ${dim(`${t.group}/${t.run}`)}  ${STATE_WORDS[t.state]}${t.why ? `: ${t.why}` : ''}${fix ? `; ${fixWords(fix, t.group)}` : ''}`);
      for (const m of t.missing) ui.line('warn', `${t.name} needs ${m.program}, which this computer does not have${m.fix ? `:  ${m.fix}` : ''}`);
    }
    return 0;
  }
  if (sub === 'allow') {
    if (o._.length !== 1) return usage();
    let plan;
    try {
      plan = await allowTool(o._[0], { dryRun: true });
    } catch (e) {
      return failed(e);
    }
    if (!o.json) {
      ui.out(`\n  The group ${plan.group} (${plan.url}) names its own command:`);
      ui.out(`    ${plan.name}  →  ${plan.file}`);
      ui.out(`  Hoprig writes ${plan.launcher}. At every start Hoprig checks again that the group is here with this address, that the map still says this name and file, and that the file is one the group's own repository tracks; only then it runs the file with your arguments. It never runs it by itself.`);
      if (plan.removed) ui.out(`  The command it made before (${plan.removed}) goes.`);
    }
    if (o['dry-run']) return o.json ? json(plan) : 0;
    // The yes on THIS computer: typed at the terminal, or --yes. Never taken from the map or another computer.
    const yes = o.yes || (!o.json && ui.interactive && (await ui.confirm(`Make the command ${plan.name}?`, false)));
    if (!yes) return failed(new Error(`${plan.name} was not made: it needs your yes on this computer (add --yes, or answer y)`));
    try {
      const r = await allowTool(o._[0], { plan });
      if (o.json) return json(r);
      const bin = path.dirname(r.launcher);
      ui.line('ok', r.onPath ? `${r.name} is a command now (${r.launcher})` : `${r.name} was made in ${bin}, which is not on your PATH: to run it by its name, add this line to your shell's start file (Hoprig does not edit it):  ${pathLine(bin)}`);
      if (r.removed) ui.note(`${r.removed} was removed`);
      await sayRulesFile(ui, `does not name ${r.name} yet`);
      return 0;
    } catch (e) {
      return failed(e);
    }
  }
  if (sub === 'remove') {
    if (o._.length !== 1) return usage();
    const r = removeTool(o._[0], { dryRun: o['dry-run'] });
    if (o.json) return json(r);
    if (r.note) ui.note(r.note);
    for (const f of r.removed) ui.line('ok', `${r.dryRun ? 'would remove' : 'removed'} ${f}`);
    if (!r.note && !r.dryRun) ui.line('ok', `the yes for the command of ${r.group} is forgotten on this computer`);
    if (!r.dryRun && r.name) await sayRulesFile(ui, `still names ${r.name}`);
    return 0;
  }
  return usage();
}
