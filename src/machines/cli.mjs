// The commands for several computers: pair, tokens, machines. Called by the bin script.
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig } from '../config.mjs';
import { runningDashboard } from '../server/dashboardfile.mjs';
import { createLoginLink, loginLinkStatus } from '../server/loginlink.mjs';
import { qrText } from '../setup/qr.mjs';
import { configuredInstaller, createHub, defaultHubName } from './hub.mjs';
import { JoinKeeper, accept, joinByAddress, joinHub, leaveHub, loadJoined, publicJoined } from './join.mjs';
import { BY_HAND, hubCertificate, joinCommand, pinOf, toX509 } from './hubcert.mjs';
import { joinLine, parseJoinLine } from './joinline.mjs';
import { reachableUrl } from '../addons/reach.mjs';
import { createLinkCode } from './link.mjs';
import { tokenName } from './names.mjs';
import { CODE_TTL_MS, cancelCode, codeStatus, createCode, dashboardAddress, listening, pairInfo, rawDashboardAddress as dashboardAddressRaw } from './pairing.mjs';
import { loadMachines, publicMachine } from './store.mjs';
import { createToken, listTokens, revokeToken } from './tokens.mjs';
import { needsYes } from '../yes.mjs';

export const USAGE = `usage:
  hoprig link [--minutes N] [--url ADDRESS] [--open]
                                         a one-time sign-in link and its QR code: scan it with a phone and that
                                         phone is signed in, no password to type (works once, 15 minutes)
                                         --open: no code, the link opens in this computer's own browser

  hoprig pair                         show a one-time code (10 min) that lets another computer's dashboard
                                         control this one: there, Computers → Add by address
  hoprig pair --json [--name NAME] [--hub]
                                      for another dashboard that logs in here by SSH: make a token for NAME
                                      (--hub: that dashboard is your main computer, which adds this one)
                                         and print it, with this dashboard's port, as one line of JSON

  hoprig tokens [--json]              who may control this computer
  hoprig tokens revoke <id | name> [--yes]
                                         take that right away (asks first; --yes: without asking)

  hoprig machines [--json]            the other computers this dashboard shows
  hoprig machines add <user@host>     add one by SSH (key login; nothing to open in a firewall)
          [--name NAME] [--label TEXT]
  hoprig machines add <https://...> --code CODE [--name NAME]
                                         add one by its address and the code "hoprig pair" shows there
  hoprig machines test <name>         check that it answers
  hoprig machines rename <name> <new-name>
  hoprig machines rm <name> [--yes]   remove it (by SSH its token there is revoked too; asks first)

  hoprig join <https://ADDRESS#join=CODE>
  hoprig join <https://ADDRESS> <CODE>   for a computer the main computer cannot reach (a computer at home behind
                                         a router): it connects OUT to the main computer's dashboard and stays
                                         connected, also after a restart. The line comes from the main computer
                                         ("hoprig machines invite" there, or Computers → Add a computer → "It is
                                         at home or behind a router").
          [--fingerprint sha256:…]       for a main computer with its own HTTPS certificate (no public authority
                                         signed it, as with an IP address and --tls-internal): the main computer
                                         shows the whole line with it. Checked on every connection; never turns
                                         checking off.
          [--insecure]                   plain http:// to another computer, NOT encrypted: only on a network
                                         you trust. Not a fix for a certificate problem (use --fingerprint)
  hoprig join <user@host>             the same over SSH instead (needs an SSH login to the main computer)
  hoprig join                         the dashboards this computer has joined
  hoprig join --leave <ADDRESS>       stop: that main computer forgets this computer (its address, or
                                         user@host for one joined over SSH)
  hoprig machines invite              on the main computer: a one-time code for a computer that connects by itself,
                                         and the whole line to type there
  hoprig machines fingerprint [FILE|-]
                                         on the main computer: the fingerprint of its own certificate authority
                                         (from a certificate file, or - for one on stdin)
  hoprig machines join …              the same as hoprig join …
  hoprig machines leave <ADDRESS>     the same as hoprig join --leave <ADDRESS>
  hoprig machines accept              the main computer's side of hoprig join over SSH: the joining computer runs it
                                         there (it reads one request on its input); not typed by hand
`;

/** --flag value / --flag=value options, the rest positional. Unknown flags are an error. */
function parse(args, known) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (!(k in known)) throw new Error(`unknown option --${k}`);
    if (known[k] === 'bool') out[k] = true;
    else {
      const v = inline ?? args[++i];
      if (v === undefined) throw new Error(`--${k} needs a value`);
      out[k] = v;
    }
  }
  return out;
}

