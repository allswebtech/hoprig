// The help of every command of bin/hoprig.mjs, printed for a help request (src/helpwords.mjs) WITHOUT running any of
// the command's own code: each text is a constant its module exports, loaded and printed, nothing else. A subcommand
// gets its own lines where the command's help has lines that name it ("hoprig service uninstall --help": the service
// line; "hoprig project sync -h": project sync's usage); else the command's whole help. Never the top help for a
// command that exists, never an error.
import fs from 'node:fs';
import { binFile } from './paths.mjs';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const indent = (l) => l.length - l.trimStart().length;
// "hoprig <cmd> a|b|c" at the start of a line (after "usage:"): the words in the place of a subcommand.
const lineOf = (cmd) => new RegExp(`^(\\s*(?:usage:\\s*)?)hoprig ${esc(cmd)}(?: ((?:[a-z][a-z-]*\\s*\\|\\s*)*[a-z][a-z-]*))?(?![\\w-])`);
const startsCommand = /^\s*(?:usage:\s*)?hoprig\s/;

/** The lines of `text` that name `hoprig <cmd>` (with `sub` when given), each with the lines under it that go on. */
export function linesFor(text, cmd, sub = null) {
  const lines = String(text).split('\n');
  const re = lineOf(cmd);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m || (sub !== null && !(m[2] || '').split('|').map((w) => w.trim()).includes(sub))) continue;
    const col = m[1].length;
    out.push(`  ${lines[i].slice(col)}`);
    while (i + 1 < lines.length && lines[i + 1].trim() && indent(lines[i + 1]) > col && !startsCommand.test(lines[i + 1])) out.push(`  ${lines[++i].slice(col)}`);
  }
  return out.length ? `usage:\n${out.join('\n')}` : null;
}

// Commands Hoprig starts itself (or that are switched off): a line each that says what they are.
const INTERNAL = {
  hook: 'usage: hoprig hook\n  what Claude Code starts for a hook event of a session Hoprig started (it reads the event on its input); not typed by hand',
  router: 'usage: hoprig router\n  the router of Auto mode on this computer: Hoprig starts it by itself when a session needs it; not typed by hand',
  'router-url': 'usage: hoprig router-url\n  the address of this computer\'s Auto mode router, without its key',
  run: 'usage: hoprig run <profile> [args for Claude Code]\n  start Claude Code under that profile (the same as hoprig <profile> [args])',
  '__service-restart': 'usage: hoprig __service-restart <pid>\n  the helper of a restart asked for on the dashboard\'s own page: it waits for that process to end, then starts\n  the background dashboard again; not typed by hand',
};

async function toolHelp(id) {
  const { isOffered } = await import('./codetools/offered.mjs');
  if (isOffered(id)) return (await import('./codetools/terminal.mjs')).toolUsage(id);
  const { notOffered } = await import('./codetools/index.mjs');
  return `hoprig ${id}: ${notOffered(id, { cli: true })}`;
}

const setupCli = async () => (await import('./setup/cli.mjs')).USAGE;
const machinesCli = async () => (await import('./machines/cli.mjs')).USAGE;
const serverCli = async () => (await import('./server/cli.mjs')).USAGE;
const workspaceCli = async () => (await import('./workspace/cli.mjs')).USAGE;

// The four commands that no module of their own describes: their lines were once part of the top help, which now
// only names them ("hoprig help <command>" and "hoprig <command> --help" print these).
const PROFILES_USAGE = `usage:
  hoprig profiles [--json]    list profiles
  hoprig profiles map <name> [on|off] [--yes]
                              a provider's model map (MODELS) for every session and chat on it:
                                 what it would rename, and whether it is on (off at first)`;
const ADD_USAGE = `usage:
  hoprig add [name]           add a profile (a provider: another Claude account, an API key, a proxy)`;
const RM_USAGE = `usage:
  hoprig rm <name> [--yes]    delete a profile (asks first; --yes: without asking)`;
const AUTO_USAGE = `usage:
  hoprig auto [args]          start in Auto mode: when a provider reaches its limit, work goes on
                                 under the next one without stopping, and comes back by itself
  hoprig auto status          Auto mode's settings, each provider's usage and limits
  hoprig auto on | off        make Auto the default way to start (off at first)
  hoprig auto order a b c     the providers Auto mode uses, most preferred first`;

