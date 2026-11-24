#!/usr/bin/env node
// hoprig: Claude Code and OpenCode under several providers, and a web dashboard.
import '../src/nodeguard.mjs'; // first: on a Node.js that is too old, one plain sentence and exit code 1
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAutoSwitch, limitedProfiles, setAutoSwitch } from '../src/autoswitch.mjs';
import { hookMain } from '../src/hook.mjs';
import { hasSessionFlag, launch } from '../src/launch.mjs';
import { applyLaunch } from '../src/launchfile.mjs';
import { routerMain } from '../src/router.mjs';
import { profileUsage, routerAddress } from '../src/routerstate.mjs';
import { addProfile, ago, askNext, chooseProfile, clock, menuProfiles } from '../src/menu.mjs';
import { profilesDir } from '../src/paths.mjs';
import { deleteProfile, publicProfile, readProfile, validName } from '../src/profiles.mjs';
import { mapCommand } from '../src/providers/mapcli.mjs';
import { helpRequest } from '../src/helpwords.mjs';
import { needsYes } from '../src/yes.mjs';

const HELP = `Hoprig — Claude Code and OpenCode under several providers, and a dashboard for every computer

  hoprig                      choose a profile, then start Claude Code in this terminal
  hoprig chat [folder]        code in a chat in the dashboard instead: prints its address and opens it
                                 in your browser (set up as your last chat in that folder;
                                 --tool opencode: a chat with OpenCode, where the dashboard offers it)
  hoprig <profile> [args]     start under that profile; args go to Claude Code
                                hoprig api -c            continue the last session of this folder
                                hoprig sub2 --resume ID  continue one session
                                hoprig api -- "fix the tests"  start, and send this as the
                                                         session's first message
  hoprig -c | --resume ...    choose a profile, then continue as asked
  hoprig <profile> --with <name>  also let this session read another project of the workspace
                                 (to read; its file tools cannot write there; this session only;
                                 a project's own "needs" come by themselves)

  hoprig opencode [provider] [args]  start OpenCode instead; -c, --resume ID and -- "first message"
                                 as above. Auto mode, plan usage and Tia's engine are Claude
                                 Code's only

  hoprig auto [args]          start in Auto mode: when a provider reaches its limit, work goes on
                                 under the next one without stopping, and comes back by itself

  When a session stops at a limit or an error, Hoprig offers to continue it on another profile.

  hoprig add [name]           add a profile (a provider: another Claude account, an API key, a proxy)
  hoprig profiles [--json]    list profiles
  hoprig profiles map <name> [on|off] [--yes]
                              a provider's model map (MODELS) for every session and chat on it:
                                 what it would rename, and whether it is on (off at first)
  hoprig rm <name> [--yes]    delete a profile (asks first; --yes: without asking)

  hoprig auto status          Auto mode's settings, each provider's usage and limits
  hoprig auto on | off        make Auto the default way to start (off at first)
  hoprig auto order a b c     the providers Auto mode uses, most preferred first

  hoprig demo                 try the dashboard with sample data (no Claude Code or provider needed)
  hoprig pc setup             make a fresh computer ready for coding (git, Node, tools, GitHub, projects)
  hoprig pc status            what this computer has, what is missing, what needs attention
  hoprig project new <name>   a new project: one folder for rules, AI memory and docs, with its code
                                 repositories under code/, all in git
  hoprig project clone <name> get an existing project with all its code repositories and its AI memory
  hoprig get <name>…          the same, short (the folder is the project's name; --dry-run shows it first);
                                 hoprig get --list: every project of your workspace and which computer has it
  hoprig drop <name>…         take a project off THIS computer safely: it pushes first, then checks, then removes
                                 (--check only says what exists only here; --dry-run shows every step)
  hoprig adopt scan|plan|apply  a computer that already has projects: look in the folders you name, a plan per
                                 project, then a proved copy into the workspace (adopt verify | retire)
  hoprig sessions move <old> <new>  the coding tool's conversations of a folder, copied under its new place
  hoprig sync [<name>]        bring the repositories on this computer (or one project) in step with git
  hoprig project status|sync  the state of a project's repositories; pull and push what is safe
  hoprig project setup <name> what a fresh clone sets up (.env, git hooks, memory link, installs)
  hoprig workspace            the one folder tree for your coding: AI brain, projects, credentials
                                 (workspace status | setup | link | map | restore | sync | set | forget | git |
                                 group | find | tool | mylink | rules | label)
  hoprig tasks                Work: your tasks and what needs you today, kept in a file of the workspace
                                 (tasks today | list | add | edit | done | open | drop | remove | do | runs | plans |
                                 plan | save;
                                 "hoprig tasks help" has the rest)
  hoprig ship status <project>  Go live: put finished task branches together, check them, go live on your yes
                                 (status | together | check | allow | live | back | auto; docs/GO-LIVE.md)

  hoprig setup                install what is missing and set everything up, step by step
  hoprig doctor               check that everything works
  hoprig move-to-user         move Hoprig from root to an ordinary user of this server (--dry-run shows it first)
  hoprig box check | run      a box for commands: no network, not your home, only the folders named
                                 (box run --write DIR -- <command>; docs/BOX.md)
  hoprig field                field reports: what Hoprig's own work showed, kept on this computer
                                 (field show <id> | inbox <folder> | way-round; docs/FIELD-REPORTS.md)
  hoprig claude status        Claude Code's version (also: claude update, claude install <version>)
  hoprig tools                the coding tools: Claude Code, OpenCode (tools install <tool>,
                                 tools update <tool | all>, tools on | off <tool>)
  hoprig update               update Hoprig itself

  hoprig link                 a one-time link and QR code that signs a phone or another browser in
  hoprig public on | off      open this dashboard from anywhere through Cloudflare, no server needed
                                 (public on --temporary | --custom; public status)
  hoprig machines             the other computers this dashboard also shows (add, list, remove)
  hoprig join <ssh target>    connect THIS computer out to another dashboard (for a PC behind a router)
  hoprig pair                 let another computer's dashboard control this one
  hoprig tokens               who may control this computer (list, revoke)

  hoprig skills               skills for you and your projects: suggest, find, review and
                                 add, update (skills suggest | find | add | list | update)
  hoprig addons               optional companions, such as an AI gateway that lets Claude Code use
                                 other providers (addons setup <id>)
  hoprig gateways             the gateways Hoprig knows; gateways add | confirm | remove: one of your own
  hoprig mcp                  Hoprig's tools as an MCP server (for the dashboard's assistant and
                                 for any MCP client, such as your own Claude Code)

  hoprig serve                start the web dashboard
  hoprig passwd               set the dashboard password
  hoprig service install      run the dashboard in the background
  hoprig service restart      start the background dashboard again (after an update)

  Profiles are files in ${profilesDir()}
`;

