// The Tia use cases, held to what "Automatic" does (src/assistant/tia.mjs) and to the one name of her limit: she thinks
// on a subscription that can answer, never moves to a paid provider by herself, and the limit is "daily limit for paid use".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');
const TELL = 'site/content/use-cases/tell-the-assistant.md';

test('Automatic is the first subscription that can answer; at every limit she does not move to a paid provider', () => {
  const tia = read('src/assistant/tia.mjs');
  assert.match(tia, /const runsOn = chosen \|\| \(firstFree \? firstFree\.name : subs\.length \? null/);
  assert.match(read('web/tia.js'), /`Automatic \(now: \$\{/);
  assert.match(read('src/assistant/feature.mjs'), /Tia does not move to a paid provider by herself|does not move to a paid provider/);
  const page = flat(read(TELL));
  assert.doesNotMatch(page, /It costs money: every message to her is a request to that provider\./);
  assert.match(page, /choose what \*\*Tia runs on\*\* \(at first \*\*Automatic\*\*: the first subscription of yours that can answer now, so she simply answers\)/);
  assert.match(page, /With a Claude subscription she thinks on it, inside your plan; when every subscription is at its limit she says so with the time and does not move to a paid provider by herself\. Without a subscription every message to her is a paid request\./);
});

test('one name for her limit on the AI team and What needs you pages; her thinking on a subscription is inside the plan', () => {
  const team = flat(read('site/content/use-cases/ai-team.md'));
  const needs = flat(read('site/content/use-cases/what-needs-you.md'));
  for (const [name, page] of [['ai-team', team], ['what-needs-you', needs]]) assert.doesNotMatch(page, /spending cap|that cap\b/i, name);
  assert.match(team, /Within a daily limit for paid use you set in Settings → Tia \(none at first\)/);
  assert.doesNotMatch(team, /Her own thinking runs on a provider you choose, so she costs money\./);
  assert.doesNotMatch(team, /without one, each message to her is a paid request\./);
  assert.ok(team.includes('Her own thinking runs on the provider set under **Tia runs on**: left at **Automatic**, the first of the subscriptions she may use that can answer now, inside your plan. With no such subscription she runs on Auto mode or another provider you ticked for her, and on a provider billed by use she answers only within the daily limit for paid use. When every subscription is at its limit she says so, and she never moves to a provider billed by use by herself.'), 'what Tia thinks on');
  // The code it says: the label, Automatic, the first free ticked subscription, else Auto mode or a ticked one, paid only in the limit.
  const tiaPage = read('web/tia.js');
  assert.ok(tiaPage.includes('field(`${NAME} runs on`, runs, v.help.runsOn)') && tiaPage.includes('`Automatic (now: ${'), 'the label and Automatic');
  const tia = read('src/assistant/tia.mjs');
  assert.ok(tia.includes("p.paid !== true && p.signedIn !== false && servesTool(p, 'claude') && allowed.includes(p.name)"), 'a subscription she may use');
  assert.ok(tia.includes("const runsOn = chosen || (firstFree ? firstFree.name : subs.length ? null\n    : autoOn && allowed.includes('auto') ? 'auto' : allowed.find((n) => thinks.includes(n)) || null);"), 'else Auto mode or a ticked provider; never a paid one when subscriptions are at their limit');
  assert.ok(read('src/assistant/feature.mjs').includes('you have not set a daily limit for paid use yet.'), 'paid thinking only within the limit');
  assert.match(needs, /only within her daily limit for paid use \(Settings → Tia\), which counts each of them\./);
});

test('the night-work page: her thinking on a subscription is inside the plan, paid only without one', () => {
  const page = flat(read('site/content/use-cases/work-while-you-sleep.md'));
  assert.doesNotMatch(page, /and her own thinking costs money\./);
  assert.match(page, /Her own thinking runs at first on a Claude subscription of yours that can answer, inside your plan; without one, each message to her costs money\./);
});

test('one name for her limit on the Tia page: daily limit for paid use', () => {
  const page = flat(read(TELL));
  assert.doesNotMatch(page, /spending cap/i);
  assert.match(page, /\*\*Daily limit for paid use \(US \$\)\*\* you set in Settings → Tia/);
  assert.match(page, /within her daily limit for paid use \(Settings → Tia\)/);
});
