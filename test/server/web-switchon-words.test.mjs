// One name for one action: Get started's skills step, the Skills page and the AI brain page's skills line say Switch
// on, and the sheet they open says Switch on too, with one plain line first and the links folded under "What exactly".
// The AI brain page's own Coding tools part keeps Link (its own word for the whole plan).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import '../chat/fakedom.mjs';

const { linkSheetWords } = await import('../../web/brainlink.js');
const read = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');
const entries = [{ id: 'skills', tool: 'claude', tools: ['claude'], what: 'your skills' }, { id: 'opencode:rules', tool: 'opencode', tools: ['opencode'], what: 'rules' }];

test('the sheet opened by Switch on is called Switch on, says first what it does, and names no path on top', () => {
  const w = linkSheetWords(entries, true);
  assert.equal(w.title, 'Switch on your stored skills');
  assert.equal(w.button, 'Switch on');
  assert.equal(w.lead, 'Claude Code and OpenCode then use the skills, rules and memory kept in your AI brain, on this computer. Nothing is deleted.');
  assert.doesNotMatch(`${w.title} ${w.lead}`, /\blink|~\/|\.claude/i);
  assert.equal(linkSheetWords(entries, false).button, 'Link', 'the AI brain page keeps its Link');
  const src = read('brainlink.js');
  assert.match(src, /fold\('link-what', 'What exactly', \.\.\.what\)/, 'the links folded');
});

test('every button that opens it for the stored skills says Switch on, and nothing says Link now', () => {
  assert.match(read('getstarted.js'), /linkBrainSheet\(after, \{ prefix: '~', switchOn: true \}\)/);
  assert.match(read('brainlink.js'), /label: switchOn \? 'Switch on' : 'Link', onclick: async \(\) => \{\n\s+if \(await linkBrainSheet\(\(\) => \{\}, \{ prefix, switchOn \}\)\)/);
  assert.match(read('skillhub.js'), /linkBrainNote\(\{ only: \['skills'\], [^\n]*switchOn: true \}\)/, 'Skills says Switch on');
  assert.match(read('brain.js'), /label: 'Switch on', onclick: async \(\) => \{\n\s+if \(await linkBrainSheet\(\(\) => \{\}, \{ switchOn: true \}\)\)/);
  for (const f of ['getstarted.js', 'brainlink.js', 'brain.js', 'skilllearned.js', 'skillhub.js']) {
    assert.doesNotMatch(read(f).replace(/^\s*(\/\/|\*).*$/gm, ''), /Link now/, f);
  }
  assert.match(read('skilllearned.js'), /once you press Switch on, above\./);
});