/** A command that takes only options: a word on its own is a mistake (a typo, "help"), not an argument. */
function noWords(o, command) {
  if (o._.length) throw new Error(`takes no word such as "${String(o._[0]).slice(0, 40)}" (its options: hoprig ${command} --help)`);
}

const when = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

async function pair(args) {
  const o = parse(args, { json: 'bool', name: 'value', hub: 'bool' });
  // A stray word is refused, never taken as "go ahead": the code this makes gives another dashboard this computer.
  noWords(o, 'pair');
  if (o.json) {
    const name = o.name === undefined ? 'another computer' : tokenName(o.name);
    if (!name) throw new Error('--name: 1 to 60 letters, digits, spaces or ._@()-');
    console.log(JSON.stringify(await pairInfo(name, { createToken, hub: o.hub === true })));
    return 0;
  }
  const addr = dashboardAddress();
  const running = await listening(addr);
  const { id, code, expires } = createCode();
  console.log(`\n  Pairing code:  ${code}\n`);
  console.log(`On the other computer's dashboard: Computers → Add by address,`);
  console.log(`then enter this computer's dashboard address and the code. It works once, for ${CODE_TTL_MS / 60000} minutes.`);
  if (!running) console.log(`\nThis computer's dashboard is not running (nothing answers on ${addr.host}:${addr.port}). Start it, or the code cannot be used: hoprig serve`);
  if (!process.stdout.isTTY) return 0; // scripted: print and go
  console.log('\nWaiting… (Ctrl+C to cancel)');
  return new Promise((resolve) => {
    const stop = (code_) => {
      clearInterval(t);
      process.off('SIGINT', onInt);
      resolve(code_);
    };
    const onInt = () => {
      cancelCode(id);
      console.log('\nCancelled; the code no longer works.');
      stop(130);
    };
    process.once('SIGINT', onInt);
    const t = setInterval(() => {
      const s = codeStatus(id);
      if (s && s.claimedBy !== undefined) {
        console.log(`Paired: "${s.claimedBy}" may now control this computer. See or revoke it with: hoprig tokens`);
        stop(0);
      } else if (s === 'expired' || Date.now() > expires) {
        console.log('The code expired. Run hoprig pair again for a new one.');
        stop(1);
      }
    }, 1000);
  });
}

async function tokens(args) {
  const o = parse(args, { json: 'bool', yes: 'bool' });
  const [sub, arg] = o._;
  if (sub === 'revoke') {
    if (!arg || o._.length > 2) throw new Error('usage: hoprig tokens revoke <id | name> [--yes]');
    const which = listTokens().filter((t) => t.id === arg || t.name === arg);
    if (!which.length) {
      console.error(`No token with the id or name "${arg}". See: hoprig tokens`);
      return 1;
    }
    const names = which.map((t) => `${t.name} (${t.id})`).join(', ');
    const no = await needsYes({ yes: o.yes, command: 'hoprig tokens revoke', act: `Revoking ${names}`, question: `Revoke ${names}? That dashboard can no longer control this computer.`, done: 'revoked' });
    if (no !== null) return no;
    const gone = revokeToken(arg);
    if (!gone.length) {
      console.error(`No token with the id or name "${arg}". See: hoprig tokens`);
      return 1;
    }
    if (o.json) console.log(JSON.stringify({ hoprig: 'revoked', revoked: gone }));
    else for (const t of gone) console.log(`Revoked: ${t.name} (${t.id}). That dashboard can no longer control this computer.`);
    return 0;
  }
  if (sub !== undefined) throw new Error(`unknown tokens command "${sub}"`);
  const list = listTokens();
  if (o.json) console.log(JSON.stringify(list));
  else if (!list.length) console.log('No other dashboard may control this computer. Allow one with: hoprig pair');
  else {
    console.log('Who may control this computer:');
    for (const t of list) console.log(`  ${t.id}  ${t.name.padEnd(24)}  added ${when(t.created)}, last used ${when(t.lastUsed)}`);
    console.log('\nRevoke one with: hoprig tokens revoke <id>');
  }
  return 0;
}

function hub() {
  return createHub({ installer: () => configuredInstaller(), hubName: defaultHubName() });
}

const show = (m) => {
  const what = m.via === 'ssh' ? `ssh ${m.target}` : m.url || 'connects by itself (it joined this dashboard)';
  const state = m.state ? `  ${m.state}${m.error ? ` (${m.error})` : ''}` : '';
  const ver = m.version ? `  Hoprig ${m.version}` : '';
  return `  ${m.name.padEnd(16)} ${String(m.label || '').padEnd(20)} ${what}${ver}${state}`;
};

