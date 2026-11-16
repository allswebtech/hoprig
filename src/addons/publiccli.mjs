// `hoprig public`: the Public link switch from a terminal.
//
//   hoprig public [status] [--json]               on or off, the kind, the address
//   hoprig public on [--temporary|--custom] [--yes] [--new-password FILE]
//   hoprig public off
//
// It writes the choice (config.json publicLink) and the running dashboard, which runs the link, acts on it within a
// few seconds (linkswitch.mjs); this command then waits for the address and shows it with a sign-in QR code. With no
// dashboard running, the choice is kept and the link starts with the dashboard. The old words
// `hoprig addons start|stop|status public-link` lead here (a profile's PRERUN may still say them).
import { loadConfig, saveConfig } from '../config.mjs';
import { ask, askHidden } from '../menu.mjs';
import { filedProcess } from '../procid.mjs';
import { verifyPassword } from '../server/auth.mjs';
import { runningDashboard } from '../server/dashboardfile.mjs';
import { notePassword } from '../server/strength.mjs';
import { linkRecordFile } from './cloudflared.mjs';
import { tunnelFact } from './linkmigrate.mjs';
import { KIND_WORDS, VISITOR_WORDS, cannotTurnOn, readRecord, readSwitch } from './linkswitch.mjs';

export const USAGE = `usage: hoprig public [status] [--json]        whether this dashboard can be reached from anywhere, and where
       hoprig public on [--temporary|--custom] [--yes] [--new-password FILE]
                                                turn the public link on (Temporary: a new address at each start,
                                                nothing to set up; Custom: your own address, set up in the page)
       hoprig public off                        turn it off`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The record's cloudflared still runs (its pid may be another program's after a restart: procid.mjs filedProcess). */
const tunnelRuns = (rec) => filedProcess(linkRecordFile(), rec, { fact: tunnelFact }) !== false;

/** The address while the link is on and connected, from the files the dashboard writes. */
function liveAddress() {
  const want = readSwitch();
  const rec = readRecord();
  return want.on && rec.kind === want.kind && rec.connected && rec.url && tunnelRuns(rec) ? rec.url : null;
}

/**
 * What `status` shows: { on, kind, state, url, error, dashboard }. An error counts only when the dashboard wrote it
 * for the turn-on that is chosen now: one left from an earlier try is not this one's answer (the dashboard tries again).
 */
export function statusOf() {
  const want = readSwitch();
  const rec = readRecord();
  const dashboard = !!runningDashboard();
  const url = liveAddress();
  const error = want.on && rec.error && Number(rec.errorAt) >= want.at ? rec.error : null;
  const state = !want.on ? 'off' : url ? 'on' : error ? 'error' : dashboard ? 'starting' : 'waiting for the dashboard';
  return { on: want.on, kind: want.kind, state, url, error, dashboard };
}

function show(s, out) {
  const kind = KIND_WORDS[s.kind].title;
  if (!s.on) return out(`The public link is off (kind: ${kind}). Turn it on: hoprig public on`);
  if (s.url) return out(`The public link is on (${kind}): ${s.url}`);
  if (s.error) return out(`The public link is on (${kind}) but does not run: ${s.error}`);
  return out(s.dashboard ? `The public link is on (${kind}) and starting.` : `The public link is on (${kind}); it starts when the dashboard runs (hoprig serve, or hoprig service install).`);
}

/** The address, and a QR code that signs a phone in once. */
async function showAddress(url, out) {
  out(`\nThe public link: ${url}`);
  try {
    const { createLoginLink } = await import('../server/loginlink.mjs');
    const { qrText } = await import('../setup/qr.mjs');
    const link = createLoginLink({ baseUrl: url, minutes: 15 });
    const qr = qrText(link.url);
    out("Scan with your phone's camera to sign in (works once, for 15 minutes):");
    if (qr) out(qr);
    out(link.url);
  } catch {
    /* the plain address is shown above */
  }
  out('Turn it off with: hoprig public off');
}

/** When the stored password was never judged: type it once here (only in a terminal). → true when it is strong now. */
async function judgeHere(out) {
  if (!process.stdin.isTTY) return false;
  const pw = await askHidden('Your dashboard password (to check that it is strong enough): ');
  const hash = loadConfig().server.passwordHash;
  if (!pw || !(await verifyPassword(pw, hash))) {
    out('That is not the dashboard password.');
    return false;
  }
  notePassword(pw, hash);
  return true;
}

const PASSWORD_NEEDS = ['password', 'check-password', 'stronger-password'];

