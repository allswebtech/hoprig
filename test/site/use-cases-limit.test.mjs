// The use case "usage limit", held to the limit cards it describes (web/lib.js limitBox, web/chat/limit.js): one main
// button, the other ways folded away, and the words every paid way carries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');
const PAGE = 'site/content/use-cases/usage-limit.md';

test('the limit card offers one main button, the other ways folded, and a paid way says it costs money per use', () => {
  const lib = read('web/lib.js');
  const chat = read('web/chat/limit.js');
  assert.match(lib, /: `Continue on \$\{p\.label\}\$\{cost\(p\)\}`\);/, 'a session\'s way is "Continue on <provider>"');
  assert.match(lib, /const main = free\.find\(\(p\) => !isPaid\(p\)\) \|\| null;/, 'the main way is never a paid one');
  assert.match(lib, /'Other ways', icon\('chevronDown'/, 'the others are under Other ways');
  assert.match(lib, /isPaid\(p\) \? ' · costs money per use' : ''/);
  assert.match(chat, /label: 'Move to another provider', icon: 'swap', primary: true/, 'a chat\'s main button');
  const page = flat(read(PAGE));
  assert.doesNotMatch(page, /says so and shows your other providers as buttons\./);
  assert.match(page, /offers one main button: in a session, \*\*Continue on\*\* the first provider of yours that has room and costs nothing extra; in a chat, \*\*Move to another provider\*\*\. A session's other providers are under \*\*Other ways\*\*, and a provider paid per use says "costs money per use"\./);
});

test('a provider is a subscription, an API key or a gateway; Hoprig keeps each in a settings file only you can read', () => {
  const profiles = read('src/profiles.mjs');
  assert.match(profiles, /fs\.writeFileSync\(tmp, lines\.join\('\\n'\) \+ '\\n', \{ mode: 0o600 \}\);/, 'the file is the owner\'s alone');
  const page = flat(read(PAGE));
  assert.doesNotMatch(page, /A provider is a small file of settings/);
  assert.match(page, /`hop add` adds a provider: another Claude subscription, an API key or a gateway \(a service that passes your requests on to an AI and bills you for each use\)\. Hoprig keeps each one in a small settings file that only you can read\./);
});

test('Auto mode\'s order names "sub" as the Claude login and says to put your own API key\'s name in place of "api"', () => {
  assert.match(read('src/setup/checks.mjs'), /the first start creates "sub" for your login/);
  assert.match(read('src/addons/cli.mjs'), /hoprig auto order <your provider> \$\{name\}/);
  const page = flat(read(PAGE));
  assert.match(page, /`hop auto order sub api` \(sub is your Claude login; put the name you gave your API key in `hop add` in place of api\), then `hop auto on`\./);
});
