#!/usr/bin/env node
// hoprig: Claude Code under several profiles, one shared session store, and a web dashboard.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAutoSwitch, limitedProfiles, setAutoSwitch } from '../src/autoswitch.mjs';
import { hookMain } from '../src/hook.mjs';
import { hasSessionFlag, launch } from '../src/launch.mjs';
import { routerMain } from '../src/router.mjs';
import { profileUsage, routerAddress } from '../src/routerstate.mjs';
import { addProfile, ago, askNext, chooseProfile, clock, menuProfiles, rememberLast } from '../src/menu.mjs';
import { profilesDir } from '../src/paths.mjs';
import { deleteProfile, listProfiles, publicProfile, readProfile, validName } from '../src/profiles.mjs';

const HELP = `Hoprig — Claude Code under several profiles, with one shared session store

  hoprig                      choose a profile, then start Claude Code
  hoprig <profile> [args]     start under that profile; args go to Claude Code
                                hoprig api -c            continue the last session of this folder
                                hoprig sub2 --resume ID  continue one session
  hoprig -c | --resume ...    choose a profile, then continue as asked

  hoprig auto [args]          start in Auto mode: when a provider reaches its limit, work goes on
                                 under the next one without stopping, and comes back by itself

  When Claude Code exits, Hoprig offers to continue the same session on another profile.

  hoprig add [name]           add a profile (a provider: another Claude account, an API key, a proxy)
  hoprig profiles [--json]    list profiles
  hoprig rm <name>            delete a profile

  hoprig auto status          Auto mode's settings, each provider's usage and limits
  hoprig auto on | off        make Auto the default way to start (off at first)
  hoprig auto order a b c     the providers Auto mode uses, most preferred first

  hoprig demo                 try the dashboard with sample data (no Claude Code or provider needed)
  hoprig pc setup             make a fresh computer ready for coding (git, Node, tools, GitHub, projects)
  hoprig pc status            what this computer has, what is missing, what needs attention
  hoprig project new <name>   a new project: one folder for rules, AI memory and docs, with its code
                                 repositories under code/, all in git
  hoprig project clone <name> get an existing project with all its code repositories and its AI memory
  hoprig project status|sync  the state of a project's repositories; pull and push what is safe
  hoprig workspace            the one folder tree for your coding: AI brain, projects, credentials
                                 (workspace status | setup | link | map | restore | sync | set | forget | git)

  hoprig setup                install what is missing and set everything up, step by step
  hoprig doctor               check that everything works
  hoprig claude status        Claude Code's version (also: claude update, claude install <version>)
  hoprig update               update Hoprig itself

  hoprig link                 a one-time link and QR code that signs a phone or another browser in
  hoprig machines             the other computers this dashboard also shows (add, list, remove)
  hoprig join <ssh target>    connect THIS computer out to another dashboard (for a PC behind a router)
  hoprig pair                 let another computer's dashboard control this one
  hoprig tokens               who may control this computer (list, revoke)

  hoprig skills               Claude Code skills for you and your projects: suggest, find, review and
                                 add, update (skills suggest | find | add | list | update)
  hoprig addons               optional companions, such as an AI gateway that lets Claude Code use
                                 other providers (addons setup trouteai)
  hoprig mcp                  Hoprig's tools as an MCP server (for the dashboard's assistant and
                                 for any MCP client, such as your own Claude Code)

  hoprig serve                start the web dashboard
  hoprig passwd               set the dashboard password
  hoprig service install      run the dashboard in the background

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
  rememberLast(name);
  return launch(name, args, { askNext: async (ctx) => {
    const next = await askNext(ctx);
    if (next) rememberLast(next);
    return next;
  } });
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

  switch (cmd) {
    case 'hook':
      await hookMain();
      return 0;
    case 'profiles': {
      // "auto" is listed too when it can be used, so wrapper scripts accept it as a profile name.
      const list = menuProfiles().map(publicProfile);
      if (rest.includes('--json')) console.log(JSON.stringify(list));
      else for (const p of list) console.log(`${p.name}\t${p.kind}\t${p.label}`);
      return 0;
    }
    case 'add':
      return (await addProfile(rest[0])) ? 0 : 1;
    case 'rm': {
      if (!rest[0]) {
        console.error('usage: hoprig rm <name>');
        return 2;
      }
      const ok = deleteProfile(rest[0]);
      console.log(ok ? `Deleted the profile "${rest[0]}".` : `There is no profile "${rest[0]}".`);
      return ok ? 0 : 1;
    }
    case 'run': {
      if (!rest[0]) {
        console.error('usage: hoprig run <profile> [args for Claude Code]');
        return 2;
      }
      return start(rest[0], rest.slice(1));
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
    case 'pc':
    case 'project': {
      const pc = await import('../src/pcsetup/cli.mjs');
      return (await pc.main(cmd, rest)) ?? 0;
    }
    case 'workspace': {
      const ws = await import('../src/workspace/cli.mjs');
      return ws.main(rest);
    }
    case 'demo': {
      const demo = await import('../src/demo/cli.mjs');
      const code = await demo.main(cmd, rest);
      return Number.isInteger(code) ? code : null; // the demo dashboard keeps running until Ctrl+C
    }
    case 'skills': {
      const hub = await import('../src/skillhub/cli.mjs');
      return (await hub.main(cmd, rest)) ?? 0;
    }
    case 'addons': {
      const addons = await import('../src/addons/cli.mjs');
      return addons.main(cmd, rest);
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