async function startFromMenu(args) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('hoprig: no terminal to show the menu in. Name the profile: hoprig <profile> [args]');
    return 2;
  }
  const choice = await chooseProfile({ sessionChosen: hasSessionFlag(args) });
  if (!choice) return 0;
  return start(choice.name, [...args, ...choice.extraArgs]);
}

function start(name, args) {
  return launch(name, args, { askNext });
}

function autoCommand(args) {
  const [sub, ...rest] = args;
  const onOff = (v) => (v === 'on' ? true : v === 'off' ? false : null);
  if (sub === 'on' || sub === 'off') setAutoSwitch({ enabled: sub === 'on' });
  else if (sub === 'order') {
    if (!rest.length) {
      console.error('usage: hoprig auto order <profile> <profile> ...   (most preferred first)');
      return 2;
    }
    setAutoSwitch({ order: rest });
  } else if (sub === 'return' && onOff(rest[0]) !== null) setAutoSwitch({ returnToPreferred: onOff(rest[0]) });
  else if (sub !== undefined) {
    console.error('usage: hoprig auto [on | off | order <profiles...> | return on|off]');
    return 2;
  }
  const as = getAutoSwitch();
  console.log(`Auto mode: ${as.enabled ? 'on (new sessions start under "auto")' : 'off'}`);
  console.log(`Order:     ${as.order.length ? as.order.join(' → ') : '(not set: hoprig auto order sub api)'}`);
  const pct = (w) => (w ? `${w.pct}%${w.resetsAt ? ` (resets ${clock(w.resetsAt)})` : ''}` : 'n/a');
  for (const [name, u] of Object.entries(profileUsage())) {
    // The figures are kept after the session that showed them: say how old they are.
    console.log(`Usage:     ${name}: 5-hour ${pct(u.fiveHour)}, week ${pct(u.week)}${u.at ? `  (seen ${ago(u.at)})` : ''}`);
  }
  const limited = limitedProfiles();
  for (const [name, l] of Object.entries(limited)) {
    console.log(`At its limit: ${name}, until ${l.exact ? '' : 'about '}${clock(l.until)}${l.text ? `  (${l.text})` : ''}`);
  }
  if (as.order.length === 1) console.log('With one provider in the order there is nowhere to move to. Add another: hoprig auto order <provider> <provider>');
  const subs = as.order.map((n) => readProfile(n)).filter((p) => p && p.kind !== 'api');
  if (subs.length > 1) {
    console.log('Note: this order has more than one subscription. Going from one of your subscriptions to another restarts');
    console.log('Claude Code as the next one. Whether continuing past a limit on a second subscription is acceptable is yours');
    console.log('to judge against Anthropic\'s terms (README: "Is this allowed?"). The surest order is one subscription,');
    console.log('then an API key.');
  }
  return 0;
}

