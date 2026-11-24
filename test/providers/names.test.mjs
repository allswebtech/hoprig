// The model names Claude Code can send through a profile (src/providers/names.mjs): read from the tool's own data,
// renamed by the profile's map, each name sent once. Made-up gateway names ("relay-…") beside the tool's public ones.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPlan } from '../../src/providers/check.mjs';
import { ALIASES, FALLBACKS, TOOL_VERSION, isSmall, namesFor, pictureModel, toolNames } from '../../src/providers/names.mjs';
import { sessionMap } from '../../src/providers/sessionmap.mjs';
import { sandbox } from '../server/helpers.mjs';

// Folders of its own: the check reads the installed Claude Code and the owner's modelOverrides, and another test file
// that runs at the same time writes both into the runner's shared folders.
const box = sandbox('providers-names');
test.after(() => box.cleanup());

// The map a session of `p` gets from a Claude Code that takes it.
const mapOf = (p) => sessionMap({ kind: 'api', mapSessions: true, ...p }, { own: {} }); // the switch on

test('the data names its tool version and holds every alias and every name it falls back to', () => {
  assert.match(TOOL_VERSION, /^\d+\.\d+\.\d+$/);
  for (const n of Object.values(ALIASES)) assert.ok(toolNames().includes(n), n);
  // The fallback seen on the night of the "Ambiguous model": the newest opus falls back to the one before it.
  assert.deepEqual(FALLBACKS[0].slice(0, 2), ['claude-opus-5-5', 'claude-opus-5']);
  assert.ok(toolNames().includes('claude-opus-4-8'));
  // Each chain is followed to its end in the tool's model data (fallback_3p of 2.1.328).
  assert.deepEqual(FALLBACKS[0].slice(-3), ['claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-1']);
  assert.deepEqual(FALLBACKS.find((c) => c[0] === 'claude-sonnet-5-5').slice(-2), ['claude-sonnet-4-5', 'claude-sonnet-4-0']);
  assert.equal(new Set(toolNames()).size, toolNames().length);
});

test('a profile without a map is asked every name the tool can send', () => {
  const rows = namesFor({ env: {}, models: '' });
  assert.deepEqual(rows.map((r) => r.sends), toolNames());
  assert.equal(rows.find((r) => r.sends === 'claude-opus-5').why, 'what claude-opus-5-5 falls back to');
  assert.equal(rows.find((r) => r.sends === 'claude-opus-5-5').why, 'what "opus" means today');
});

test("the session's map renames each name, and a name sent twice is asked once with every name that sends it", () => {
  const p = { env: {}, models: 'claude-opus-*=relay-large,claude-fable-*=relay-large' };
  const rows = namesFor(p, mapOf(p));
  const sends = rows.map((r) => r.sends);
  assert.equal(sends.filter((s) => s === 'relay-large').length, 1);
  assert.ok(!sends.some((s) => /^claude-(opus|fable)-/.test(s)));
  assert.ok(sends.includes('claude-sonnet-5-5'));
  assert.ok(rows.find((r) => r.sends === 'relay-large').also.includes('claude-opus-5'));
  const all = { env: {}, models: '*=relay-large' };
  assert.equal(namesFor(all, mapOf(all)).length, 1);
  // Without the map (a Claude Code that does not take it), the names go out as the tool sends them.
  assert.deepEqual(namesFor(p).map((r) => r.sends), toolNames());
});

test('the profile that save makes with a model and a small model is asked both, as a session sends them', () => {
  // MODELS=*=<model> with ANTHROPIC_MODEL and ANTHROPIC_DEFAULT_HAIKU_MODEL (Providers -> save, a gateway from
  // another computer): a session sends the small model as the profile names it, untouched by MODELS.
  // The switch on: with it off the map is not applied, and the large names go out as Claude Code chooses them.
  const p = { name: 'relay-a', kind: 'api', models: '*=relay-large', mapSessions: true, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/r', ANTHROPIC_API_KEY: 'made-up-key-0000', ANTHROPIC_MODEL: 'relay-large', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'relay-small' } };
  const off = checkPlan({ ...p, mapSessions: false }, { version: TOOL_VERSION });
  assert.ok(off.names.some((r) => r.sends === 'claude-opus-5'), 'switch off: the plain names are asked');
  const plan = checkPlan(p, { version: TOOL_VERSION });
  assert.deepEqual(plan.names.map((r) => r.sends), ['relay-large', 'relay-small']);
  assert.equal(plan.names[1].why, "the profile's ANTHROPIC_DEFAULT_HAIKU_MODEL");
  assert.ok(plan.names[1].also.includes('claude-haiku-4-5'), 'the small model\'s names go out as the profile\'s small model');
  assert.equal(plan.count, 3);
  assert.equal(plan.picture, 'relay-large');
});

test("the profile's own model comes first, and the picture goes to it after the map", () => {
  const p = { env: { ANTHROPIC_MODEL: 'relay-large' }, models: '' };
  assert.deepEqual(namesFor(p)[0], { asks: 'relay-large', also: ['relay-large'], why: "the profile's ANTHROPIC_MODEL", sends: 'relay-large' });
  assert.equal(pictureModel(p), 'relay-large');
  const v = { env: {}, models: 'claude-opus-5-5=relay-vision' };
  assert.equal(pictureModel(v, mapOf(v)), 'relay-vision');
  assert.equal(pictureModel({ env: {} }), ALIASES.opus);
});

test('the small model is told by its name', () => {
  assert.ok(isSmall('claude-haiku-4-5') && isSmall('claude-haiku-4-5-20251001') && isSmall('haiku'));
  assert.ok(!isSmall('claude-opus-5-5') && !isSmall('relay-small'));
});
