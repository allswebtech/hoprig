// The comments of Tia's money code name the limit as the page does: "the daily limit for paid use", then "that limit",
// never "the cap" (the identifiers and codes such as CAP_PART, capOf and "cap-reached" keep their names).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (f) => fs.readFileSync(new URL(`../../src/${f}`, import.meta.url), 'utf8');
const readWeb = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');
// The comment text of a file: its // lines and its /** … */ lines, one string each, and the comment after code on a line
// (" // …").
const comments = (s) =>
  s.split('\n').map((l) => l.trim()).flatMap((l) => {
    if (l.startsWith('//') || l.startsWith('*') || l.startsWith('/**')) return [l];
    const i = l.indexOf(' // ');
    return i >= 0 ? [l.slice(i + 1)] : [];
  });

test('money.mjs, look.mjs and feature.mjs say "daily limit for paid use" in their comments, never "the cap"', () => {
  const money = read('operator/money.mjs');
  const look = read('operator/look.mjs');
  const feature = read('assistant/feature.mjs');
  assert.ok(money.includes('/** The id of the field of the daily limit for paid use in Settings → Tia, and the address that opens the page at it'), 'money: the field');
  assert.ok(money.includes("/** Whether one more paid act fits today's daily limit for paid use, read without writing:"), 'money: room');
  assert.ok(money.includes('written at once when the daily limit for paid use has room (→ null)'), 'money: hold');
  assert.ok(money.includes('the level and the daily\n * limit for paid use as resolveTia gives them.'), 'money: mayCall');
  assert.ok(look.includes('// The daily limit for paid use has no room: nothing was started or spent'), 'look: no room');
  assert.ok(look.includes("// A paid look's budget is what was handed out of the daily limit for paid use: the most it can spend"), 'look: budget');
  assert.ok(look.includes('the budget handed out of the daily limit for paid use may be more).'), 'look: settle');
  assert.ok(feature.includes('The code follows the reason, not the daily\n * limit for paid use: a busy spending record is "busy" (no button: that limit may have room), no limit set is\n * "paid-no-cap", and only a limit without room is "cap-reached".'), 'feature: paidNotice');
  assert.ok(feature.includes("what is left of today's daily limit for paid use (the coding tool stops it there)"), 'feature: a paid turn');
  assert.ok(feature.includes('the daily limit for paid use he set and what was spent against it today'), 'feature: the overview');
  // Every file of src/chat/ too: a part's chat is billed against that limit (chat/feature.mjs settles its holds).
  const chatFiles = fs.readdirSync(new URL('../../src/chat/', import.meta.url)).filter((f) => f.endsWith('.mjs')).sort();
  assert.ok(chatFiles.includes('feature.mjs') && chatFiles.includes('queue.mjs'), 'the chat files are read');
  const chat = chatFiles.map((f) => [`chat/${f}`, read(`chat/${f}`)]);
  for (const [name, s] of [['money.mjs', money], ['look.mjs', look], ['feature.mjs', feature], ['spend.mjs', read('assistant/spend.mjs')], ['tia.js', readWeb('tia.js')], ...chat]) {
    for (const c of comments(s)) assert.doesNotMatch(c, /\b(?:the|today's|daily|a) cap(?:'s)?\b/i, `${name}: "${c}"`);
  }
});