/** Read all of stdin (the accept request: it carries a token, so never on the command line). */
async function readStdin() {
  let text = '';
  for await (const c of process.stdin) text += c;
  return text;
}

async function join(args) {
  const o = parse(args, { leave: 'bool', again: 'bool', json: 'bool', insecure: 'bool', fingerprint: 'value' });
  // The one line the main Hoprig shows (address#join=CODE) is read as its address, code and fingerprint.
  const pasted = o._.length === 1 && String(o._[0]).includes('#join=') ? parseJoinLine(o._[0]) : null;
  const [target, code] = pasted ? [pasted.url, pasted.code] : o._;
  if (pasted && pasted.fingerprint && o.fingerprint === undefined) o.fingerprint = pasted.fingerprint;
  if (!target) {
    const hubs = loadJoined().map((h) => publicJoined(h));
    if (o.json) console.log(JSON.stringify(hubs));
    else if (!hubs.length) console.log('This computer has not joined another dashboard. To show it on one: hoprig join https://<its address> CODE (the code comes from that dashboard)');
    else {
      console.log('This computer connects by itself to:');
      for (const h of hubs) console.log(`  ${h.hub.padEnd(20)} ${h.via === 'link' ? `${h.url} (direct link)` : `ssh ${h.target} (port ${h.port} on that computer)`}  shown there as "${h.name}"`);
      if (!runningDashboard()) console.log('\nThis computer\'s dashboard is not running, so it is not connected now. Start it: hoprig service install');
    }
    return 0;
  }
  const keeper = new JoinKeeper();
  try {
    if (o.leave) {
      const r = await leaveHub(target, { keeper });
      console.log(`Left ${r.hub}.${r.hubForgot ? ' It no longer shows this computer.' : ' It could not be told now, but it can no longer reach this computer.'}`);
      return 0;
    }
    if (/^https?:\/\//i.test(target)) {
      if (!code) throw new Error('add the code the other dashboard shows: hoprig join https://<its address> CODE');
      console.log(`Connecting to ${target}…`);
      const h = await joinByAddress(target, code, { keeper, insecure: o.insecure, fingerprint: o.fingerprint === undefined ? null : o.fingerprint });
      if (o.json) console.log(JSON.stringify({ hoprig: 'join', ...publicJoined(h) }));
      else {
        console.log(`Joined: ${h.hubLabel} now shows this computer as "${h.name}" (direct link).`);
        if (h.replaced) console.log('It replaced this computer\'s earlier entry there (same name and label); the old link no longer works.');
        if (h.pin) console.log(`Its certificate is checked against the authority with the fingerprint ${h.pin}, on every connection.`);
        console.log('This computer\'s dashboard keeps the link, also after a restart. It can only be controlled from there, not the other way round.');
      }
      return 0;
    }
    const before = loadJoined().find((h) => h.target === target);
    if (before && !o.again) {
      console.log(`This computer has already joined ${before.hubLabel || target}. To join again with a new token: hoprig join --again ${target}`);
      return 0;
    }
    if (before) await leaveHub(target, { keeper });
    console.log(`Connecting to ${target} by SSH…`);
    const h = await joinHub(target, { keeper });
    if (o.json) console.log(JSON.stringify({ hoprig: 'join', ...publicJoined(h) }));
    else {
      console.log(`Joined: ${h.hubLabel} now shows this computer as "${h.name}".`);
      console.log('This computer\'s dashboard keeps the connection, also after a restart. It can only be controlled from there, not the other way round.');
    }
    return 0;
  } catch (e) {
    console.error(`hoprig join: ${e.message}`);
    return 1;
  } finally {
    // The running dashboard takes the connection over (it reads joined.json every few seconds).
    keeper.close();
  }
}

/** `hoprig machines fingerprint [FILE|-]`: this hub's own authority, or the one in a certificate file. */
async function fingerprint(args) {
  const o = parse(args, { json: 'bool' });
  const [file] = o._;
  let pin = null;
  let why = null;
  let fine = false; // nothing to pin, and nothing wrong
  if (file) {
    let text = '';
    if (file === '-') for await (const c of process.stdin) text += c;
    else text = fs.readFileSync(file, 'utf8');
    if (!toX509(text)) throw new Error(`${file === '-' ? 'stdin' : file} holds no certificate (PEM)`);
    pin = pinOf(text);
  } else {
    const base = linkBase();
    const cert = base.local ? { kind: 'unknown', why: 'this dashboard has no public address (publicUrl)' } : await hubCertificate(base.url);
    fine = cert.kind === 'public' || cert.kind === 'plain';
    if (cert.kind === 'own') pin = cert.pin;
    else why = cert.kind === 'public' ? `${base.url} has a publicly trusted certificate: no fingerprint is needed`
      : cert.kind === 'plain' ? `${base.url} is not https://: there is no certificate`
        : `${cert.why}. Read Caddy's authority from its data folder instead: ${BY_HAND}`;
  }
  if (o.json) console.log(JSON.stringify({ hoprig: 'fingerprint', fingerprint: pin, reason: why }));
  else console.log(pin || why);
  return pin || fine ? 0 : 1;
}

