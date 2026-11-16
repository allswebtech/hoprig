// The terminal menus: choose a profile, continue a session elsewhere, add a profile.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { getAutoSwitch, limitedProfiles, recommendedProfile, usableOrder } from './autoswitch.mjs';
import { loadConfig } from './config.mjs';
import { stateDir, tilde } from './paths.mjs';
import { AUTH_VARS, listProfiles, readProfile, validName, writeProfile } from './profiles.mjs';
import { sessionsIn } from './sessions.mjs';

const out = (s = '') => process.stdout.write(s + '\n');
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

/** Ask for one line. Resolves to null on Ctrl+C or Ctrl+D. */
export function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    const finish = (v) => {
      if (answered) return;
      answered = true;
      rl.close();
      resolve(v);
    };
    rl.on('SIGINT', () => { out(); finish(null); });
    rl.on('close', () => finish(null));
    rl.question(question, (a) => finish(a.trim()));
  });
}

/** Ask for a secret: nothing is echoed. Resolves to null on Ctrl+C. */
export function askHidden(question) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return ask(question);
  return new Promise((resolve) => {
    stdout.write(question);
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (v) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      resolve(v);
    };
    const onData = (chunk) => {
      // A paste may arrive wrapped in terminal escape sequences; they are not part of the secret.
      for (const ch of chunk.replace(/\x1b\[[0-9;]*[~A-Za-z]/g, '')) {
        if (ch === '\r' || ch === '\n') return finish(buf.trim());
        if (ch === '\u0003' || ch === '\u0004') return finish(null);
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const lastFile = () => path.join(stateDir(), 'last.json');
function lastUsed() {
  try {
    return JSON.parse(fs.readFileSync(lastFile(), 'utf8')).profile || null;
  } catch {
    return null;
  }
}
export function rememberLast(profile) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lastFile(), JSON.stringify({ profile }) + '\n', { mode: 0o600 });
  } catch {
    /* only a convenience */
  }
}

export function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** "5:10 pm", or "Nov 18, 9:00 am" when it is not today. */
export function clock(ms, now = Date.now()) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

// "limit reached · until about 5:10 pm" for a profile that is at its limit, else ''.
function limitNote(name, limited) {
  const l = limited[name];
  return l ? `limit reached · until ${l.exact ? '' : 'about '}${clock(l.until)}` : '';
}

function table(profiles, mark) {
  const w = Math.max(...profiles.map((p) => p.name.length));
  profiles.forEach((p, i) => {
    const note = mark(p);
    out(`  ${bold(String(i + 1).padStart(2))}  ${p.name.padEnd(w)}  ${dim(p.label)}${note ? `  ${note}` : ''}`);
  });
}

/**
 * Read "2", "api", "2c", "apic": a profile by number or name, with an optional c (continue) or r (pick) suffix.
 * An exact profile name always wins, so a profile called "abc" is not read as "ab" + c.
 */
export function parseChoice(answer, profiles) {
  const a = answer.toLowerCase();
  const byName = (n) => profiles.find((p) => p.name === n);
  const byRef = (ref) => (/^\d+$/.test(ref) ? profiles[Number(ref) - 1] : byName(ref));
  if (byName(a)) return { profile: byName(a), mode: 'new' };
  const m = /^(.+?)([cr])?$/.exec(a);
  if (!m) return null;
  const whole = byRef(a);
  if (whole) return { profile: whole, mode: 'new' };
  if (m[2]) {
    const p = byRef(m[1]);
    if (p) return { profile: p, mode: m[2] === 'c' ? 'continue' : 'pick' };
  }
  return null;
}

/**
 * What the menus offer: the real profiles and, when an order is set, "auto" on top: Claude Code talks to the
 * router, which moves to the next account at a limit without the session stopping.
 */
export function menuProfiles() {
  const real = listProfiles();
  const as = getAutoSwitch();
  const names = usableOrder();
  if (!names.length) return real;
  // The line says what is true now: with Auto mode off nothing starts under "auto" by itself, but a session that
  // is started under it by name still goes through the router and moves on at a limit.
  const what = as.enabled ? 'moves on at a limit, without stopping' : 'Auto mode is off: only a session started as "auto" by name moves on at a limit';
  return [{ name: 'auto', label: `${names.join(' → ')}  (${what})`, kind: 'auto' }, ...real];
}

/** With no profile at all, start with one for the account Claude Code is already logged in with. */
export function ensureFirstProfile() {
  if (listProfiles().length) return;
  writeProfile('sub', { label: 'Claude account (stored login)' });
  out(dim('Created the profile "sub": the Claude account this machine is logged in with (claude /login).'));
}

/**
 * The start menu. `sessionChosen` is true when the caller already passed -c / --resume.
 * Resolves to { name, extraArgs } or null (quit).
 */
export async function chooseProfile({ sessionChosen = false } = {}) {
  ensureFirstProfile();
  for (;;) {
    const profiles = menuProfiles();
    const limited = limitedProfiles();
    const as = getAutoSwitch();
    // Enter takes the best profile to start on: "auto" when Auto mode is on, else the first of the order that is
    // not at its limit, else the one used last (unless that one is at its limit), else the first.
    const pick = [as.enabled ? 'auto' : null, recommendedProfile(), lastUsed()].find((n) => n && !(n in limited) && profiles.some((p) => p.name === n));
    const def = profiles.find((p) => p.name === pick) || profiles.find((p) => !(p.name in limited)) || profiles[0];
    const sessions = sessionChosen ? [] : sessionsIn(process.cwd());
    out();
    out(`${bold('Hoprig')} ${dim('·')} ${tilde(process.cwd())}`);
    out();
    table(profiles, (p) => [limitNote(p.name, limited), p.name === def.name ? dim('← Enter') : ''].filter(Boolean).join('  '));
    out();
    out(`  ${bold(' a')}  add a profile      ${bold('q')}  quit`);
    out(dim(as.enabled
      ? '  Auto mode is on: Enter starts under "auto".'
      : '  Auto mode is off (turn it on: hoprig auto on). At a limit you choose the next profile yourself.'));
    if (sessions.length) {
      out(dim(`  Last session here: ${ago(sessions[0].mtimeMs)}. Add c to continue it (1c), r to choose one (1r).`));
    }
    const answer = await ask('> ');
    if (answer === null || answer.toLowerCase() === 'q') return null;
    if (answer.toLowerCase() === 'a') {
      await addProfile();
      continue;
    }
    const choice = answer === '' ? { profile: def, mode: 'new' } : parseChoice(answer, profiles);
    if (!choice) {
      out(`"${answer}" is not on the list.`);
      continue;
    }
    if (choice.mode !== 'new' && !sessions.length) {
      out(sessionChosen ? 'The session is already chosen by the flags you passed.' : 'There is no earlier session in this folder; starting a new one.');
      choice.mode = 'new';
    }
    const extraArgs = choice.mode === 'continue' ? ['-c'] : choice.mode === 'pick' ? ['--resume'] : [];
    return { name: choice.profile.name, extraArgs };
  }
}

/** After Claude exits: carry the same session on under another profile? Resolves to a profile name or null. */
export async function askNext({ current, sessionId }) {
  const profiles = menuProfiles();
  if (profiles.length < 2) return null;
  out();
  out(`Session ${bold(sessionId.slice(0, 8))} is saved. Continue it on another profile?`);
  out();
  const limited = limitedProfiles();
  table(profiles, (p) => [p.name === current ? dim('(it ran here)') : '', limitNote(p.name, limited)].filter(Boolean).join('  '));
  out();
  out(`  ${bold('Enter')}  quit`);
  for (;;) {
    const answer = await ask('> ');
    if (answer === null || answer === '' || answer.toLowerCase() === 'q') return null;
    const choice = parseChoice(answer, profiles);
    if (choice) return choice.profile.name;
    out(`"${answer}" is not on the list.`);
  }
}

/** `hoprig add [name]`: create a profile by asking a few questions. Returns the profile name or null. */
export async function addProfile(nameArg) {
  out();
  out(bold('New profile'));
  let name = nameArg;
  for (;;) {
    if (name === undefined) name = await ask('Name (short, like sub2 or work): ');
    if (name === null || name === '') return null;
    name = name.toLowerCase();
    if (!validName(name)) {
      out('Use letters, digits, - or _ (not a command word such as "add" or "run").');
      name = undefined;
      continue;
    }
    if (readProfile(name)) {
      const yes = await ask(`"${name}" exists. Replace it? (y/N) `);
      if (yes === null) return null;
      if (!/^y/i.test(yes)) {
        name = undefined;
        continue;
      }
    }
    break;
  }
  out();
  out('What is it?');
  out(`  ${bold('1')}  another Claude subscription account`);
  out(`  ${bold('2')}  an Anthropic API key`);
  out(`  ${bold('3')}  an API through a proxy or gateway (base URL + token)`);
  out(`  ${bold('4')}  the Claude account this machine is logged in with (claude /login)`);
  const kind = await ask('> ');
  if (kind === null || kind === '') return null;

  const env = {};
  let prerun = '';
  let defaultLabel = '';
  if (kind === '1') {
    out();
    out('A browser sign-in starts now. Sign in with THE ACCOUNT FOR THIS PROFILE (check which account the');
    out('browser is logged in with first). At the end Claude Code shows a long-lived token: copy it.');
    const go = await ask('Press Enter to start (or type s if you already have a token) ');
    if (go === null) return null;
    if (go.toLowerCase() !== 's') {
      const clean = { ...process.env };
      for (const k of AUTH_VARS) delete clean[k];
      const r = spawnSync(loadConfig().claudeBin, ['setup-token'], { stdio: 'inherit', env: clean });
      if (r.error) {
        out(`Could not run "claude setup-token": ${r.error.message}`);
        return null;
      }
    }
    const token = await askHidden('Paste the token (it is not shown): ');
    if (!token) return null;
    if (/\s/.test(token)) {
      out('That has spaces or line breaks in it, so it is not one token. Nothing was saved.');
      return null;
    }
    if (!token.startsWith('sk-ant-oat')) out(dim('Note: this does not look like a setup-token value (they start with sk-ant-oat). Saved as given.'));
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
    defaultLabel = 'Claude subscription';
  } else if (kind === '2') {
    const key = await askHidden('API key (it is not shown): ');
    if (!key) return null;
    env.ANTHROPIC_API_KEY = key;
    defaultLabel = 'Anthropic API';
  } else if (kind === '3') {
    const url = await ask('Base URL (for example http://localhost:8080): ');
    if (!url) return null;
    if (!/^https?:\/\/\S+$/.test(url)) {
      out('That is not an http(s) URL. Nothing was saved.');
      return null;
    }
    const token = await askHidden('Token for it (it is not shown; Enter if it needs none): ');
    if (token === null) return null;
    env.ANTHROPIC_BASE_URL = url;
    if (token) env.ANTHROPIC_AUTH_TOKEN = token;
    const pre = await ask('Command to run before Claude starts, e.g. to start the proxy (Enter for none): ');
    if (pre === null) return null;
    prerun = pre;
    defaultLabel = `API via ${url.replace(/^https?:\/\//, '')}`;
  } else if (kind === '4') {
    defaultLabel = 'Claude account (stored login)';
  } else {
    out('Nothing was saved.');
    return null;
  }
  const label = await ask(`Label shown in menus [${defaultLabel}]: `);
  if (label === null) return null;
  writeProfile(name, { label: label || defaultLabel, prerun, env });
  out(`Saved. Start it with: hoprig ${name}`);
  return name;
}
