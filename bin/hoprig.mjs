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
import { HELP_ALL } from '../src/helpall.mjs';
import { helpRequest } from '../src/helpwords.mjs';
import { needsYes } from '../src/yes.mjs';

const HELP = `Hoprig — Claude Code and OpenCode under several providers, and a dashboard for every computer

Start work
  hoprig                      choose a provider (a "profile"), then start Claude Code here
  hoprig <profile>            start under that profile: hoprig api -c continues the last session;
                              hoprig api -- "fix the tests" starts and sends that as the first message
  hoprig chat [folder]        code in a chat in your browser instead (Hoprig opens it for you)
  hoprig opencode [provider]  start OpenCode instead of Claude Code
  hoprig auto                 start in Auto mode: at a provider's limit, work goes on under the next
                              one by itself (hoprig auto on | off | status | order a b c)

The dashboard
  hoprig serve                start the web dashboard (hoprig service install keeps it running)
  hoprig stop                 stop the dashboard (it stays stopped until hoprig service start)
  hoprig link                 a one-time link and QR code that signs your phone in
  hoprig public on | off      open the dashboard from anywhere, no server of your own needed
  hoprig demo                 try the dashboard with sample data first

Set up, check, update
  hoprig setup                install what is missing and set everything up, step by step
  hoprig doctor               check that everything works
  hoprig update               update Hoprig (the dashboard: Settings, Version and updates)

Providers and accounts
  hoprig add [name]           add a provider: another Claude account, an API key, or a gateway
  hoprig profiles             list your providers (hoprig rm <name> deletes one)

Projects and other computers
  hoprig get <name>           get a project, with its code and its AI memory, onto this computer
  hoprig sync                 bring your projects on this computer up to date with git
  hoprig tasks                your tasks and what needs you today
  hoprig machines             the other computers your dashboard shows

More: workspace, project, pc, drop, adopt, sessions, ship, box, field, skills, addons,
  gateways (one press sets up a gateway for other providers: hoprig addons), mcp, join, pair, tokens,
  passwd, service, move-to-user, tools, claude, version, help.
  hoprig help <command> explains each one; hoprig help all lists every command with its options.

Your providers are files in ${profilesDir()}
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
    // "hoprig help <command>" is "hoprig <command> help": that command's own help.
    if (cmd === 'help' && rest[0] === 'all') {
      process.stdout.write(HELP_ALL);
      return 0;
    }
    if (cmd === 'help' && rest[0] !== undefined) {
      const { helpText } = await import('../src/helptext.mjs');
      const text = await helpText(rest[0], rest[1] !== undefined && !rest[1].startsWith('-') ? rest[1] : null, HELP);
      if (text !== null) {
        process.stdout.write(`${text.replace(/\n+$/, '')}\n`);
        return 0;
      }
    }
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
    case 'keep': {
      // Started by the service manager while the dashboard is down (src/keeper/keep.mjs); a person never types it.
      const { main: keep } = await import('../src/keeper/keep.mjs');
      return keep(rest);
    }
    case '__service-restart': {
      // The helper of a restart asked for on the dashboard's own page (src/server/selfrestart.mjs). Not through the
      // dashboard's own modules: after an update that is missing one of them it must still run, to check the start and
      // put the old version back.
      const { restartAfterExit } = await import('../src/server/selfrestart.mjs');
      return restartAfterExit(rest[0]);
    }
    case 'serve':
    case 'stop':
    case 'passwd':
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
