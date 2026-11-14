// The built-in catalog: every entry complete, pinned to a full commit (or bundled with this package), signals
// well-formed; and the validator refuses what is not.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PACKAGE_ROOT, loadCatalog, searchCatalog, validateCatalog } from '../../src/skillhub/catalog.mjs';
import { validSignal } from '../../src/skillhub/detect.mjs';

test('the shipped catalog is valid and complete', () => {
  const cat = loadCatalog();
  assert.deepEqual(validateCatalog(cat), []);
  assert.ok(cat.entries.length >= 10);
  for (const e of cat.entries) {
    assert.ok(e.id && e.skill && e.for && e.license && e.signals.length, e.id);
    if (e.bundled) {
      assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, e.bundled, 'SKILL.md')), e.id);
      assert.equal(e.commit, undefined);
    } else {
      assert.match(e.commit, /^[0-9a-f]{40}$/, e.id);
      assert.match(e.repo, /^[\w.-]+\/[\w.-]+$/, e.id);
    }
    for (const s of e.signals) assert.ok(validSignal(s), `${e.id}: ${s}`);
  }
  // The three repositories the owner named are in it where they are skills.
  const repos = new Set(cat.entries.map((e) => e.repo));
  for (const r of ['cloudflare/security-audit-skill', 'morluto/rea']) assert.ok(repos.has(r), r);
  assert.equal(cat.entries.find((e) => e.id === 'reverse-engineer-anything').tool.npm, 'rea-agents');
  assert.equal(cat.entries.filter((e) => e.bundled).length, 1);
});

test('the validator refuses incomplete or malformed entries', () => {
  const good = { id: 'x-skill', skill: 'x-skill', for: 'Does a useful thing well.', repo: 'o/r', path: 'skills/x', commit: 'a'.repeat(40), license: 'MIT', signals: ['npm:next'] };
  const v = (patch) => validateCatalog({ version: 1, entries: [{ ...good, ...patch }] });
  assert.deepEqual(v({}), []);
  assert.match(v({ commit: 'main' }).join(), /40-hex/);
  assert.match(v({ commit: 'abc1234' }).join(), /40-hex/);
  assert.match(v({ path: '../x' }).join(), /relative/);
  assert.match(v({ path: '/abs' }).join(), /relative/);
  assert.match(v({ signals: ['stack:spaceship'] }).join(), /bad signal/);
  assert.match(v({ signals: ['npm next'] }).join(), /bad signal/);
  assert.match(v({ signals: [] }).join(), /at least one/);
  assert.match(v({ license: '' }).join(), /license/);
  assert.match(v({ repo: 'not a repo' }).join(), /owner\/repo/);
  assert.match(v({ skill: 'Bad--Name' }).join(), /skill/);
  assert.match(v({ bundled: 'templates/skills/hoprig' }).join(), /no repo, path or commit/);
  assert.match(validateCatalog({ version: 1, entries: [good, good] }).join(), /duplicate/);
  assert.match(validateCatalog({ version: 1, entries: [{ id: 'b', skill: 'b', for: 'Bundled but missing.', bundled: 'nowhere/at-all', license: 'x', signals: ['always'] }] }).join(), /bundled must be/);
});

test('catalog search', () => {
  assert.equal(searchCatalog('flutter')[0].repo, 'flutter/agent-plugins');
  assert.ok(searchCatalog('security').some((e) => e.id === 'security-audit'));
  assert.deepEqual(searchCatalog(''), []);
});
