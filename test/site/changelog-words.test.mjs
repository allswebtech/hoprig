// The unreleased block of the changelog (site/content/changelog.md, from "## 0.3.4") and the released 0.3.3 block
// after it (to the next "## "), read as one text, so a term first used in the new block is said there, are read by
// people who are not programmers. A term of Hoprig's own is said once in plain words where it first stands, and the
// block holds nothing private and promises nothing: no word of a paid version, no "soon", one name for Tia's limit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const text = fs.readFileSync(path.join(ROOT, 'site/content/changelog.md'), 'utf8').replace(/\r\n?/g, '\n');
const at = text.indexOf('\n## 0.3.4 ');
const mid = text.indexOf('\n## ', at + 1);
assert.ok(at >= 0 && text.startsWith('\n## 0.3.3 (24 November 2026)\n', mid), 'the unreleased block, then the released 0.3.3');
const block = text.slice(at, text.indexOf('\n## ', mid + 1));

/** Each term, and the plain words that say what it is, close after the place where it first stands. */
const PLAIN = {
  'AI brain': 'the folder with the rules, skills and memory your coding tools share',
  'Auto mode': "Hoprig's way of moving a session to the next provider, the next AI account, when one reaches its limit",
  upkeep: "the dashboard's own round over your workspace, on a timer",
  'Bypass permissions': 'in which Claude Code runs every command without asking you',
  hook: 'the small program of Hoprig that Claude Code calls at each step of a session',
  gateway: "a program that passes a coding tool's requests on to a provider",
  tmux: 'a program that keeps terminals running when the dashboard stops',
  'the App': "the dashboard's chat view of a session",
  'state folder': 'where Hoprig keeps its own records on this computer',
  'Hands-off': "Hoprig answering a coding tool's questions for you",
};

test('a term is said in plain words where it first stands in the block', () => {
  const missing = [];
  for (const [term, words] of Object.entries(PLAIN)) {
    const first = block.indexOf(term);
    const said = block.indexOf(words);
    if (first < 0) missing.push(`"${term}" is not in the block: take it out of the list`);
    else if (said < first || said - first > 250) missing.push(`"${term}" first stands without "${words}" close after it`);
  }
  assert.deepEqual(missing, []);
});

test('the block promises nothing and names nothing private', () => {
  assert.doesNotMatch(block, /\bsoon\b|coming later|in a later version/i, 'nothing promised that is not built');
  assert.doesNotMatch(block, /paid version|\bpremium\b|\bpro plan\b|\benterprise\b/i, 'no word of a paid version');
  // One name for Tia's limit (the field "Daily limit for paid use (US $)"); the missions' own field keeps its name.
  assert.doesNotMatch(block.replace(/\*\*Spend cap per day \(\$\)\*\*/g, ''), /daily cap|spending cap|\bcap\b/i, 'the daily limit for paid use');
  // "Automatic" is her subscription now; the old meaning is said only as what it was.
  assert.match(block, /Before, Automatic was Auto mode/);
  assert.doesNotMatch(block.replace(/Before, Automatic was Auto mode/, ''), /Automatic (is|means) Auto mode/);
});
