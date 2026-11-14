// sixpanel.json against SixPanel's own schema.
//
// Fixture: test/setup/fixtures/sixpanel.schema.json, fetched from
// https://installer.allsweb.net/sixpanel/sixpanel.schema.json on 14 Nov 2026 (HTTP 200, 43382 bytes, draft 2020-12).
// The validator below covers exactly the keywords that schema uses (checked by the first test), so no dependency.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const schema = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'sixpanel.schema.json'), 'utf8'));
const file = JSON.parse(fs.readFileSync(path.join(root, 'sixpanel.json'), 'utf8'));

const SUPPORTED = new Set(['$id', '$schema', 'title', 'description', 'default', 'examples', 'type', 'enum', 'const', 'properties', 'additionalProperties',
  'required', 'pattern', 'minimum', 'maximum', 'maxLength', 'items', 'maxItems', 'minItems', 'uniqueItems', 'oneOf', 'propertyNames', 'maxProperties']);

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const isType = (v, t) => (t === 'number' ? typeof v === 'number' : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t);

/** Errors of `v` against schema `s`, as "path: problem" strings. */
function validate(s, v, at = '$') {
  const errs = [];
  if (s === true || s === undefined) return errs;
  if (s === false) return [`${at}: not allowed`];
  if (s.type && ![].concat(s.type).some((t) => isType(v, t))) return [`${at}: should be ${[].concat(s.type).join('|')}`];
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(v)) errs.push(`${at}: should be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errs.push(`${at}: should be one of ${JSON.stringify(s.enum)}`);
  if (typeof v === 'string') {
    if (s.maxLength !== undefined && [...v].length > s.maxLength) errs.push(`${at}: longer than ${s.maxLength}`);
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) errs.push(`${at}: does not match ${s.pattern}`);
  }
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) errs.push(`${at}: below ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) errs.push(`${at}: above ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (s.maxItems !== undefined && v.length > s.maxItems) errs.push(`${at}: more than ${s.maxItems} items`);
    if (s.minItems !== undefined && v.length < s.minItems) errs.push(`${at}: fewer than ${s.minItems} items`);
    if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errs.push(`${at}: items not unique`);
    if (s.items) v.forEach((x, i) => errs.push(...validate(s.items, x, `${at}[${i}]`)));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const r of s.required || []) if (!(r in v)) errs.push(`${at}: missing ${r}`);
    if (s.maxProperties !== undefined && Object.keys(v).length > s.maxProperties) errs.push(`${at}: more than ${s.maxProperties} properties`);
    for (const [k, x] of Object.entries(v)) {
      if (s.propertyNames) errs.push(...validate(s.propertyNames, k, `${at} key ${k}`));
      if (s.properties && k in s.properties) errs.push(...validate(s.properties[k], x, `${at}.${k}`));
      else if (s.additionalProperties !== undefined) errs.push(...validate(s.additionalProperties, x, `${at}.${k}`));
    }
  }
  if (s.oneOf) {
    const ok = s.oneOf.filter((o) => validate(o, v, at).length === 0).length;
    if (ok !== 1) errs.push(`${at}: matches ${ok} of oneOf, needs exactly 1`);
  }
  return errs;
}

test('the validator covers every keyword the schema uses', () => {
  const seen = new Set();
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      seen.add(k);
      if (k === 'properties') Object.values(v).forEach(walk);
      else if (!['enum', 'const', 'default', 'examples', 'required'].includes(k)) walk(v);
    }
  };
  walk(schema);
  assert.deepEqual([...seen].filter((k) => !SUPPORTED.has(k)), []);
});

test('the validator catches mistakes (so a pass means something)', () => {
  assert.notDeepEqual(validate(schema, { kind: 'node' }), [], 'version is required');
  assert.notDeepEqual(validate(schema, { ...file, node: { ...file.node, memoryMb: 64 } }), [], 'memoryMb has a minimum of 128');
  assert.notDeepEqual(validate(schema, { ...file, node: { ...file.node, processes: 0 } }), []);
  assert.notDeepEqual(validate(schema, { ...file, health: { path: 'healthz' } }), [], 'a path starts with /');
  assert.notDeepEqual(validate(schema, { ...file, kind: 'docker' }), []);
  assert.notDeepEqual(validate(schema, { ...file, env: { defaults: { HOPRIG_PASSWORD_FILE: 'x' }, extra: 1 } }), [], 'no unknown key in env');
});

test('sixpanel.json is valid against the fetched schema', () => {
  assert.deepEqual(validate(schema, file), []);
});

test('sixpanel.json runs a hub: one process, the health path, persistent data, no database, no secret', () => {
  assert.equal(file.kind, 'node');
  assert.equal(file.node.processes, 1, 'the hub holds WebSockets and sessions in its memory');
  assert.equal(file.health.path, '/healthz');
  assert.match(file.start, /^node bin\/hoprig\.mjs serve /);
  assert.match(file.build.install, /--omit=optional/, 'no terminal module, so no build tools on the server');
  assert.deepEqual(file.keep, ['data/']);
  for (const k of ['HOPRIG_CONFIG_DIR', 'HOPRIG_STATE_DIR']) assert.match(file.env.defaults[k], /^data\//);
  assert.equal(file.env.defaults.HOPRIG_HUB, '1');
  assert.equal(file.env.defaults.HOPRIG_PUBLIC_URL, '${SITE_URL}');
  assert.equal(file.databases, undefined);
  assert.doesNotMatch(JSON.stringify(file.env), /PASSWORD|SECRET|TOKEN|KEY"/, 'secret-looking names are refused in defaults');
  assert.ok(file.node.memoryMb >= 128);
});

test('HOPRIG_PUBLIC_URL: trusted proxy, allowed origin and links for an https address only', async () => {
  const { publicUrlSettings } = await import('../../src/server/serveopts.mjs');
  assert.deepEqual(publicUrlSettings('https://hub.example.com', {}), { trustProxy: true, allowedOrigins: ['https://hub.example.com'], publicUrl: 'https://hub.example.com/' });
  assert.deepEqual(publicUrlSettings('https://hub.example.com/some/path', { allowedOrigins: ['https://a.example'] }).allowedOrigins, ['https://a.example', 'https://hub.example.com']);
  assert.equal(publicUrlSettings('https://hub.example.com', { trustProxy: true, publicUrl: 'https://hub.example.com/', allowedOrigins: ['https://hub.example.com'] }), null, 'already set');
  assert.equal(publicUrlSettings('http://hub.example.com', {}), null);
  assert.equal(publicUrlSettings('${SITE_URL}', {}), null, 'an unfilled placeholder is ignored');
});
