// The last line before a tool result reaches the model: secret shapes in every part of the text, read_session and
// read_chat included. Every token here is made up.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore, render } from '../../src/assistant/core.mjs';
import { maskShapes } from '../../src/assistant/fence.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { errorText } from '../../src/assistant/toolkit.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GH = 'ghp_' + 'madeupmadeupmadeupmadeup0123';
const ANT = 'sk-ant-api03-' + 'MADEUPKEYabcdefgh1234';

test('maskShapes masks the shapes only, so JSON stays JSON', () => {
  assert.equal(maskShapes(`a ${GH} b`), 'a *** b');
  assert.equal(maskShapes('{"n":"MAX_TOKENS=200000"}'), '{"n":"MAX_TOKENS=200000"}');
});

test('render masks the summary and every part, whatever an earlier step let through', () => {
  const out = render({ summary: `Found ${ANT} in a note.`, output: { text: `x ${GH}` } }, 'list_sessions');
  assert.ok(!out.includes('MADEUPKEY') && !out.includes('madeupmadeup'), out);
});

test('an error text masks a key too', () => {
  assert.ok(!errorText(`the route said ${GH}`, `try ${ANT}`).includes('madeup'));
});

test('read_session over a screen holding a token returns it masked', async () => {
  const s = baseState();
  s.assistant = { ...s.assistant, enabled: true, level: 'work' };
  const name = s.sessions[0].name;
  s.screens = { ...s.screens, [`this|${name}`]: `$ env\nGITHUB=${GH}\nplain line\n` };
  const core = createAssistantCore({
    ops: new FakeOps(s), now: Date.now, cards: new CardStore({ now: Date.now }), audit: new AuditLog({ file: null, now: Date.now }),
    jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [{ dir: path.join(HERE, '..', '..', 'skills'), source: 'built-in' }] }),
  });
  await core.call('list_sessions', {}, { conversation: 'c1' });
  const r = await core.call('read_session', { session: name }, { conversation: 'c1' });
  assert.ok(!r.isError, r.text);
  assert.ok(r.text.includes('plain line'));
  assert.ok(!r.text.includes('madeupmadeup'), r.text);
});
