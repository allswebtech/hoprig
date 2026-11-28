// A subscription sign-in is used by Claude Code itself and by nothing else: no module of Hoprig sends a request of its
// own with a subscription key. The one place that handles such a request is the router's pass-through of Claude Code's
// own request (src/router.mjs), and it never attaches a subscription key to a request that is not Claude Code's.
//
// The closed rules run on the SOURCE TEXT of every file under src/ and bin/ (any extension), router.mjs included:
//   1. the text of an oauth beta header value (oauth-, four digits, two, two) is in none of them, except on the one const
//      line of src/router.mjs (OAUTH_BETA); that constant is not exported and is used only to filter the value out;
//   2. a file that names the subscription token variable (CLAUDE_CODE_OAUTH_TOKEN) and also sends a network request
//      (fetch, fetchImpl, an http or https request, a socket) fails, except the short named list below, each with its reason;
//   3. no single line holds both the token name and a header word (authorization, bearer, x-api-key, anthropic-beta,
//      headers): a line that builds a header out of a subscription key;
//   4. the identifier OAUTH_BETA is in no file but src/router.mjs;
//   5. src/providers/readlimits.mjs (the Providers page's read) holds no network request of any kind: it only starts
//      Claude Code.
// The old direct call of the read (the fixture old-readlimits.txt, which is how a subscription key was once sent) and three
// more shapes of it must be refused by the rules: the fixtures prove the rules still see them.
// It does not prove that no module could build such a header out of pieces; it fails the plain ways of doing it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'subscription-guard');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const scanned = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'bin'))].map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));
const ROUTER = 'src/router.mjs';

// Files that name the token and also send a request, each with why it is not a direct call with a subscription key.
const ALLOWED_TOKEN_AND_NETWORK = {
  'src/demo/index.mjs': 'the built-in demo: its token values are made up and never leave it; its requests go to its own loopback dashboard',
  'src/server/accounts.mjs': 'the account pages: the token is only written to or deleted from a provider file; its requests are the checks of API keys and gateways, never a header with the token',
};

const noComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const BETA = /oauth-\d{4}-\d{2}-\d{2}/;
const NETWORK = [/\bfetch\w*\s*[(,)]/, /\bfetchImpl\b/, /node:https?\b/, /(?:from\s+|require\(\s*)['"](?:node:)?(?:https?|http2|net|tls|undici)['"]/, /\bhttps?\.(request|get)\b/, /\bnet\.(connect|createConnection)\b/, /\bXMLHttpRequest\b/];
const sends = (text) => NETWORK.some((re) => re.test(noComments(text)));
const CONST_LINE = /^const OAUTH_BETA = 'oauth-\d{4}-\d{2}-\d{2}';$/;

/** The rules for one file: the list of the rule numbers it breaks. */
export function breaks(rel, text, allowed = ALLOWED_TOKEN_AND_NETWORK) {
  const out = new Set();
  const lines = text.split('\n');
  const beta = lines.filter((l) => BETA.test(l));
  if (rel === ROUTER ? beta.length !== 1 || !CONST_LINE.test(beta[0]) : beta.length) out.add(1);
  if (/CLAUDE_CODE_OAUTH_TOKEN/.test(noComments(text)) && sends(text) && !(rel in allowed)) out.add(2);
  if (lines.some((l) => /CLAUDE_CODE_OAUTH_TOKEN/.test(l) && /authorization|bearer|x-api-key|anthropic-beta|headers/i.test(l))) out.add(3);
  if (rel !== ROUTER && /\bOAUTH_BETA\b/.test(text)) out.add(4);
  if (rel === ROUTER) {
    // not exported, and used only to filter the value out of the list
    const uses = lines.filter((l) => /\bOAUTH_BETA\b/.test(l) && !CONST_LINE.test(l));
    if (/export\s+(const|let|var|\{[^}]*\bOAUTH_BETA\b)/.test(text.replace(/export\s+(const|let|var|function|async function|class)\s+(?!OAUTH_BETA\b)\w+/g, '')) || uses.some((l) => !/\.filter\(\(b\) => b !== OAUTH_BETA\)/.test(l))) out.add(1);
  }
  if (rel === 'src/providers/readlimits.mjs' && sends(text)) out.add(5);
  return [...out].sort();
}

test('the closed rules hold over every file of src/ and bin/, the router included', () => {
  assert.ok(scanned.some((f) => f.rel === ROUTER) && scanned.some((f) => f.rel.startsWith('bin/')), 'the router and bin/ are scanned');
  const bad = scanned.map((f) => [f.rel, breaks(f.rel, f.text)]).filter(([, b]) => b.length);
  assert.deepEqual(bad, []);
});

test('the router holds its beta value on one const line, not exported, used only to filter it out', () => {
  const router = scanned.find((f) => f.rel === ROUTER).text;
  assert.equal(router.split('\n').filter((l) => CONST_LINE.test(l)).length, 1);
  assert.ok(!/export[^\n]*OAUTH_BETA/.test(router));
  assert.ok(router.split('\n').filter((l) => /OAUTH_BETA/.test(l) && !CONST_LINE.test(l)).length > 0, 'it is used');
});

test('every name on the allow-list is a file that needs it, and has a reason', () => {
  for (const [rel, why] of Object.entries(ALLOWED_TOKEN_AND_NETWORK)) {
    const f = scanned.find((x) => x.rel === rel);
    assert.ok(f, rel);
    assert.ok(why.length > 20, rel);
    assert.ok(/CLAUDE_CODE_OAUTH_TOKEN/.test(noComments(f.text)) && sends(f.text), `${rel} is on the list for nothing: take it off`);
  }
});

test('the rules refuse the direct call the read once made, and three more shapes of it', () => {
  const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
  const old = fixture('old-readlimits.txt');
  assert.ok(old.includes('oauth-2025-04-20'), 'the fixture is the call itself');
  assert.ok(!old.split('\n').some((l) => /CLAUDE_CODE_OAUTH_TOKEN/.test(l) && /authorization|bearer|x-api-key|anthropic-beta|headers/i.test(l)), 'the line rule alone missed it: the two-line shape');
  assert.deepEqual(breaks('src/providers/readlimits.mjs', old), [1, 2, 5]);
  assert.ok(breaks('src/anywhere.mjs', old).includes(2), 'in any file');
  assert.deepEqual(breaks('src/x/no-beta.mjs', fixture('no-beta-header.txt')), [2]);
  assert.ok(breaks('src/x/constant.mjs', fixture('beta-from-constant.txt')).includes(2));
  assert.ok(breaks('src/x/plain-import.mjs', fixture('no-prefix-import.txt')).includes(2), 'an import without node:');
  assert.ok(breaks('src/x/h2.mjs', fixture('http2-import.txt')).includes(2), 'node:http2');
  assert.ok(breaks('src/x/constant.mjs', fixture('beta-from-constant.txt')).includes(4));
  assert.ok(breaks('src/x/later.mjs', fixture('later-date.txt')).includes(1), 'a later oauth date is the same value');
  assert.ok(breaks('src/x/later.mjs', fixture('later-date.txt')).includes(2));
  const inRouter = breaks(ROUTER, fixture('call-in-router.txt'));
  assert.ok(inRouter.includes(2), `a call inside the router file is refused (${inRouter})`);
});

test('an exported beta constant, or one used for more than filtering, is refused in the router', () => {
  const router = scanned.find((f) => f.rel === ROUTER).text;
  assert.deepEqual(breaks(ROUTER, router.replace("const OAUTH_BETA", "export const OAUTH_BETA")), [1]);
  assert.deepEqual(breaks(ROUTER, `${router}\nconst sent = { 'anthropic-beta': OAUTH_BETA };\n`), [1]);
  assert.deepEqual(breaks(ROUTER, router), []);
});
