import assert from 'node:assert/strict';
import test from 'node:test';
import { SchemaError, anyJson, arr, bool, int, obj, ref, str, validate } from '../../src/assistant/schema.mjs';
import { EAGER_TOOLS, MCP_TOOLS, TOOLS } from '../../src/assistant/tools.mjs';

const fails = (schema, v, re) => assert.throws(() => validate(schema, v), (e) => e instanceof SchemaError && re.test(e.message));

test('obj: unknown keys are refused, required keys enforced, missing optional keys stay absent', () => {
  const s = obj({ a: str(), b: int() }, { required: ['a'] });
  assert.deepEqual(validate(s, { a: 'x' }).value, { a: 'x' });
  fails(s, { a: 'x', c: 1 }, /unknown field "c"/);
  fails(s, {}, /a: is required/);
  fails(s, [], /must be an object/);
  fails(s, null, /must be an object/);
  fails(s, 'a', /must be an object/);
});

test('types are never coerced', () => {
  fails(obj({ n: int() }), { n: '5' }, /whole number/);
  fails(obj({ n: int() }), { n: 1.5 }, /whole number/);
  fails(obj({ n: int({ min: 2, max: 3 }) }), { n: 4 }, /from 2 to 3/);
  fails(obj({ b: bool() }), { b: 'true' }, /true or false/);
  fails(obj({ s: str() }), { s: 5 }, /must be a string/);
  fails(obj({ l: arr(str()) }), { l: 'x' }, /must be a list/);
});

test('strings: empty, too long, NUL, one line, pattern, enum', () => {
  fails(obj({ s: str() }), { s: '' }, /must not be empty/);
  fails(obj({ s: str({ max: 3 }) }), { s: 'abcd' }, /at most 3/);
  fails(obj({ s: str() }), { s: 'a\0b' }, /NUL/);
  fails(obj({ s: str({ oneLine: true }) }), { s: 'a\nb' }, /one line/);
  fails(obj({ s: str({ pattern: /^[a-z]+$/ }) }), { s: 'A' }, /wrong form/);
  fails(obj({ s: str({ enum: ['x', 'y'] }) }), { s: 'z' }, /one of: x, y/);
});

test('lists: size and uniqueness', () => {
  fails(obj({ l: arr(str(), { min: 1 }) }), { l: [] }, /1 to 20/);
  fails(obj({ l: arr(str(), { unique: true }) }), { l: ['a', 'a'] }, /repeat/);
  fails(obj({ l: arr(int()) }), { l: [1, 'x'] }, /l\[1\]/);
});

test('ref collects shown-id references with their kind', () => {
  const s = obj({ session: ref('session', str()), list: arr(ref('process', int())) });
  const { refs } = validate(s, { session: 'a', list: [3, 4] });
  assert.deepEqual(refs.map((r) => [r.kind, r.value]), [['session', 'a'], ['process', 3], ['process', 4]]);
});

test('anyJson: needs a value, refuses huge ones, returns a copy', () => {
  const s = obj({ v: anyJson() }, { required: ['v'] });
  const orig = { a: [1] };
  const out = validate(s, { v: orig }).value.v;
  assert.deepEqual(out, orig);
  assert.notEqual(out, orig);
  fails(s, { v: 'x'.repeat(20_000) }, /too large/);
});

test('every tool schema is strict all the way down and refuses an unknown key', () => {
  const strict = (j, where) => {
    // The fields of an act (args of look, do_act, plan_acts) are checked by the server against that act's own strict schema.
    if (where.endsWith('.args')) return;
    if (j.type === 'object') {
      assert.equal(j.additionalProperties, false, `${where} must forbid extra keys`);
      for (const [k, v] of Object.entries(j.properties)) strict(v, `${where}.${k}`);
    }
    if (j.type === 'array') strict(j.items, `${where}[]`);
  };
  for (const t of [...TOOLS, ...EAGER_TOOLS]) {
    strict(t.input.json, t.name);
    assert.throws(() => validate(t.input, { __proto_pollution: 1 }), /unknown field/, t.name);
  }
  assert.equal(MCP_TOOLS.length, EAGER_TOOLS.length);
});