/** Each command's whole help. */
const COMMAND = {
  profiles: () => PROFILES_USAGE,
  add: () => ADD_USAGE,
  rm: () => RM_USAGE,
  auto: () => AUTO_USAGE,
  chat: async () => (await import('./chat/cli.mjs')).USAGE,
  setup: async () => (await import('./setup/setup.mjs')).SETUP_USAGE,
  doctor: setupCli,
  claude: setupCli,
  update: setupCli,
  codex: () => toolHelp('codex'),
  opencode: () => toolHelp('opencode'),
  tools: async () => (await import('./codetools/cli.mjs')).USAGE,
  pc: async () => (await import('./pcsetup/cli.mjs')).USAGE,
  get: async () => (await import('./pcsetup/getproject.mjs')).GET_USAGE,
  project: async () => (await import('./pcsetup/project.mjs')).PROJECT_USAGE,
  drop: async () => (await import('./workspace/dropcli.mjs')).DROP_USAGE,
  adopt: async () => (await import('./adopt/cli.mjs')).ADOPT_USAGE,
  sessions: async () => (await import('./adopt/cli.mjs')).SESSIONS_USAGE,
  workspace: workspaceCli,
  // "hoprig sync" is "hoprig workspace sync": its lines, under its own name.
  sync: async () => `${linesFor(await workspaceCli(), 'workspace', 'sync').replace(/hoprig workspace sync/g, 'hoprig sync')}\n  (the same as hoprig workspace sync)`,
  tasks: async () => (await import('./work/cli.mjs')).USAGE,
  ship: async () => (await import('./ship/cli.mjs')).USAGE,
  demo: async () => (await import('./demo/cli.mjs')).DEMO_USAGE,
  box: async () => (await import('./box/cli.mjs')).USAGE,
  'move-to-user': async () => (await import('./setup/movecli.mjs')).MOVE_USAGE,
  field: async () => (await import('./field/cli.mjs')).USAGE,
  skills: async () => (await import('./skillhub/cli.mjs')).HELP,
  addons: async () => (await import('./addons/cli.mjs')).usage(),
  gateways: async () => (await import('./addons/gatewaycli.mjs')).USAGE,
  public: async () => (await import('./addons/publiccli.mjs')).USAGE,
  mcp: async () => (await import('./assistant/cli.mjs')).USAGE,
  link: machinesCli,
  join: machinesCli,
  pair: machinesCli,
  tokens: machinesCli,
  machines: machinesCli,
  serve: serverCli,
  passwd: serverCli,
  service: serverCli,
  ...Object.fromEntries(Object.entries(INTERNAL).map(([k, v]) => [k, () => v])),
};

/** Subcommands whose module has a usage of their own, fuller than the lines of the command's help. */
const OWN = {
  'pc setup': async () => (await import('./pcsetup/setup.mjs')).SETUP_USAGE,
  'pc leave': async () => (await import('./workspace/leavecli.mjs')).LEAVE_USAGE,
  'project new': async () => (await import('./pcsetup/project.mjs')).NEW_USAGE,
  'project add': async () => (await import('./pcsetup/project.mjs')).ADD_USAGE,
  'project start': async () => (await import('./pcsetup/project.mjs')).START_USAGE,
  'project status': async () => (await import('./pcsetup/project.mjs')).STATUS_USAGE,
  'project sync': async () => (await import('./pcsetup/project.mjs')).SYNC_USAGE,
  'project link': async () => (await import('./pcsetup/project.mjs')).LINK_USAGE,
  'project setup': async () => (await import('./pcsetup/project.mjs')).SETUP_USAGE,
  'project clone': async () => `hoprig project clone is the same as hoprig get:\n${(await import('./pcsetup/getproject.mjs')).GET_USAGE}`,
  'profiles map': async () => (await import('./providers/mapcli.mjs')).USAGE,
};

/** Whether `text` also has lines for a command other than `cmd`. */
const sharedBy = (text, cmd) => String(text).split('\n').some((l) => {
  const m = /^\s*(?:usage:\s*)?hoprig ([a-z][a-z-]*)/.exec(l);
  return m && m[1] !== cmd;
});

/** The commands bin/hoprig.mjs dispatches: the case labels of its main(), read from the file itself. */
export function dispatchedCommands() {
  const src = fs.readFileSync(binFile(), 'utf8');
  return [...new Set([...src.slice(src.indexOf('async function main(')).matchAll(/^\s*case '([^']+)':/gm)].map((m) => m[1]))];
}

/** Whether `cmd` has a help written for it here. A command of the dispatch without one fails test/skill/helpwords.test.mjs. */
export const hasHelp = (cmd) => Object.hasOwn(COMMAND, cmd);

/** What a command of the dispatch prints when no help is written for it yet: it still does nothing else. */
export const NO_OWN_HELP = 'has no help of its own yet';

/**
 * The help to print for `hoprig <cmd> [<sub>] <a help word>`, or null when `cmd` is no command of the dispatch (it is
 * then refused as an unknown word, as without a help word). `top` is the top help of bin/hoprig.mjs.
 */
export async function helpText(cmd, sub, top) {
  if (!dispatchedCommands().includes(cmd)) return null;
  const whole = Object.hasOwn(COMMAND, cmd) ? await COMMAND[cmd](top) : null;
  if (!whole) return `hoprig ${cmd} ${NO_OWN_HELP}: hoprig help lists every command.`;
  // A usage several commands share ("pair", "join" and "machines" have one): the lines of the command asked.
  if (sub === null) return (sharedBy(whole, cmd) && linesFor(whole, cmd)) || whole;
  const key = `${cmd} ${sub}`;
  if (Object.hasOwn(OWN, key)) return OWN[key]();
  if (cmd === 'tasks') return (await import('./work/cli.mjs')).usageOf(sub);
  return linesFor(whole, cmd, sub) || whole;
}
