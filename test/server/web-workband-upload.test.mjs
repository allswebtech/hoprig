// Work's band and the sheet it opens name one press by one word: when only earlier copies of the list are not on the
// server yet, the band's button says Upload, as the sheet's button does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import '../chat/fakedom.mjs';

globalThis.location ||= { hash: '#/work', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.localStorage ||= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia ||= () => ({ matches: false, addEventListener() {} });
const { saveBand } = await import('../../web/work.js');

test('only earlier copies to send: the band says Upload, the word of the sheet\'s button', () => {
  const plan = { files: [], changes: [], runs: 0, plans: 0, unsent: { saves: 1, others: [] }, repo: { name: 'ai_brain', branch: 'main', upstream: 'origin/main' } };
  const band = saveBand(plan, { kind: 'brain' });
  assert.equal(band.label, 'Upload');
  const src = fs.readFileSync(new URL('../../web/work.js', import.meta.url), 'utf8');
  assert.match(src, /label: merge \? 'Bring together and upload' : !plan\.files\.length \? 'Upload' :/, 'the sheet\'s button for the same case');
});
