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
  // Bundled with Hoprig: its own skill (for the user) and the new-project skill (put into each new project).
  assert.equal(cat.entries.find((e) => e.id === 'hoprig').scope, 'user');
  assert.equal(cat.entries.find((e) => e.id === 'new-project').scope, 'project');
  // …and plan-work (the method Work's Plan with AI asks its sessions to follow), and adopt-projects (the judging part
  // of hoprig adopt: a computer that already has projects).
  assert.deepEqual(cat.entries.filter((e) => e.bundled).map((e) => e.id).sort(), ['adopt-projects', 'hoprig', 'new-project', 'plan-work']);
  assert.equal(cat.entries.find((e) => e.id === 'adopt-projects').scope, 'user');
});

test('a bundled skill says only what a skill is: its front matter holds a name and a description, nothing about where it was made', () => {
  // A skill copied in from another (private) project may carry that project's header: a comment naming it, or a
  // metadata block of its own. The package is public, so a bundled skill's front matter is the skill's alone.
  for (const e of loadCatalog().entries.filter((x) => x.bundled)) {
    const text = fs.readFileSync(path.join(PACKAGE_ROOT, e.bundled, 'SKILL.md'), 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(m, `${e.id}: front matter`);
    const lines = m[1].split('\n');
    assert.deepEqual(lines.filter((l) => /^\s*#/.test(l)), [], `${e.id}: no comment in the front matter`);
    const keys = lines.filter((l) => /^[A-Za-z]/.test(l)).map((l) => l.split(':')[0]);
    // `metadata` is a skill's own key too, for what the skill says about itself: its version and the tool of this
    // repository that made it (the generated Hoprig skill). Nothing else may be nested, and no other key under it.
    assert.deepEqual(keys.filter((k) => !['name', 'description', 'license', 'compatibility', 'allowed-tools', 'metadata'].includes(k)), [], `${e.id}: only a skill's own keys`);
    const nested = lines.filter((l) => !/^[A-Za-z]/.test(l));
    assert.deepEqual(nested.filter((l) => !/^  (version|generated-by): /.test(l)), [], `${e.id}: nothing nested but its own version and maker`);
    if (nested.length) assert.ok(keys.includes('metadata'), `${e.id}: nested lines belong to metadata`);
  }
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