async function machines(args) {
  if (args[0] === 'join') return join(args.slice(1));
  if (args[0] === 'leave') return join(['--leave', ...args.slice(1)]);
  if (args[0] === 'invite') {
    const c = createLinkCode();
    const base = linkBase();
    // The hub's own certificate: the line then carries its authority's fingerprint (hubcert.mjs).
    const cert = base.local ? null : await hubCertificate(base.url);
    const { line, note } = joinCommand(base.local ? 'https://<this dashboard\'s address>' : base.url, c.code, cert);
    if (args.includes('--json')) console.log(JSON.stringify({ hoprig: 'invite', ...c, url: base.url, certificate: cert ? cert.kind : null, fingerprint: cert && cert.kind === 'own' ? cert.pin : null, command: line, line: base.local ? null : joinLine(base.url, c.code, cert && cert.kind === 'own' ? cert.pin : null) }));
    else {
      console.log(`\n  Code:  ${c.code}\n`);
      const plain = cert && cert.kind === 'plain';
      if (!base.local) console.log(`On the other computer: Computers → Link to my main Hoprig, and paste:\n  ${joinLine(base.url, c.code, cert && cert.kind === 'own' ? cert.pin : null)}\n`);
      console.log(`Or there in a terminal:  ${line}`);
      if (note) console.log(note);
      if (plain) console.log('This address is not encrypted (http://): what that computer sends, and everything typed into its sessions, crosses the network readable. Put this dashboard behind HTTPS for anything but a network you trust.');
      console.log(`The code works once, for ${CODE_TTL_MS / 60000} minutes.`);
      if (base.local) console.log('This dashboard listens on this computer only; the other computer needs an address it can reach (a reverse proxy with HTTPS, or --host).');
    }
    return 0;
  }
  if (args[0] === 'fingerprint') return fingerprint(args.slice(1));
  if (args[0] === 'accept') {
    // The hub's side of `hoprig join`, run over SSH by the joining computer. Request and answer are one JSON each.
    console.log(JSON.stringify(await accept(await readStdin())));
    return 0;
  }
  const o = parse(args, { json: 'bool', name: 'value', label: 'value', code: 'value', yes: 'bool' });
  const [sub, a, b] = o._;
  if (sub === undefined || sub === 'list') {
    const list = loadMachines().map(publicMachine);
    if (o.json) console.log(JSON.stringify(list));
    else if (!list.length) console.log('No other computers yet. Add one: hoprig machines add user@host');
    else {
      console.log('Other computers this dashboard shows:');
      for (const m of list) console.log(show(m));
    }
    return 0;
  }
  const h = hub();
  try {
    switch (sub) {
      case 'add': {
        if (!a) throw new Error('usage: hoprig machines add <user@host | https://address --code CODE>');
        const byUrl = /^https?:\/\//i.test(a);
        if (byUrl && !o.code) throw new Error(`run "hoprig pair" on that computer and add --code with the code it shows`);
        console.log(byUrl ? `Pairing with ${a}…` : `Connecting to ${a} by SSH…`);
        const r = byUrl ? await h.addByUrl({ url: a, code: o.code, name: o.name, label: o.label }) : await h.addBySsh({ target: a, name: o.name, label: o.label });
        if (o.json) console.log(JSON.stringify(r));
        else {
          console.log(`Added "${r.machine.name}".`);
          console.log(show(r.machine));
          if (r.hint) console.log(r.hint);
        }
        return 0;
      }
      case 'test': {
        const m = loadMachines().find((x) => x.name === a);
        if (!m) throw new Error(`no computer called "${a}"`);
        const r = await h.probe(m, { fresh: true, timeoutMs: 15_000 });
        if (o.json) console.log(JSON.stringify(r));
        else console.log(show(r));
        return r.state === 'online' ? 0 : 1;
      }
      case 'rename': {
        if (!a || !b) throw new Error('usage: hoprig machines rename <name> <new-name>');
        const m = h.rename(a, { name: b });
        console.log(`Renamed to "${m.name}".`);
        return 0;
      }
      case 'rm':
      case 'remove': {
        if (!a || b) throw new Error('usage: hoprig machines rm <name> [--yes]');
        if (!loadMachines().some((m) => m.name === a)) throw new Error(`no computer named "${a}". See: hoprig machines`);
        const no = await needsYes({ yes: o.yes, command: 'hoprig machines rm', act: `Removing the computer "${a}"`, question: `Remove the computer "${a}"? This dashboard no longer shows or controls it.`, done: 'removed' });
        if (no !== null) return no;
        const r = await h.remove(a);
        console.log(`Removed "${a}".${r.revoked ? ' Its token there was revoked too.' : ''}`);
        if (r.note) console.log(r.note);
        return 0;
      }
      default:
        throw new Error(`unknown machines command "${sub}"`);
    }
  } catch (e) {
    console.error(`hoprig machines: ${e.message}`);
    if (e.installCommand) console.error(`Install it there with:\n\n  ${e.installCommand}\n`);
    return 1;
  } finally {
    h.close();
  }
}