/**
 * The old `hoprig addons start public-link`, as a profile's PRERUN runs it before a session: a password that is not
 * yet good enough for the link never stops the session from starting (nor waits at a hidden prompt there). The
 * reason is said, and the page asks for what it needs (Settings → Public link). → the exit code, or null to go on.
 */
function prerunHeld(kind, { out, err }) {
  const no = cannotTurnOn(kind);
  if (!no || !PASSWORD_NEEDS.includes(no.need)) return null;
  const now = statusOf();
  if (now.on && now.kind === kind && now.url) {
    // Carried over from an older version, it runs until the password is checked: where it is, and what is asked.
    out(`The public link is on (${KIND_WORDS[kind].title}): ${now.url}`);
    err(`It asks for one thing: ${no.error} (Settings → Public link)`);
    return 0;
  }
  err(`The public link ${now.on ? 'is on but waits' : 'was not turned on'}: ${no.error}`);
  err('Settings → Public link asks for it in place; or, in a terminal: hoprig public on');
  return 0;
}

async function on(args, { out, err, prerun = false }) {
  const kind = args.includes('--custom') ? 'custom' : args.includes('--temporary') ? 'temporary' : readSwitch().kind;
  const i = args.indexOf('--new-password');
  if (i >= 0) {
    const file = args[i + 1];
    if (!file || file.startsWith('--')) {
      err(USAGE);
      return 2;
    }
    const cli = await import('../server/cli.mjs');
    if ((await cli.main('passwd', ['--generate', file])) !== 0) return 1;
  }
  if (prerun) {
    const held = prerunHeld(kind, { out, err });
    if (held !== null) return held;
  }
  let no = cannotTurnOn(kind);
  if (no && no.need === 'check-password' && (await judgeHere(out))) no = cannotTurnOn(kind);
  if (no) {
    err(no.error);
    if (no.need === 'password' || no.need === 'stronger-password' || no.need === 'check-password') err('A strong one in one step: hoprig public on --new-password FILE (it writes a generated password to FILE).');
    if (no.need === 'custom-setup') err('Set it up in the page: Settings → Public link → Custom → Set up.');
    return 1;
  }
  // On already as this kind: nothing to ask, only where it is (a PRERUN that says it at every start stays quiet).
  const now = statusOf();
  if (now.on && now.kind === kind && now.url) {
    await showAddress(now.url, out);
    return 0;
  }
  const w = KIND_WORDS[kind];
  out(`The public link makes this dashboard reachable from anywhere, through Cloudflare, until you turn it off.`);
  out(`  ${w.title}: ${w.text} ${w.gives}`);
  out(`  ${VISITOR_WORDS}`);
  if (!args.includes('--yes')) {
    if (!process.stdin.isTTY) {
      err('Add --yes to turn it on without a question.');
      return 1;
    }
    const a = await ask('Turn it on? (y/N) ');
    if (!a || !/^y/i.test(a)) return 1;
  }
  // `at`: a new request, so the running dashboard starts it again even when a start of the same choice failed before.
  saveConfig({ publicLink: { on: true, kind, at: Date.now() } });
  if (!runningDashboard()) {
    out('Saved: it turns on when the dashboard runs (hoprig serve, or hoprig service install).');
    return 0;
  }
  out('Starting… (the first time, Hoprig installs cloudflared)');
  for (let t = 0; t < 120_000; t += 500) {
    const s = statusOf();
    if (s.url) {
      await showAddress(s.url, out);
      return 0;
    }
    if (s.error) {
      err(`It did not start: ${s.error}`);
      return 1;
    }
    if (!s.on) {
      err('It was turned off again (see Settings → Public link for why).');
      return 1;
    }
    await sleep(500);
  }
  err('No address yet: the dashboard keeps trying. See: hoprig public status');
  return 1;
}

async function off({ out }) {
  saveConfig({ publicLink: { on: false, kind: readSwitch().kind } });
  if (runningDashboard()) {
    for (let t = 0; t < 20_000 && tunnelRuns(readRecord()); t += 250) await sleep(250);
  }
  out('The public link is off.');
  return 0;
}

/** `prerun`: the old words from a profile's PRERUN (addons/cli.mjs), which must never stop a session from starting. */
export async function main(args = [], { out = (s) => console.log(s), err = (s) => console.error(s), prerun = false } = {}) {
  const [word = 'status', ...rest] = args;
  if (word === 'on') return on(rest, { out, err, prerun });
  if (word === 'off') return off({ out });
  if (word === 'status' || word === '--json') {
    const s = statusOf();
    if ([word, ...rest].includes('--json')) out(JSON.stringify({ hoprig: 'public-link', ...s }));
    else show(s, out);
    return 0;
  }
  err(USAGE);
  return 2;
}