async function main() {
  applyLaunch(); // started by the dashboard: its launch file holds the folder and the arguments (src/launchfile.mjs)
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === undefined) return startFromMenu([]);
  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === 'version' || cmd === '--version') {
    const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    console.log(pkg.version);
    return 0;
  }
  if (cmd.startsWith('-')) return startFromMenu([cmd, ...rest]);
  // "hoprig <command> [<subcommand>] help" (or --help, -h) only prints help: the command's own code does not run at
  // all, whatever it would make of the word (src/helpwords.mjs says where a word is not Hoprig's to read).
  const asked = helpRequest(cmd, rest);
  if (asked) {
    const { helpText } = await import('../src/helptext.mjs');
    const text = await helpText(cmd, asked.sub, HELP);
    if (text !== null) {
      process.stdout.write(`${text.replace(/\n+$/, '')}\n`);
      return 0;
    }
  }

  switch (cmd) {
    case 'hook':
      await hookMain();
      return 0;
    case 'profiles': {
      if (rest[0] === 'map') return mapCommand(rest.slice(1));
      // Every provider ("auto" too when it can be used, so wrapper scripts accept it as a profile name); its `tools`
      // name only the offered coding tools (publicProfile).
      const list = menuProfiles({ all: true }).map(publicProfile);
      if (rest.includes('--json')) console.log(JSON.stringify(list));
      else for (const p of list) console.log(`${p.name}\t${p.kind}\t${p.label}`);
      return 0;
    }
    case 'add':
      return (await addProfile(rest[0])) ? 0 : 1;
    case 'rm': {
      const yes = rest.includes('--yes') || rest.includes('-y');
      const [name, ...extra] = rest.filter((a) => a !== '--yes' && a !== '-y');
      if (!name || extra.length || name.startsWith('-')) {
        console.error('usage: hoprig rm <name> [--yes]');
        return 2;
      }
      if (!validName(name) || !readProfile(name)) {
        console.log(`There is no profile "${name}".`);
        return 1;
      }
      // A person says yes to a delete (src/yes.mjs): the profile's sign-in or key would be gone.
      const no = await needsYes({ yes, command: 'hoprig rm', act: `Deleting the profile "${name}"`, question: `Delete the profile "${name}"? Its sign-in or key goes with it.`, done: 'deleted' });
      if (no !== null) return no;
      const ok = deleteProfile(name);
      console.log(ok ? `Deleted the profile "${name}".` : `There is no profile "${name}".`);
      return ok ? 0 : 1;
    }
    case 'run': {
      if (!rest[0]) {
        console.error('usage: hoprig run <profile> [args for Claude Code]');
        return 2;
      }
      return start(rest[0], rest.slice(1));
    }
    case 'chat': {
      const chat = await import('../src/chat/cli.mjs');
      return chat.main(rest);
    }
    case 'router-url':
      console.log(routerAddress().url.replace(/\/[0-9a-f]{32,}$/, '/<key>'));
      return 0;
    case 'auto':
      // "auto on / off / order … / return … / status" are settings; anything else starts a session in Auto mode.
      if (['on', 'off', 'order', 'return', 'status'].includes(rest[0])) return autoCommand(rest[0] === 'status' ? [] : rest);
      return start('auto', rest);
    case 'router': {
      const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
      return routerMain(pkg.version);
    }
    case 'setup':
    case 'doctor':
    case 'claude':
    case 'update': {
      const setup = await import('../src/setup/cli.mjs');
      return (await setup.main(cmd, rest)) ?? 0;
    }
    case 'move-to-user': {
      const move = await import('../src/setup/movecli.mjs');
      return move.main(rest);
    }
    case 'codex':
    case 'opencode': {
      const terminal = await import('../src/codetools/terminal.mjs');
      return terminal.toolCommand(cmd, rest);
    }
    case 'tools': {
      const tools = await import('../src/codetools/cli.mjs');
      return tools.main(rest);
    }
    case 'pc':
    case 'get':
    case 'project': {
      const pc = await import('../src/pcsetup/cli.mjs');
      return (await pc.main(cmd, rest)) ?? 0;
    }
    case 'drop': {
      const drop = await import('../src/workspace/dropcli.mjs');
      return drop.main(rest);
    }
    case 'adopt': {
      const adopt = await import('../src/adopt/cli.mjs');
      return adopt.main(rest);
    }
    case 'sessions': {
      const adopt = await import('../src/adopt/cli.mjs');
      return adopt.sessionsMain(rest);
    }
    case 'workspace': {
      const ws = await import('../src/workspace/cli.mjs');
      return ws.main(rest);
    }
    case 'sync': {
      const ws = await import('../src/workspace/cli.mjs');
      return ws.main(['sync', ...rest]);
    }
    case 'tasks': {
      const work = await import('../src/work/cli.mjs');
      return work.main(rest);
    }
    case 'ship': {
      const ship = await import('../src/ship/cli.mjs');
      return ship.main(rest);
    }
    case 'demo': {
      const demo = await import('../src/demo/cli.mjs');
      const code = await demo.main(cmd, rest);
      return Number.isInteger(code) ? code : null; // the demo dashboard keeps running until Ctrl+C
    }
    case 'box': {
      const box = await import('../src/box/cli.mjs');
      return box.main(rest);
    }
    case 'field': {
      const field = await import('../src/field/cli.mjs');
      return field.main(rest);
    }
    case 'skills': {
      const hub = await import('../src/skillhub/cli.mjs');
      return (await hub.main(cmd, rest)) ?? 0;
    }
    case 'addons': {
      const addons = await import('../src/addons/cli.mjs');
      return addons.main(cmd, rest);
    }
    case 'gateways': {
      const gw = await import('../src/addons/gatewaycli.mjs');
      return gw.main(rest);
    }
    case 'public': {
      const pub = await import('../src/addons/publiccli.mjs');
      return pub.main(rest);
    }
    case 'mcp': {
      const assistant = await import('../src/assistant/cli.mjs');
      const code = await assistant.main(cmd, rest);
      return Number.isInteger(code) ? code : null; // the MCP server keeps running until its client closes it
    }
    case 'link':
    case 'join':
    case 'pair':
    case 'tokens':
    case 'machines': {
      const machines = await import('../src/machines/cli.mjs');
      return (await machines.main(cmd, rest)) ?? 0;
    }
    case 'serve':
    case 'passwd':
    case '__service-restart': // the helper of a restart asked for on the dashboard's own page (src/server/selfrestart.mjs)
    case 'service': {
      let server;
      try {
        server = await import('../src/server/cli.mjs');
      } catch (e) {
        if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
        console.error(`hoprig: the dashboard cannot load (${e.message}).\nRun "hoprig doctor": it says what is missing (often the terminal module, which needs build tools to install).`);
        return 1;
      }
      // A number is an exit code; anything else means "keep running" (the server is up).
      const code = await server.main(cmd, rest);
      return Number.isInteger(code) ? code : null;
    }
    default:
      if (validName(cmd) && readProfile(cmd)) return start(cmd, rest);
      console.error(`hoprig: "${cmd}" is neither a command nor a profile.\n`);
      process.stderr.write(HELP);
      return 2;
  }
}

// End with `code` only after everything printed has left the process. Output to a pipe is written in the
// background on some systems: exiting right away cut `hoprig doctor --json` at 8 KB when another program read it
// (seen on macOS with Node 20). An empty write's callback runs after all earlier writes are out.
function exitWhenWritten(code) {
  process.exitCode = code;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

main().then(
  (code) => {
    if (code !== null) exitWhenWritten(code);
  },
  (e) => {
    console.error(`hoprig: ${e.message}`);
    exitWhenWritten(1);
  },
);
