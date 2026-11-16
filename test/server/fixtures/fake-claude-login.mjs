#!/usr/bin/env node
// Stands in for Claude Code's own sign-in in tests: `claude auth login [--email <address>]`, `claude auth logout` and
// `claude auth status --json`. What it prints is what Claude Code 2.1.325 prints (probed with a Claude folder of its
// own, stopped before signing in): it hands BROWSER a link whose redirect is http://localhost:<port>/callback and
// listens there, and it prints a link that ends with a code to paste ("Paste code here if prompted >"); with
// --email the links carry login_hint. Past that point it follows the binary's own code: a line without "#" is
// "Invalid code…" (it keeps waiting), a refused code is "Login failed: …" and exit 1, a sign-in is
// "Login successful." and exit 0. As the real one, it starts a sign-in while one is stored and leaves the stored one
// alone until the new one succeeds; `auth logout` prints one line and exits 0, signed in or not.
// A sign-in leaves a mark in CLAUDE_CONFIG_DIR (which account) that `auth status` reads.
//   a code "good#<anything>" or a request to the callback   signs in the first account
//   a code "other#<anything>" or /callback?code=other        signs in a second account
//   FAKE_CLAUDE_MODE: "normal" (default) | "nolink" (never shows a link) | "exit" (exits at once)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [cmd, sub, ...rest] = process.argv.slice(2);
const mark = path.join(process.env.CLAUDE_CONFIG_DIR || '.', 'fake-signed-in');
const w = (s) => process.stdout.write(s);
if (cmd !== 'auth' || !['login', 'status', 'logout'].includes(sub)) {
  w('fake claude: only auth login, auth logout and auth status\n');
  process.exit(2);
}
// The real answer names the account; only the owner's own page may get that (the account route).
const ACCOUNTS = {
  first: { email: 'someone@example.invalid', orgId: '11111111-1111-4111-8111-111111111111', orgName: 'Example Org', subscriptionType: 'max' },
  other: { email: 'other@example.invalid', orgId: '22222222-2222-4222-8222-222222222222', orgName: 'Other Org', subscriptionType: 'pro' },
};
if (sub === 'status') {
  let who = null;
  try {
    who = ACCOUNTS[fs.readFileSync(mark, 'utf8').trim() || 'first'] || ACCOUNTS.first;
  } catch {
    who = null;
  }
  w(JSON.stringify(who ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', ...who } : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }) + '\n');
  process.exit(who ? 0 : 1);
}
if (sub === 'logout') {
  if (process.env.FAKE_CLAUDE_MODE === 'exit') {
    process.stderr.write('Logout failed: could not save the config file\n');
    process.exit(1);
  }
  fs.rmSync(mark, { force: true });
  w('Successfully logged out from your Anthropic account.\n');
  process.exit(0);
}
const hint = rest[0] === '--email' && rest[1] ? `&login_hint=${encodeURIComponent(rest[1])}` : '';
if (process.env.FAKE_CLAUDE_ENV_FILE) {
  const keys = Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|HOPRIG_PROFILE$|HOPRIG_RUN_FILE$)/.test(k));
  fs.writeFileSync(process.env.FAKE_CLAUDE_ENV_FILE, JSON.stringify({ keys, browser: process.env.BROWSER || null, configDir: process.env.CLAUDE_CONFIG_DIR, args: rest }));
}
const mode = process.env.FAKE_CLAUDE_MODE || 'normal';
if (mode === 'exit') {
  w('Error: something went wrong\r\n');
  process.exit(1);
}
const signedIn = (who = 'first') => {
  fs.writeFileSync(mark, who);
  w('Login successful.\r\n');
  setTimeout(() => process.exit(0), 100);
};
const link = (redirect) => `https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=${encodeURIComponent(redirect)}&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=abcDEF123&code_challenge_method=S256&state=st4te789${hint}`;
const callback = http.createServer((req, res) => {
  if (!req.url.startsWith('/callback?code=')) return res.writeHead(404).end();
  res.end('signed in');
  signedIn(req.url.startsWith('/callback?code=other') ? 'other' : 'first');
});
callback.listen(0, '127.0.0.1', () => {
  const local = link(`http://localhost:${callback.address().port}/callback`);
  if (process.env.BROWSER) spawn(process.env.BROWSER, [local], { stdio: 'ignore' }).on('error', () => {});
  w('Opening browser to sign in…\r\n');
  if (mode === 'nolink') return;
  const url = link('https://platform.claude.com/oauth/code/callback');
  w(`If the browser didn't open, visit: \x1b]8;;${url}\x07\x1b[94m${url}\x1b[39m\x1b]8;;\x07\r\n`);
  w('Paste code here if prompted > ');
});
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  const i = buf.search(/[\r\n]/);
  if (i < 0) return;
  const line = buf.slice(0, i).trim();
  buf = '';
  const [code, state] = line.split('#');
  if (!code || !state) return void w('Invalid code. Please make sure the full code was copied.\r\n');
  if (code === 'good' || code === 'other') return signedIn(code === 'other' ? 'other' : 'first');
  w('Login failed: Request failed with status code 400\r\n');
  setTimeout(() => process.exit(1), 50);
});