/**
 * The address another device reaches this dashboard at: server.publicUrl when set, else the public link's while it
 * is on (reach.mjs), else the running dashboard's address, with this computer's network address in place of 0.0.0.0
 * (127.0.0.1 only works on this computer).
 */
export function linkBase(cfg = loadConfig(), interfaces = os.networkInterfaces(), running = runningDashboard()) {
  const s = cfg.server || {};
  if (typeof s.publicUrl === 'string' && /^https?:\/\//.test(s.publicUrl)) return { url: s.publicUrl, local: false };
  const reach = reachableUrl(cfg);
  if (reach) return { url: reach, local: false };
  const { host, port } = dashboardAddressRaw(cfg, running);
  if (host === '0.0.0.0' || host === '::' || host === '') {
    const lan = Object.values(interfaces).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
    if (lan) return { url: `http://${lan.address}:${port}`, local: false };
  }
  const h = host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const local = /^(127\.|localhost$|::1$)/.test(h);
  return { url: `http://${h.includes(':') ? `[${h}]` : h}:${port}`, local };
}

async function link(args, hooks = {}) {
  const o = parse(args, { minutes: 'value', url: 'value', json: 'bool', open: 'bool' });
  noWords(o, 'link'); // the link signs a browser in: only on a command line that asked for exactly that
  const minutes = o.minutes === undefined ? 15 : Number(o.minutes);
  const base = o.url ? { url: o.url, local: false } : linkBase();
  const r = createLoginLink({ baseUrl: base.url, minutes });
  if (o.open) {
    // This computer's own browser, signed in by the link: the Start menu and app menu entries run this. No QR code.
    // Where no browser can open (a server over ssh), the link is printed all the same.
    const { openBrowser, openedLines } = await import('../openbrowser.mjs');
    const opened = (hooks.open || openBrowser)(r.url);
    console.log(opened ? openedLines(r.url, minutes).join('\n') : `Open this link in a browser (it works once, for ${minutes} minutes):\n  ${r.url}`);
    return 0;
  }
  if (o.json) {
    console.log(JSON.stringify({ hoprig: 'link', url: r.url, expires: r.expires }));
    return 0;
  }
  const qr = qrText(r.url);
  console.log(`\nScan with your phone's camera to sign in (the link works once, for ${minutes} minute${minutes === 1 ? '' : 's'}):\n`);
  if (qr) console.log(qr.replace(/^/gm, '  '));
  console.log(`  ${r.url}\n`);
  if (base.local) console.log('This address only works on this computer. For a phone, give the page\'s address: hoprig link --url https://your-address\n');
  if (!process.stdout.isTTY) return 0;
  // Say when it was used, so nobody has to guess whether the phone got in.
  return new Promise((resolve) => {
    const t = setInterval(() => {
      const st = loginLinkStatus(r.id);
      if (st === 'pending') return;
      clearInterval(t);
      console.log(st === 'used' ? 'Signed in. The link no longer works.' : 'The link expired. Run hoprig link again for a new one.');
      resolve(st === 'used' ? 0 : 1);
    }, 1000);
  });
}

/** Entry point from the bin script. Returns an exit code. */
export async function main(command, args = [], hooks = {}) {
  try {
    if (args.includes('--help') || args.includes('-h')) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (command === 'link') return await link(args, hooks);
    if (command === 'pair') return await pair(args);
    if (command === 'tokens') return await tokens(args);
    if (command === 'machines') return await machines(args);
    if (command === 'join') return await join(args);
  } catch (e) {
    console.error(`hoprig ${command}: ${e.message}`);
    return 2;
  }
  process.stderr.write(USAGE);
  return 2;
}
